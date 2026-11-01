import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { rotateLog } from '../housekeep'
import { cacheDir, dataDir, ensureBinaries, findBinary, modelsDir, runDir } from '../paths'
import { getSettings } from '../settings'
import { catalogModel, defaultModelId } from '../models/registry'
import { bestDevice, detectGpus, llamaBinaryFor, type Backend, type GpuDevice } from '../gpu/devices'
import { planLaunch } from './tuning'
import { planPool } from './pool-budget'
import { readGgufHints } from './gguf'
import type { ServerStatus } from '../../shared/types'
import { validateGgufFile } from '../models/verify'
import { foreignBinaries } from '../bin-sync'

export interface ServerInfo {
  modelId: string
  deviceKey: string | null
  port: number
  baseUrl: string
}

/** Chiede al sistema una porta libera: nessun numero hardcoded. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

const BIND_FAILURE = /address already in use|failed to bind|permission denied/i

/** Un processo llama-server per modello: un modello = un server. */
class LlamaInstance extends EventEmitter {
  readonly modelId: string
  readonly device: GpuDevice | null
  /** contesto deciso dal pool (può essere ridotto per far convivere più modelli) */
  readonly ctxOverride?: number
  private child: ChildProcessWithoutNullStreams | null = null
  private port: number | null = null
  private logLines: string[] = []
  private starting = false
  private deviceLabel = 'sconosciuto'
  /** codice di uscita dell'ultimo tentativo (0xC0000139 = DLL sbagliata) */
  private lastExitCode: number | null = null
  /** true dopo il riallineamento di dati/bin: si riprova una sola volta */
  private repaired = false

  /**
   * Argomento per `--device`: llama.cpp accetta l'identificatore del backend
   * (`Vulkan0`, `Vulkan1`), NON il nome commerciale della scheda. I device
   * dedotti dal driver (WMI) non hanno un indice affidabile: in quel caso
   * si omette il flag e decide llama.cpp (auto).
   */
  private deviceArg(): string | null {
    if (!this.device) return null
    if ((this.device as { estimated?: boolean }).estimated) return null
    if (this.device.backend === 'vulkan') return `Vulkan${this.device.index}`
    return this.device.label
  }
  private effectiveCtx = 0
  private modelMaxCtx = 0
  private pidFile: string | null = null

  constructor(modelId: string, device: GpuDevice | null, ctxOverride?: number) {
    super()
    this.modelId = modelId
    this.device = device
    this.ctxOverride = ctxOverride
  }

  get key(): string {
    return `${this.modelId}|${this.device?.key ?? 'auto'}`
  }

  private writePidFile(pid?: number): string | null {
    if (!pid) return null
    try {
      const file = path.join(runDir(), `llama-${this.modelId}-${pid}.pid`)
      fs.writeFileSync(file, String(pid), 'utf8')
      return file
    } catch {
      return null
    }
  }

  private clearPidFile(): void {
    if (!this.pidFile) return
    try {
      fs.rmSync(this.pidFile, { force: true })
    } catch {
      /* ignore */
    }
    this.pidFile = null
  }

  status(): ServerStatus {
    return {
      modelId: this.modelId,
      running: !!this.child && !this.child.killed,
      starting: this.starting,
      port: this.port,
      device: this.deviceLabel + (this.device ? ` · ${this.device.name}` : ''),
      contextSize: this.effectiveCtx,
      modelMaxCtx: this.modelMaxCtx,
      log: this.logLines.slice(-120).join('\n')
    }
  }

  private logFile(): string {
    const dir = `${dataDir()}/log`
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
    return `${dir}/llama-server.log`
  }

  /** Chiusura immediata del processo (e dei suoi figli su Windows). */
  killNow(): void {
    const pid = this.child?.pid
    try {
      if (pid && process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
      } else if (pid) {
        this.child?.kill('SIGKILL')
      }
    } catch {
      /* ignore */
    }
    this.child = null
  }

