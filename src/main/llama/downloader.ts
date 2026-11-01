import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { validateGgufFile } from '../models/verify'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { modelsDir } from '../paths'
import { catalogModel, listModels, type CatalogModel } from '../models/registry'
import type { ModelStatus } from '../../shared/types'

type ProgressCb = (status: ModelStatus) => void

const state: {
  id: string | null
  downloading: boolean
  progress: number
  phase: string
  error?: string
  abort?: AbortController
} = { id: null, downloading: false, progress: 0, phase: 'inattivo' }

const sizeCache = new Map<string, { at: number; size: number }>()
const SIZE_TTL = 10 * 60 * 1000

/** SHA-256 ufficiale del file su HuggingFace (lfs.sha256), se disponibile. */
async function remoteSha256(url: string): Promise<string> {
  const hf = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/.exec(url)
  if (!hf) return ''
  try {
    const res = await fetch(`https://huggingface.co/api/models/${hf[1]}?blobs=true`, {
      signal: AbortSignal.timeout(20000)
    })
    if (!res.ok) return ''
    const data = (await res.json()) as {
      siblings?: { rfilename: string; lfs?: { sha256?: string } }[]
    }
    const file = decodeURIComponent(hf[2])
    const found = (data.siblings ?? []).find((s) => s.rfilename === file)
    return found?.lfs?.sha256 ?? ''
  } catch {
    return ''
  }
}

async function remoteSize(url: string): Promise<number> {
  const cached = sizeCache.get(url)
  if (cached && Date.now() - cached.at < SIZE_TTL) return cached.size
  let size = 0

  // 1) HuggingFace: dimensione esatta dall'API dei file (blobs=true)
  const hf = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/.exec(url)
  if (hf) {
    try {
      const api = `https://huggingface.co/api/models/${hf[1]}?blobs=true`
      const res = await fetch(api, { signal: AbortSignal.timeout(15000) })
      if (res.ok) {
        const data = (await res.json()) as { siblings?: { rfilename: string; size?: number }[] }
        const file = decodeURIComponent(hf[2])
        const found = (data.siblings ?? []).find((s) => s.rfilename === file)
        if (found?.size) size = found.size
      }
    } catch {
      /* si prova comunque HEAD */
    }
  }

  // 2) HEAD (content-length / x-linked-size)
  if (!size) {
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
      const len = res.headers.get('content-length') ?? res.headers.get('x-linked-size')
      size = len ? Number(len) : 0
    } catch {
      /* si prova il GET ranged */
    }
  }

  // 3) GET di 1 byte: Content-Range contiene la dimensione totale
  if (!size) {
    try {
      const res = await fetch(url, {
        headers: { Range: 'bytes=0-0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000)
      })
      const range = res.headers.get('content-range')
      const total = range ? Number(range.split('/')[1]) : 0
      size = Number.isFinite(total) ? total : 0
      await res.body?.cancel().catch(() => undefined)
    } catch {
      size = 0
    }
  }

  if (size > 0) sizeCache.set(url, { at: Date.now(), size })
  return size
}

function sizeOf(p: string): number {
  return fs.existsSync(p) ? fs.statSync(p).size : 0
}

function complete(have: number, expected: number): boolean {
  if (have <= 0) return false
  // dimensione nota → deve combaciare al byte: 28 MB mancanti su 5,6 GB (0,5%)
  // bastano a rendere il GGUF illeggibile, quindi niente tolleranza
  if (expected > 0) return have === expected
  return have > 1_000_000_000
}

