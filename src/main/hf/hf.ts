import os from 'node:os'
import type { GpuDevice } from '../gpu/devices'
import { isMoeArch, parseGgufBuffer, type GgufHints } from '../llama/gguf'

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
  /** tutti i pesi in VRAM */
  fits: boolean
  /** MoE: pesi in RAM, esperti su CPU, attenzione in VRAM */
  fitsPartial: boolean
  /** contesto massimo utilizzabile in questo modo (token) */
  ctxFull: number
  ctxPartial: number
}

export type RunMode = 'full' | 'partial' | 'none'

export interface HfVerdict {
  repo: string
  name: string
  paramsB: number
  vision: boolean
  /** modello con esperti (MoE): può girare anche con offload parziale */
  moe: boolean
  mode: RunMode
  /** contesto consigliato per il quant scelto */
  contextSuggestion: number
  arch: string
  /** RAM necessaria per tenere i pesi quando gli esperti vanno su CPU */
  ramNeededMiB: number
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

/** KV per token letta dall'header GGUF (precisa anche per MoE e modelli ibridi). */
function kvPerTokenFromHints(hints: GgufHints): number {
  const headDim = hints.keyLength || Math.ceil(hints.embeddingLength / Math.max(1, hints.headCount))
  const valueDim = hints.valueLength || headDim
  const layers = Math.max(1, Math.min(hints.blockCount, hints.attentionLayers))
  // 1.0625 = byte per elemento con KV q8_0
  return (layers * hints.headCountKv * (headDim + valueDim) * 1.0625) / 1024 ** 2
}

/** Scarica solo i primi MB del GGUF per leggere l'header senza attendere il download completo. */
async function remoteHints(url: string): Promise<GgufHints | null> {
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-8388607', 'User-Agent': 'triade-ai' },
      signal: AbortSignal.timeout(25000)
    })
    if (!res.ok) return null
    const hints = parseGgufBuffer(Buffer.from(await res.arrayBuffer()))
    return hints.architecture === 'unknown' ? null : hints
  } catch {
    return null
  }
}

