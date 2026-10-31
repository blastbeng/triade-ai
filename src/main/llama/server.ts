import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { cacheDir, dataDir, findBinary, modelsDir } from '../paths'
import { getSettings } from '../settings'
import { catalogModel, defaultModelId } from '../models/registry'
import { detectGpus, llamaBinaryFor, type Backend, type GpuDevice } from '../gpu/devices'
import { planLaunch } from './tuning'
import type { ServerStatus } from '../../shared/types'

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
  private child: ChildProcessWithoutNullStreams | null = null
  private port: number | null = null
  private logLines: string[] = []
  private starting = false
  private deviceLabel = 'sconosciuto'

  constructor(modelId: string, device: GpuDevice | null) {
    super()
    this.modelId = modelId
    this.device = device
  }

  get key(): string {
    return `${this.modelId}|${this.device?.key ?? 'auto'}`
  }

  status(): ServerStatus {
    return {
      modelId: this.modelId,
      running: !!this.child && !this.child.killed,
      starting: this.starting,
      port: this.port,
      device: this.deviceLabel + (this.device ? ` · ${this.device.name}` : ''),
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

  private push(line: string): void {
    const clean = line.replace(/\r/g, '')
    if (!clean.trim()) return
    try {
      fs.appendFileSync(this.logFile(), `${new Date().toISOString()} [${this.modelId}] ${clean}\n`)
    } catch {
      /* ignore */
    }
    this.logLines.push(clean)
    if (this.logLines.length > 300) this.logLines.splice(0, this.logLines.length - 300)
    if (/(vulkan|cuda)/i.test(clean) && /device/i.test(clean)) this.deviceLabel = 'GPU'
    this.emit('log', `[${this.modelId}] ${clean}`)
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.port = null
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
      const plan = planLaunch({
        device: this.device,
        contextSize: s.contextSize,
        kvPreference: s.kvCacheType,
        gpuLayers: s.gpuLayers,
        modelPath,
        mmprojPath: mmprojPath || undefined,
        autoTune: s.autoTune
      })
      for (const note of plan.notes) this.push(`[tuning] ${note}`)
      this.push(
        `[tuning] ctx=${plan.ctx} kv=${plan.kvType} ngl=${plan.ngl} ubatch=${plan.ubatch} ` +
          `mmproj=${plan.mmprojOffload ? 'GPU' : 'CPU'} stima=${plan.estimate.totalMiB}MiB / ${plan.estimate.availableMiB}MiB`
      )

      let lastError: Error | null = null
      for (let attempt = 1; attempt <= 5; attempt++) {
        const port = await freePort()
        const args = [
          '-m', modelPath,
          ...(this.device ? ['--device', this.device.label] : []),
          ...(mmprojPath ? ['--mmproj', mmprojPath] : []),
          // +1024 di slack: il conteggio lato app è una stima, il server non deve mai rifiutare
          '-c', String(plan.ctx + 1024),
          '-ngl', String(plan.ngl),
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
        this.push(
          `avvio (tentativo ${attempt}, porta ${port}) -c ${s.contextSize} -ngl ${s.gpuLayers}` +
            (this.device ? ` --device ${this.device.label} (${this.device.name})` : ' --device auto')
        )
        const child = spawn(exe, args, { windowsHide: true, cwd: path.dirname(exe) })
        this.child = child
        this.port = port
        const onData = (buf: Buffer): void => {
          for (const line of buf.toString('utf8').split('\n')) this.push(line)
        }
        child.stdout.on('data', onData)
        child.stderr.on('data', onData)
        child.on('exit', (code, signal) => {
          this.push(`[server terminato, codice ${code}, segnale ${signal ?? 'nessuno'}]`)
          if (this.child === child) {
            this.child = null
            this.port = null
          }
        })
        child.on('error', (err) => this.push(`[errore server] ${err.message}`))

        if (await this.waitHealthy(port, 15 * 60 * 1000)) {
          this.deviceLabel = this.logLines.some((l) => /vulkan|cuda/i.test(l)) ? 'GPU' : 'CPU'
          this.push(`[pronto su 127.0.0.1:${port} — ${this.deviceLabel}]`)
          return {
            modelId: this.modelId,
            deviceKey: this.device?.key ?? null,
            port,
            baseUrl: `http://127.0.0.1:${port}`
          }
        }
        const bindIssue = this.logLines.some((l) => BIND_FAILURE.test(l))
        lastError = new Error(
          bindIssue ? `porta ${port} occupata da un altro processo` : 'llama-server non ha risposto: controlla il log'
        )
        await this.stop()
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
    if (usable.length === 1) return usable[0]
    return null
  }

  private async instance(modelId: string, deviceKey?: string): Promise<LlamaInstance> {
    const device = await this.resolveDevice(deviceKey)
    const key = `${modelId}|${device?.key ?? 'auto'}`
    let inst = this.instances.get(key)
    if (!inst) {
      inst = new LlamaInstance(modelId, device)
      inst.on('log', (line: string) => this.emit('log', line))
      this.instances.set(key, inst)
    }
    return inst
  }

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

  async stopAll(): Promise<void> {
    await Promise.all([...this.instances.values()].map((i) => i.stop()))
    this.instances.clear()
  }

  status(): ServerStatus[] {
    return [...this.instances.values()].map((i) => i.status())
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