export async function statusFor(id: string): Promise<ModelStatus> {
  const m = catalogModel(id)
  const modelPath = path.join(modelsDir(), m.files.model.name)
  const mmprojPath = m.files.mmproj ? path.join(modelsDir(), m.files.mmproj.name) : ''
  const modelBytes = sizeOf(modelPath)
  const mmprojBytes = mmprojPath ? sizeOf(mmprojPath) : 0
  const expectedModel = await remoteSize(m.files.model.url)
  const expectedMmproj = m.files.mmproj ? await remoteSize(m.files.mmproj.url) : 0
  const busy = state.downloading && state.id === m.id
  return {
    id: m.id,
    name: m.name,
    modelPath,
    mmprojPath,
    modelReady: complete(modelBytes, expectedModel) && validateGgufFile(modelPath).ok,
    mmprojReady:
      !m.files.mmproj || (complete(mmprojBytes, expectedMmproj) && validateGgufFile(mmprojPath).ok),
    modelBytes,
    mmprojBytes,
    expectedBytes: (expectedModel || m.bytes) + expectedMmproj,
    downloading: busy,
    progress: busy ? state.progress : 0,
    phase: busy ? state.phase : 'inattivo',
    error: busy ? state.error : undefined
  }
}

export async function catalogStatus(): Promise<ModelStatus[]> {
  const out: ModelStatus[] = []
  for (const m of listModels()) out.push(await statusFor(m.id))
  return out
}

/** Dimensione attesa del mmproj, per pesare l'avanzamento. */
function mmprojSizeOf(m: CatalogModel): number {
  const mmproj = m.files.mmproj
  if (!mmproj) return 0
  const file = path.join(modelsDir(), mmproj.name)
  if (fs.existsSync(file)) return fs.statSync(file).size
  return Math.round((m.bytes ?? 0) * 0.12) || 1
}

const fileLocks = new Map<string, Promise<void>>()

async function downloadWithResume(
  url: string,
  dest: string,
  onPct: (pct: number) => void
): Promise<void> {
  const running = fileLocks.get(dest)
  if (running) return running
  const task = downloadWithResumeInner(url, dest, onPct).finally(() => fileLocks.delete(dest))
  fileLocks.set(dest, task)
  return task
}

/** Verifica finale unica: dimensione esatta, sidecar .size, header GGUF. */
async function finalize(
  part: string,
  dest: string,
  expected: number,
  url = '',
  knownHash?: string
): Promise<void> {
  fs.renameSync(part, dest)
  if (expected > 0) {
    const actual = fs.statSync(dest).size
    if (actual !== expected) {
      fs.rmSync(dest, { force: true })
      throw new Error(`download incompleto: ${actual} byte su ${expected} attesi. Riprova.`)
    }
    fs.writeFileSync(`${dest}.size`, String(expected), 'utf8')
  } else if (!url) {
    // né dimensione né hash: meglio un errore chiaro che un modello corrotto
    fs.rmSync(dest, { force: true })
    throw new Error(
      'impossibile verificare il download (dimensione non dichiarata dal server): riprova'
    )
  }
  const check = validateGgufFile(dest)
  if (!check.ok) {
    fs.rmSync(dest, { force: true })
    throw new Error(`file scaricato corrotto (${check.reason}): riprova il download`)
  }

  // verifica forte: SHA-256 ufficiale dichiarato da HuggingFace
  const expectedHash = url ? await remoteSha256(url) : ''
  if (!expectedHash && expected <= 0) {
    fs.rmSync(dest, { force: true })
    throw new Error('download non verificabile (né dimensione né hash): riprova')
  }
  if (expectedHash) {
    // se l'hash è già stato calcolato durante il download, non si rilegge il file
    const actual = knownHash ?? (await new Promise<string>((resolve, reject) => {
      const h = createHash('sha256')
      const rs = fs.createReadStream(dest)
      rs.on('data', (c) => h.update(c))
      rs.on('error', reject)
      rs.on('end', () => resolve(h.digest('hex')))
    }))
    if (actual !== expectedHash) {
      fs.rmSync(dest, { force: true })
      throw new Error(
        'il file scaricato non corrisponde all’hash ufficiale (download corrotto): riprova'
      )
    }
    fs.writeFileSync(`${dest}.meta`, JSON.stringify({ size: expected, sha256: expectedHash }), 'utf8')
  }
}