function looksMoe(repo: string, arch: string, file: string): boolean {
  if (isMoeArch(arch)) return true
  return /\b(?:A|E)\d+(?:\.\d+)?B\b/i.test(`${repo} ${file}`) || /\b\d+x\d+B\b/i.test(`${repo} ${file}`)
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

  // header del modello (un solo Range): KV esatta anche per MoE/ibridi, prima del download
  const smallest = ggufs.length ? ggufs.reduce((a, b) => (a.size < b.size ? a : b)) : null
  const hints = smallest
    ? await remoteHints(`https://huggingface.co/${repo}/resolve/main/${encodeURI(smallest.path)}`)
    : null
  const arch = hints?.architecture ?? 'unknown'
  const moe = looksMoe(repo, arch, smallest?.path ?? '')
  const ramMiB = systemRamMiB()

  const variants: QuantVariant[] = []
  const seen = new Set<string>()
  for (const file of ggufs.sort((a, b) => b.size - a.size)) {
    const label = (QUANT_RE.exec(file.path)?.[1]?.toUpperCase() ?? 'GGUF').replace(/^UD-/, '')
    if (seen.has(label)) continue
    seen.add(label)
    const nameParams = paramsFromName(`${repo} ${file.path}`)
    const paramsB = nameParams || Math.max(0.5, file.size / 1e9 / 0.6)
    const overheadMiB = 450 + (file.size / 1024 ** 2) * 0.08
    const perToken = hints ? kvPerTokenFromHints(hints) : kvPerTokenMiB(paramsB)
    const kvMiB = (perToken * compat.contextSize) / Math.max(1, compat.concurrentModels ?? 1)
    const weightsMiB = file.size / 1024 ** 2 + (mmproj?.size ?? 0) / 1024 ** 2
    const totalMiB = Math.round(weightsMiB + kvMiB + overheadMiB)
    const available = compat.device ? compat.device.vramMiB - RESERVE_MIB : 0

    // MoE: gli esperti possono restare in RAM, in GPU vanno attenzione + shared (~55%)
    const budgetFull = available - weightsMiB - overheadMiB
    const budgetPartial = available - weightsMiB * 0.55 - overheadMiB * 0.6
    const ctxFull = perToken > 0 ? Math.floor(budgetFull / perToken) : 0
    const ctxPartial = perToken > 0 ? Math.floor(budgetPartial / perToken) : 0
    const ramNeededMiB = Math.round(weightsMiB + 800)

    variants.push({
      quant: label,
      file: file.path,
      bytes: file.size,
      totalMiB,
      fits: available > 0 && ctxFull >= compat.contextSize,
      fitsPartial:
        moe &&
        available > 0 &&
        ctxPartial >= (compat.contextSize >= 32768 ? 16384 : 8192) &&
        ramMiB > 0 &&
        ramNeededMiB <= ramMiB * 0.8,
      ctxFull: Math.max(0, ctxFull),
      ctxPartial: Math.max(0, ctxPartial)
    })
  }

  const fitting = variants.filter((v) => v.fits).sort((a, b) => b.bytes - a.bytes)
  const partials = variants.filter((v) => v.fitsPartial).sort((a, b) => b.bytes - a.bytes)
  const best = fitting[0] ?? (moe ? partials[0] : undefined) ?? null
  const mode: RunMode = !best ? 'none' : best.fits ? 'full' : 'partial'
  const contextSuggestion = !best
    ? 0
    : Math.min(
        compat.contextSize,
        Math.max(2048, Math.floor((best.fits ? best.ctxFull : best.ctxPartial) / 1024) * 1024)
      )
  const smallestVariant = variants.length ? variants.reduce((a, b) => (a.bytes < b.bytes ? a : b)) : null
  const available = compat.device ? Math.round(compat.device.vramMiB - RESERVE_MIB) : 0
  const ramNeededMiB = best ? Math.round(best.bytes / 1024 ** 2 + 800) : 0

  let reason = ''
  let ok = false
  if (!files.length) reason = 'file del repository non leggibili (repo privato o inaccessibile)'
  else if (!mmproj) {
    reason = 'nessun file mmproj: il modello non supporta le immagini/video, quindi è escluso'
  } else if (!variants.length) reason = 'nessun quant GGUF utilizzabile nel repository'
  else if (!best) {
    reason = moe
      ? `MoE ma non entra: il più piccolo (${smallestVariant?.quant}) chiede ${smallestVariant?.totalMiB} MiB di VRAM (${available} disponibili) e in RAM servirebbero ${Math.round(
          (smallestVariant?.bytes ?? 0) / 1024 ** 2 + 800
        )} MiB su ${ramMiB}`
      : `nessun quant entra nella VRAM: il più piccolo (${smallestVariant?.quant}) richiede ${smallestVariant?.totalMiB} MiB, disponibili ${available} MiB`
  } else {
    ok = true
    if (mode === 'full') {
      reason = `usabile, tutto in GPU: ${best.quant} occupa circa ${best.totalMiB} MiB su ${available} MiB`
      if (best.quant !== variants[0].quant) {
        reason += ` — il quant più grande (${variants[0].quant}) non entrerebbe`
      }
    } else {
      reason =
        `usabile con offload parziale (MoE): ${best.quant} tiene gli esperti in CPU — ` +
        `~${Math.round((best.bytes / 1024 ** 2) * 0.55)} MiB di VRAM su ${available} MiB, ` +
        `contesto consigliato ${contextSuggestion} token`
      if (contextSuggestion < compat.contextSize) {
        reason += ` (i ${compat.contextSize} pieni non entrerebbero)`
      }
    }
    if (visionTag && !mmproj) reason += ' (tag vision senza projector)'
  }

  return {
    repo,
    name,
    paramsB: paramsFromName(`${repo} ${best?.file ?? ''}`) || 0,
    vision: Boolean(mmproj),
    moe,
    mode,
    arch,
    ramNeededMiB,
    quant: best?.quant ?? null,
    modelFile: best?.file ?? null,
    contextSuggestion,
    mmprojFile: mmproj?.path ?? null,
    mmprojBytes: mmproj?.size ?? 0,
    downloadBytes: (best?.bytes ?? 0) + (mmproj?.size ?? 0),
    totalMiB: best?.totalMiB ?? smallestVariant?.totalMiB ?? 0,
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