  private push(line: string): void {
    const clean = line.replace(/\r/g, '')
    if (!clean.trim()) return
    try {
      rotateLog(this.logFile())
      fs.appendFileSync(this.logFile(), `${new Date().toISOString()} [${this.modelId}] ${clean}\n`)
    } catch {
      /* ignore */
    }
    this.logLines.push(clean)
    if (this.logLines.length > 300) this.logLines.splice(0, this.logLines.length - 300)
    if (/vulkan/i.test(clean) && /device/i.test(clean)) this.deviceLabel = 'GPU'
    this.emit('log', `[${this.modelId}] ${clean}`)
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.port = null
    this.clearPidFile()
    if (!child || child.killed) return
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true })
      } else {
        child.kill('SIGTERM')
        setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* già terminato */
          }
        }, 4000)
      }
    } catch {
      /* ignore */
    }
  }

  async start(): Promise<ServerInfo> {
    if (this.child && this.port) {
      return {
        modelId: this.modelId,
        deviceKey: this.device?.key ?? null,
        port: this.port,
        baseUrl: `http://127.0.0.1:${this.port}`
      }
    }
    if (this.starting) {
      for (let i = 0; i < 900; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        if (this.port)
          return {
            modelId: this.modelId,
            deviceKey: this.device?.key ?? null,
            port: this.port,
            baseUrl: `http://127.0.0.1:${this.port}`
          }
        if (!this.starting) break
      }
    }
    await this.stop()
    this.starting = true
    try {
      const s = getSettings()
      const backend: Backend = this.device?.backend ?? 'vulkan'
      const exe = llamaBinaryFor(backend) ?? findBinary('llama-server')
      if (!exe) throw new Error('llama-server non trovato: esegui "npm run fetch:bin" oppure copia i binari in bin/.')
      const model = catalogModel(this.modelId)
      const modelPath = path.join(modelsDir(), model.files.model.name)
      const mmprojPath = model.files.mmproj ? path.join(modelsDir(), model.files.mmproj.name) : ''
      // file troncato/corrotto: meglio un messaggio chiaro che 40 righe di log GGUF
      const modelCheck = validateGgufFile(modelPath)
      if (!modelCheck.ok) {
        throw new Error(
          `modello corrotto (${modelCheck.reason}): ${modelPath}. ` +
            'Riscaricalo da impostazioni → modelli e download.'
        )
      }
      if (mmprojPath) {
        const visionCheck = validateGgufFile(mmprojPath)
        if (!visionCheck.ok) {
          throw new Error(
            `mmproj corrotto (${visionCheck.reason}): ${mmprojPath}. ` +
              'Riscaricalo da impostazioni → modelli e download.'
          )
        }
      }
      const plan = planLaunch({
        device: this.device,
        contextSize: this.ctxOverride ?? s.contextSize,
        kvPreference: s.kvCacheType,
        gpuLayers: s.gpuLayers,
        modelPath,
        mmprojPath: mmprojPath || undefined,
        autoTune: s.autoTune
      })
      this.effectiveCtx = plan.ctx
      this.modelMaxCtx = readGgufHints(modelPath).contextLength
      for (const note of plan.notes) this.push(`[tuning] ${note}`)
      this.push(
        `[tuning] ctx=${plan.ctx} kv=${plan.kvType} ngl=${plan.ngl} ubatch=${plan.ubatch} ` +
          `mmproj=${plan.mmprojOffload ? 'GPU' : 'CPU'} stima=${plan.estimate.totalMiB}MiB / ${plan.estimate.availableMiB}MiB`
      )

      let lastError: Error | null = null
      for (let attempt = 1; attempt <= 5; attempt++) {
        const port = await freePort()
        // la VRAM dedotta dal driver può essere troncata a 4 GiB: non deve
        // schiacciare il contesto a 2048, altrimenti l'utente vede "2k" nell'header
        if ((this.device as { estimated?: boolean } | null)?.estimated) {
          const wanted = this.ctxOverride ?? getSettings().contextSize
          if (plan.ctx < wanted) {
            plan.ctx = wanted
            this.push(
              `[tuning] VRAM stimata: contesto mantenuto a ${plan.ctx} (l'offload lo decide llama.cpp)`
            )
          }
        }

        const args = [
          '-m', modelPath,
          ...(() => {
            const dev = this.deviceArg()
            return dev ? ['--device', dev] : []
          })(),
          ...(mmprojPath ? ['--mmproj', mmprojPath] : []),
          // +1024 di slack: il conteggio lato app è una stima, il server non deve mai rifiutare
          '-c', String(plan.ctx + 1024),
          ...(plan.autoFit ? [] : ['-ngl', String(plan.ngl)]),
          '-b', String(plan.batch),
          '-ub', String(plan.ubatch),
          '-np', '1',
          '--host', '127.0.0.1',
          '--port', String(port),
          '--jinja',
          '--no-webui',
          // reasoning sempre attivo quando il template lo supporta: viene mostrato
          // nell'interfaccia in un blocco richiudibile, non disattivato.
          // raccomandato da llama.cpp per i modelli Qwen-VL (grounding)
          '--image-min-tokens', '1024',
          '-fa', s.flashAttention ? 'on' : 'off',
          '-ctk', plan.kvType,
          '-ctv', plan.kvType,
          ...(plan.mmprojOffload ? [] : ['--no-mmproj-offload']),
          '--media-path', cacheDir(),
          '--video-ffmpeg-dir', path.dirname(exe),
          '--threads', String(plan.threads)
        ]
        this.logLines = []
        this.lastExitCode = null
        this.push(
          `avvio (v${app.getVersion()}, tentativo ${attempt}, porta ${port}) -c ${plan.ctx} ` +
            (plan.autoFit ? '-ngl auto (fit di llama.cpp) ' : `-ngl ${plan.ngl} `) +
            (this.device ? ` --device ${this.device.label} (${this.device.name})` : ' --device auto')
        )
        const child = spawn(exe, args, { windowsHide: true, cwd: path.dirname(exe) })
        this.child = child
        this.port = port
        this.pidFile = this.writePidFile(child.pid)
        const onData = (buf: Buffer): void => {
          for (const line of buf.toString('utf8').split('\n')) this.push(line)
        }
        child.stdout.on('data', onData)
        child.stderr.on('data', onData)
        child.on('exit', (code, signal) => {
          this.lastExitCode = code
          this.push(`[server terminato, codice ${code}, segnale ${signal ?? 'nessuno'}]`)
          // 0xC0000139 = STATUS_ENTRYPOINT_NOT_FOUND: quasi sempre una DLL del backend
          // mancante o di versione diversa accanto all'exe. Elenchiamo cosa c'è davvero.
          if (code === 3221225785 || code === -1073741515) {
            try {
              const dir = path.dirname(exe)
              const names = fs.readdirSync(dir)
              const foreign = foreignBinaries(names)
              this.push(
                `[dll] entrypoint non trovato (0xC0000139) in ${dir}: ${names.length} file, ` +
                  `${names.filter((f) => /\.dll$/i.test(f)).length} dll`
              )
              if (foreign.length) {
                // è il caso che rompe l'avvio: una build di whisper.cpp (o CUDA)
                // ha sovrascritto ggml.dll/mtmd.dll di llama.cpp
                this.push(`[dll] file di un'altra build nella radice: ${foreign.join(', ')}`)
                this.push(
                  '[dll] riavvia: dati/bin viene riallineato ai binari del pacchetto ' +
                    '(se resta, elimina la cartella dati/bin e riavvia)'
                )
              } else {
                // la build llama.cpp usa ggml-cpu-<arch>.dll, non un ggml-cpu.dll unico
                const needed = ['llama.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-vulkan.dll', 'mtmd.dll']
                const missing = needed.filter((n) => !names.includes(n))
                if (!names.some((n) => /^ggml-cpu(-.*)?\.dll$/i.test(n))) missing.push('ggml-cpu-<arch>.dll')
                this.push(
                  missing.length
                    ? `[dll] mancano: ${missing.join(', ')}`
                    : '[dll] i file attesi ci sono tutti: la build di llama.cpp inclusa non è compatibile (aggiorna l app)'
                )
              }
            } catch {
              /* ignore */
            }
          }
          if (this.child === child) {
            this.child = null
            this.port = null
          }
        })
        child.on('error', (err) => this.push(`[errore server] ${err.message}`))

        if (await this.waitHealthy(port, 15 * 60 * 1000)) {
          this.deviceLabel = this.logLines.some((l) => /vulkan/i.test(l)) ? 'GPU' : 'CPU'
          this.push(`[pronto su 127.0.0.1:${port} — ${this.deviceLabel}]`)
          return {
            modelId: this.modelId,
            deviceKey: this.device?.key ?? null,
            port,
            baseUrl: `http://127.0.0.1:${port}`
          }
        }
        const bindIssue = this.logLines.some((l) => BIND_FAILURE.test(l))
        const dllBroken = this.lastExitCode === 3221225785 || this.lastExitCode === -1073741515
        lastError = new Error(
          bindIssue
            ? `porta ${port} occupata da un altro processo`
            : dllBroken
              ? `le DLL accanto a llama-server non sono compatibili (0xC0000139) anche dopo il ` +
                `riallineamento: elimina ${path.join(dataDir(), 'bin')} e riavvia l'app`
              : `llama-server non ha risposto (app v${app.getVersion()}, binari in ${exe}): controlla il log`
        )
        await this.stop()
        const dllMismatch = this.lastExitCode === 3221225785 || this.lastExitCode === -1073741515
        // DLL mancante o di un'altra build: invece di arrendersi si riallinea
        // `dati/bin` al pacchetto e si riprova una volta sola
        if (dllMismatch && !this.repaired) {
          this.repaired = true
          this.push('[dll] riallineo dati/bin ai binari del pacchetto e riprovo')
          try {
            ensureBinaries(true)
          } catch (err) {
            this.push(`[dll] riallineamento fallito: ${(err as Error).message}`)
          }
          continue
        }
        if (!bindIssue) break
        await new Promise((r) => setTimeout(r, 500))
      }
      throw lastError ?? new Error('avvio di llama-server fallito')
    } finally {
      this.starting = false
    }
  }

  private async waitHealthy(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.child) return false
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`)
        if (res.ok) {
          const body = (await res.json()) as { status?: string }
          if (body.status === 'ok') return true
        }
      } catch {
        /* non ancora in ascolto */
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    return false
  }
}

/**
 * Pool di server: un processo per ogni modello distinto in uso.
 * 3 chat con lo stesso modello -> 1 solo processo.
 * 3 chat con 3 modelli -> 3 processi (uno per modello).
 */
class LlamaPool extends EventEmitter {
  private instances = new Map<string, LlamaInstance>()

  /** Risolve la GPU richiesta: chiave esplicita, oppure l'unica disponibile, oppure auto. */
  private async resolveDevice(deviceKey?: string): Promise<GpuDevice | null> {
    const { usable } = await detectGpus()
    if (deviceKey) {
      const found = usable.find((d) => d.key === deviceKey)
      if (found) return found
    }
    // nessuna scelta: la GPU migliore disponibile, non "auto" alla cieca
    return bestDevice(usable)
  }

  /** Contesto assegnato a questa coppia modello+GPU, tenendo conto delle altre chat. */
  private async ctxFor(modelId: string, device: GpuDevice | null): Promise<number | undefined> {
    if (!device) return undefined
    const s = getSettings()
    const targets: { key: string; modelPath: string; mmprojPath?: string }[] = []
    for (const persona of s.personas) {
      const model = catalogModel(s.models.byPersona[persona.id] ?? s.models.active)
      const personaDevice = await this.resolveDevice(s.gpus.byPersona[persona.id])
      // solo i modelli che finiscono sulla stessa GPU di questa istanza
      if ((personaDevice?.key ?? 'auto') !== (device.key ?? 'auto')) continue
      if (targets.some((t) => t.key === `${model.id}|${device.key}`)) continue
      targets.push({
        key: `${model.id}|${device.key}`,
        modelPath: path.join(modelsDir(), model.files.model.name),
        mmprojPath: model.files.mmproj ? path.join(modelsDir(), model.files.mmproj.name) : undefined
      })
    }
    // la coppia richiesta deve essere nel piano anche se nessuna chat la usa ancora
    if (!targets.some((t) => t.key === `${modelId}|${device.key}`)) {
      const model = catalogModel(modelId)
      targets.push({
        key: `${modelId}|${device.key}`,
        modelPath: path.join(modelsDir(), model.files.model.name),
        mmprojPath: model.files.mmproj ? path.join(modelsDir(), model.files.mmproj.name) : undefined
      })
    }
    try {
      const plan = planPool(targets, device, s.contextSize, s.kvCacheType)
      const signature = [...plan.contextByKey.entries()].map(([k, v]) => `${k}=${v}`).join(',')
      if (signature !== this.lastPlanSignature) {
        this.lastPlanSignature = signature
        for (const note of plan.notes) this.emit('log', `[pool] ${note}`)
      }
      return plan.contextByKey.get(`${modelId}|${device.key}`)
    } catch (err) {
      this.emit('log', `[pool] ${(err as Error).message}`)
      throw err
    }
  }

  private async instance(modelId: string, deviceKey?: string): Promise<LlamaInstance> {
    const device = await this.resolveDevice(deviceKey)
    const key = `${modelId}|${device?.key ?? 'auto'}`
    let inst = this.instances.get(key)
    if (!inst) {
      const ctx = await this.ctxFor(modelId, device)
      inst = new LlamaInstance(modelId, device, ctx)
      inst.on('log', (line: string) => this.emit('log', line))
      this.instances.set(key, inst)
    }
    return inst
  }

  private lastPlanSignature = ''

  async ensure(modelId?: string, deviceKey?: string): Promise<ServerInfo> {
    const id = modelId ?? getSettings().models.active ?? defaultModelId()
    const inst = await this.instance(id, deviceKey)
    return inst.start()
  }

  async restart(modelId?: string, deviceKey?: string): Promise<ServerInfo> {
    await this.stopAll()
    return this.ensure(modelId, deviceKey)
  }

  async restartAll(): Promise<void> {
    await this.stopAll()
  }

  /** Rete di sicurezza all'uscita: nessun llama-server deve restare in VRAM. */
  forceKillAll(): void {
    for (const i of this.instances.values()) i.killNow()
    this.instances.clear()
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.instances.values()].map((i) => i.stop()))
    this.instances.clear()
  }

  /** Contesto realmente utilizzabile per un modello (limite dichiarato dal GGUF incluso). */
  effectiveContext(modelId: string): number {
    const s = getSettings()
    const model = catalogModel(modelId)
    let declared = 0
    try {
      declared = readGgufHints(path.join(modelsDir(), model.files.model.name)).contextLength
    } catch {
      declared = 0
    }
    return declared > 0 ? Math.min(s.contextSize, declared) : s.contextSize
  }

  status(): ServerStatus[] {
    return [...this.instances.values()].map((i) => i.status())
  }

  /**
   * All'avvio chiude i llama-server rimasti da un'esecuzione precedente:
   * altrimenti la VRAM resta occupata e il nuovo modello non entra.
   */
  async cleanupOrphans(): Promise<number> {
    let killed = 0
    try {
      const dir = runDir()
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.pid')) continue
        const file = path.join(dir, name)
        const pid = Number(fs.readFileSync(file, 'utf8').trim())
        if (pid > 0) {
          try {
            if (process.platform === 'win32') {
              spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { windowsHide: true })
            } else {
              process.kill(pid, 'SIGKILL')
            }
            killed++
            this.emit('log', `[cleanup] chiuso llama-server orfano (pid ${pid})`)
          } catch {
            /* già morto */
          }
        }
        fs.rmSync(file, { force: true })
      }
    } catch {
      /* niente da pulire */
    }
    return killed
  }

  /** Coppie (modello, GPU) richieste dalle 3 chat: una sola istanza per coppia. */
  requiredTargets(): { modelId: string; deviceKey?: string }[] {
    const s = getSettings()
    const out: { modelId: string; deviceKey?: string }[] = []
    const seen = new Set<string>()
    for (const persona of s.personas) {
      const modelId = s.models.byPersona[persona.id] ?? s.models.active
      const deviceKey = s.gpus.byPersona[persona.id]
      const key = `${modelId}|${deviceKey ?? 'auto'}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ modelId, deviceKey })
    }
    return out
  }

  /** Sostituisce requiredModels() per i chiamanti storici. */
  requiredModels(): string[] {
    return [...new Set(this.requiredTargets().map((t) => t.modelId))]
  }
}

export const llamaPool = new LlamaPool()