/**
 * Download in streaming singolo (una sola connessione, il più veloce possibile)
 * con ripresa via Range e hash SHA-256 calcolato man mano. La verifica finale
 * (dimensione al byte + hash ufficiale) intercetta comunque ogni corruzione:
 * i blocchi da 64 MB rallentavano su Windows e rendevano la barra a scatti.
 */
async function downloadWithResumeInner(
  url: string,
  dest: string,
  onPct: (pct: number) => void
): Promise<void> {
  const part = `${dest}.part`

  let total = await remoteSize(url)
  if (total <= 0) {
    try {
      const probe = await fetch(url, {
        headers: { Range: 'bytes=0-0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000)
      })
      const cr = probe.headers.get('content-range')
      total = cr ? Number(cr.split('/')[1]) : 0
      await probe.body?.cancel().catch(() => undefined)
    } catch {
      total = 0
    }
  }
  if (total <= 0) throw new Error('il server non dichiara la dimensione: download non verificabile')

  let have = fs.existsSync(part) ? Math.min(fs.statSync(part).size, total) : 0
  if (have >= total) have = 0 // file parziale più grande dell'atteso: si riparte
  if (have > 0) fs.truncateSync(part, have)
  else fs.writeFileSync(part, '')

  const headers: Record<string, string> = {}
  if (have > 0) headers.Range = `bytes=${have}-`
  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: state.abort ? AbortSignal.any([state.abort.signal, AbortSignal.timeout(1_800_000)]) : AbortSignal.timeout(1_800_000)
  })
  if (!res.ok && res.status !== 206) throw new Error(`download fallito (${res.status}) da ${url}`)
  if (res.status !== 206) have = 0
  if (!res.body) throw new Error('risposta senza corpo')

  const fd = fs.openSync(part, have > 0 ? 'r+' : 'w')
  const hash = have === 0 ? createHash('sha256') : null
  let received = have
  let lastTick = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const buf = Buffer.from(value)
      fs.writeSync(fd, buf, 0, buf.length, received)
      hash?.update(buf)
      received += buf.length
      const now = Date.now()
      if (now - lastTick > 80) {
        lastTick = now
        onPct(Math.min(0.999, received / total))
      }
    }
  } finally {
    fs.closeSync(fd)
  }

  if (received !== total) {
    throw new Error(`download incompleto: ${received} byte su ${total} attesi (riprende da qui)`)
  }
  onPct(1)
  await finalize(part, dest, total, url, hash ? hash.digest('hex') : undefined)
}

export async function installModel(id: string, onProgress?: ProgressCb): Promise<ModelStatus> {
  const m: CatalogModel = catalogModel(id)
  if (state.downloading) return statusFor(id)

  state.id = id
  state.downloading = true
  state.progress = 0
  state.phase = 'preparazione'
  state.error = undefined
  state.abort = new AbortController()

  const emit = (phase: string, pct: number): void => {
    state.phase = phase
    state.progress = pct
    onProgress?.({
      id,
      name: m.name,
      modelPath: path.join(modelsDir(), m.files.model.name),
      mmprojPath: m.files.mmproj ? path.join(modelsDir(), m.files.mmproj.name) : '',
      modelReady: false,
      mmprojReady: false,
      modelBytes: 0,
      mmprojBytes: 0,
      expectedBytes: m.bytes,
      downloading: true,
      progress: pct,
      phase
    })
  }

  try {
    const current = await statusFor(id)
    // avanzamento pesato sui BYTE di tutti i file necessari (modello + mmproj)
    const modelSize = current.expectedBytes && m.files.mmproj
      ? Math.max(1, current.expectedBytes - mmprojSizeOf(m))
      : Math.max(1, current.expectedBytes || m.bytes)
    const mmprojSize = m.files.mmproj ? Math.max(1, mmprojSizeOf(m)) : 0
    const totalBytes = modelSize + mmprojSize
    let modelDone = current.modelReady ? modelSize : 0
    let mmprojDone = current.mmprojReady ? mmprojSize : 0

    const report = (phase: string): void => {
      const done = modelDone + mmprojDone
      emit(phase, Math.min(0.999, done / totalBytes))
    }

    if (!current.modelReady) {
      report('modello')
      await downloadWithResume(m.files.model.url, current.modelPath, (p) => {
        modelDone = p * modelSize
        report('modello')
      })
      modelDone = modelSize
    }
    if (m.files.mmproj && !current.mmprojReady) {
      report('mmproj (vision)')
      await downloadWithResume(m.files.mmproj.url, current.mmprojPath, (p) => {
        mmprojDone = p * mmprojSize
        report('mmproj (vision)')
      })
      mmprojDone = mmprojSize
    }
    state.phase = 'completato'
    state.progress = 1
    return await statusFor(id)
  } catch (err) {
    state.error = (err as Error).message
    state.phase = 'errore'
    throw err
  } finally {
    state.downloading = false
    state.abort = undefined
    onProgress?.(await statusFor(id))
  }
}

