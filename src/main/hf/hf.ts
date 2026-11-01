import os from 'node:os'
import type { GpuDevice } from '../gpu/devices'

const API = 'https://huggingface.co/api'

export interface HfFile {
  path: string
  size: number
}

export interface QuantVariant {
  /** etichetta del quant, es. Q4_K_M */
  quant: string
  file: string
  bytes: number
  /** stima di memoria totale (pesi + mmproj + KV + buffer) per il contesto richiesto */
  totalMiB: number
  fits: boolean
}

export interface HfVerdict {
  repo: string
  name: string
  paramsB: number
  vision: boolean
  /** quant consigliato (il migliore che entra) */
  quant: string | null
  modelFile: string | null
  mmprojFile: string | null
  mmprojBytes: number
  downloadBytes: number
  totalMiB: number
  availableMiB: number
  ok: boolean
  reason: string
  variants: QuantVariant[]
  downloads?: number
}

const QUANT_RE =
  /\b(IQ\d+(?:_[A-Z0-9]+)+|Q\d+_K(?:_[A-Z]{1,3})*|Q\d+_[01]|Q8_0|Q6_K|Q5_K(?:_[SM])?|F16|BF16|FP16)\b/i

function paramsFromName(text: string): number {
  const m = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s?B(?![a-z])/i.exec(text)
  if (m) {
    const v = Number(m[1])
    if (v > 0.3 && v < 400) return v
  }
  return 0
}

/** KV cache stimata per token (MiB): calibrata su modelli ibridi ~9B (≈0.017). */
function kvPerTokenMiB(paramsB: number): number {
  return Math.max(0.002, 0.0019 * paramsB)
}

async function api<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { 'User-Agent': 'triade-ai' },
      signal: AbortSignal.timeout(20000)
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

interface HfModelRow {
  modelId?: string
  id?: string
  downloads?: number
  likes?: number
  tags?: string[]
  pipeline_tag?: string
  gated?: boolean | string
}

export async function searchGgufModels(query: string, limit = 20): Promise<HfModelRow[]> {
  const data = await api<HfModelRow[]>(
    `/models?search=${encodeURIComponent(query)}&filter=gguf&limit=${limit}&sort=downloads&direction=-1&full=false`
  )
  return (data ?? []).filter((m) => (m.modelId ?? m.id ?? '').length > 0)
}

export async function listRepoFiles(repo: string): Promise<HfFile[]> {
  const files: HfFile[] = []
  for (let page = 0; page < 4; page++) {
    const data = await api<{ type: string; path: string; size?: number }[]>(
      `/models/${repo}/tree/main?recursive=true&expand=false`
    )
    if (!data) break
    for (const row of data) {
      if (row.type === 'file' && typeof row.size === 'number') files.push({ path: row.path, size: row.size })
    }
    break // l'endpoint restituisce già l'albero completo
  }
  return files
}

function pickMmproj(files: HfFile[]): HfFile | null {
  const candidates = files.filter((f) => /mmproj/i.test(f.path) && /\.gguf$/i.test(f.path))
  if (!candidates.length) return null
  const q8 = candidates.find((f) => /q8_0/i.test(f.path))
  const f16 = candidates.find((f) => /f16|fp16|bf16/i.test(f.path))
  return q8 ?? f16 ?? candidates.sort((a, b) => a.size - b.size)[0]
}

export interface CompatInput {
  /** GPU scelta per l'uso (la migliore disponibile) */
  device: GpuDevice | null
  /** contesto che l'app userà di default */
  contextSize: number
  /** quanti modelli diversi gireranno insieme (pool) */
  concurrentModels?: number
}

const RESERVE_MIB = 1024

/**
 * Verifica un repo HuggingFace: presenza della vision (mmproj), quant migliore che entra
 * nella VRAM disponibile e stima di memoria. Nessun nome di modello cablato.
 */
