import fs from 'node:fs'
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

async function remoteSize(url: string): Promise<number> {
  const cached = sizeCache.get(url)
  if (cached && Date.now() - cached.at < SIZE_TTL) return cached.size
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    const len = res.headers.get('content-length') ?? res.headers.get('x-linked-size')
    const size = len ? Number(len) : 0
    if (size > 0) sizeCache.set(url, { at: Date.now(), size })
    return size
  } catch {
    return 0
  }
}

function sizeOf(p: string): number {
  return fs.existsSync(p) ? fs.statSync(p).size : 0
}

function complete(have: number, expected: number): boolean {
  if (have <= 0) return false
  if (expected <= 0) return have > 1_000_000_000
  return have >= expected * 0.995
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

async function downloadWithResume(
  url: string,
  dest: string,
  onPct: (pct: number) => void
): Promise<void> {
  const part = `${dest}.part`
  let start = fs.existsSync(part) ? fs.statSync(part).size : 0
  const total = await remoteSize(url)
  if (total > 0 && start >= total * 0.999) {
    fs.renameSync(part, dest)
    onPct(1)
    return
  }
  const headers: Record<string, string> = {}
  if (start > 0) headers.Range = `bytes=${start}-`
  const res = await fetch(url, { headers, redirect: 'follow', signal: state.abort?.signal })
  if (!res.ok && res.status !== 206) throw new Error(`download fallito (${res.status}) da ${url}`)
  if (res.status !== 206) start = 0
  // HuggingFace spesso reindirizza senza content-length: ricaviamo il totale
  // da Content-Range oppure dal content-length della risposta effettiva,
  // altrimenti la barra resterebbe ferma a 0%.
  let totalKnown = total
  if (totalKnown <= 0) {
    const range = res.headers.get('content-range')
    const fromRange = range ? Number(range.split('/')[1]) : 0
    const length = Number(res.headers.get('content-length') ?? 0)
    totalKnown = Number.isFinite(fromRange) && fromRange > 0 ? fromRange : start + (length || 0)
  }
  if (!res.body) throw new Error('risposta senza corpo')
  const sink = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' })
  let received = start
  const source = Readable.fromWeb(res.body as any)
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (totalKnown > 0) onPct(Math.min(0.999, received / totalKnown))
  })
  await pipeline(source, sink)
  if (totalKnown > 0 && fs.statSync(part).size < totalKnown * 0.995) {
    throw new Error('download incompleto: rilancia, riprenderà da dove si era fermato')
  }
  fs.renameSync(part, dest)
  const check = validateGgufFile(dest)
  if (!check.ok) {
    fs.rmSync(dest, { force: true })
    throw new Error(`file scaricato corrotto (${check.reason}): riprova il download`)
  }
  onPct(1)
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
    out.push({
      id: m.id,
      name: m.name,
      modelFile: m.files.model.name,
      ok: check.ok && visionOk,
      reason: check.ok ? (visionOk ? undefined : 'mmproj corrotto') : check.reason,
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