export async function removeModel(id: string): Promise<void> {
  const m = catalogModel(id)
  for (const f of [m.files.model, m.files.mmproj]) {
    if (!f) continue
    const p = path.join(modelsDir(), f.name)
    for (const candidate of [p, `${p}.part`]) {
      if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true })
    }
  }
}

/* ------------------------------------------------------------------ *
 * Integrità dei modelli scaricati
 * ------------------------------------------------------------------ */

export interface IntegrityReport {
  id: string
  name: string
  modelFile: string
  ok: boolean
  reason?: string
  /** true se esiste una sorgente da cui riscaricare il file */
  repairable: boolean
  bytes: number
}

/** Elenco dei modelli installati con il loro stato di integrità. */
export async function integrityReport(): Promise<IntegrityReport[]> {
  const list = listModels()
  const out: IntegrityReport[] = []
  for (const m of list) {
    const modelFile = path.join(modelsDir(), m.files.model.name)
    if (!fs.existsSync(modelFile)) continue
    const check = validateGgufFile(modelFile)
    const mmprojPath = m.files.mmproj ? path.join(modelsDir(), m.files.mmproj.name) : ''
    const visionOk = mmprojPath ? validateGgufFile(mmprojPath).ok : true
    // dimensione attesa registrata al download: intercetta i file troncati
    // che l'header GGUF (integro) non tradisce
    const sizeFile = `${modelFile}.size`
    let sizeOk = true
    if (fs.existsSync(sizeFile)) {
      const expected = Number(fs.readFileSync(sizeFile, 'utf8').trim())
      sizeOk = !expected || fs.statSync(modelFile).size === expected
    }
    out.push({
      id: m.id,
      name: m.name,
      modelFile: m.files.model.name,
      ok: check.ok && visionOk && sizeOk,
      reason: !sizeOk
        ? 'file troncato (dimensione diversa da quella scaricata)'
        : check.ok
          ? visionOk
            ? undefined
            : 'mmproj corrotto'
          : check.reason,
      repairable: Boolean(m.files.model.url),
      bytes: fs.statSync(modelFile).size
    })
  }
  return out
}

/**
 * Ripara un modello corrotto: elimina i file e li riscarica dalla sorgente.
 * Ritorna false se non esiste una sorgente (modello custom senza repo).
 */
export async function repairModel(id: string, onProgress?: ProgressCb): Promise<boolean> {
  const entry = listModels().find((m) => m.id === id)
  if (!entry || !entry.files.model.url) return false
  try {
    removeModel(id)
  } catch {
    // file già assenti
  }
  const status = await installModel(id, onProgress)
  return status.modelReady && status.mmprojReady
}