export async function inspectRepo(
  repo: string,
  compat: CompatInput,
  modelRow?: HfModelRow
): Promise<HfVerdict> {
  const files = await listRepoFiles(repo)
  const name = (modelRow?.modelId ?? repo).split('/').pop() ?? repo
  const mmproj = pickMmproj(files)
  const ggufs = files.filter(
    (f) => /\.gguf$/i.test(f.path) && !/mmproj/i.test(f.path) && !/-\d{5}-of-\d{5}/i.test(f.path)
  )

  const tags = modelRow?.tags ?? []
  const visionTag = tags.includes('image-text-to-text') || tags.includes('vision')

  const variants: QuantVariant[] = []
  const seen = new Set<string>()
  for (const file of ggufs.sort((a, b) => b.size - a.size)) {
    const label = (QUANT_RE.exec(file.path)?.[1]?.toUpperCase() ?? 'GGUF').replace(/^UD-/, '')
    if (seen.has(label)) continue
    seen.add(label)
    const nameParams = paramsFromName(`${repo} ${file.path}`)
    const paramsB = nameParams || Math.max(0.5, file.size / 1e9 / 0.6)
    const overheadMiB = 450 + file.size / 1024 ** 2 * 0.08
    const kvMiB =
      (kvPerTokenMiB(paramsB) * compat.contextSize) / Math.max(1, compat.concurrentModels ?? 1)
    const totalMiB = Math.round(
      file.size / 1024 ** 2 + (mmproj?.size ?? 0) / 1024 ** 2 + kvMiB + overheadMiB
    )
    const available = compat.device ? compat.device.vramMiB - RESERVE_MIB : 0
    variants.push({
      quant: label,
      file: file.path,
      bytes: file.size,
      totalMiB,
      fits: available > 0 && totalMiB <= available
    })
  }

  const fitting = variants.filter((v) => v.fits).sort((a, b) => b.bytes - a.bytes)
  const best = fitting[0] ?? null
  const smallest = variants.length ? variants.reduce((a, b) => (a.bytes < b.bytes ? a : b)) : null
  const available = compat.device ? Math.round(compat.device.vramMiB - RESERVE_MIB) : 0

  let reason = ''
  let ok = false
  if (!files.length) reason = 'file del repository non leggibili (repo privato o inaccessibile)'
  else if (!mmproj) {
    reason = 'nessun file mmproj: il modello non supporta le immagini/video, quindi è escluso'
  } else if (!variants.length) reason = 'nessun quant GGUF utilizzabile nel repository'
  else if (!best) {
    reason = `nessun quant entra nella VRAM: il più piccolo (${smallest?.quant}) richiede ${smallest?.totalMiB} MiB, disponibili ${available} MiB`
  } else {
    ok = true
    reason = `usabile: ${best.quant} occupa circa ${best.totalMiB} MiB su ${available} MiB`
    if (best.quant !== variants[0].quant) {
      reason += ` — il quant più grande (${variants[0].quant}) non entrerebbe`
    }
    if (visionTag && !mmproj) reason += ' (tag vision senza projector)'
  }

  return {
    repo,
    name,
    paramsB: paramsFromName(`${repo} ${best?.file ?? ''}`) || 0,
    vision: Boolean(mmproj),
    quant: best?.quant ?? null,
    modelFile: best?.file ?? null,
    mmprojFile: mmproj?.path ?? null,
    mmprojBytes: mmproj?.size ?? 0,
    downloadBytes: (best?.bytes ?? 0) + (mmproj?.size ?? 0),
    totalMiB: best?.totalMiB ?? smallest?.totalMiB ?? 0,
    availableMiB: available,
    ok,
    reason,
    variants,
    downloads: modelRow?.downloads
  }
}

/** RAM di sistema in MiB, usata come controllo aggiuntivo. */
export function systemRamMiB(): number {
  return Math.round(os.totalmem() / 1024 ** 2)
}
