import fs from 'node:fs'
import type { GpuDevice } from '../gpu/devices'
import { isMoeArch, readGgufHints } from './gguf'

const MIB = 1024 * 1024
const RESERVE_MIB = 1024
const MIN_CTX = 2048

const ELEM_BYTES = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 } as const

export interface PoolTarget {
  key: string
  modelPath: string
  mmprojPath?: string
}

export interface PoolPlan {
  /** contesto assegnato a ciascun target (chiave = modelId|device) */
  contextByKey: Map<string, number>
  notes: string[]
}

function sizeMiB(file?: string): number {
  if (!file) return 0
  try {
    return fs.statSync(file).size / MIB
  } catch {
    return 0
  }
}

/** KV cache per token (MiB) del modello, letta dall'header GGUF. */
function kvPerTokenMiB(modelPath: string, kv: keyof typeof ELEM_BYTES): number {
  const hints = readGgufHints(modelPath)
  const headDim =
    hints.keyLength || Math.ceil(hints.embeddingLength / Math.max(1, hints.headCount))
  const valueDim = hints.valueLength || headDim
  const layers = Math.max(1, Math.min(hints.blockCount, hints.attentionLayers))
  return (layers * hints.headCountKv * (headDim + valueDim) * ELEM_BYTES[kv]) / MIB
}

/**
 * Ripartisce la VRAM di una GPU tra i modelli che ci girano contemporaneamente
 * (1, 2 o 3 chat con modelli diversi) e restituisce il contesto assegnabile a
 * ciascuno. Se nemmeno il minimo entra, solleva un errore esplicito: meglio
 * rifiutare che andare in OOM a metà dibattito.
 */
export function planPool(
  targets: PoolTarget[],
  device: GpuDevice,
  requestedCtx: number,
  kv: keyof typeof ELEM_BYTES
): PoolPlan {
  const notes: string[] = []
  const contextByKey = new Map<string, number>()
  if (!targets.length) return { contextByKey, notes }

  const available = Math.max(0, Math.min(device.vramMiB - RESERVE_MIB, device.freeMiB || device.vramMiB))
  const weights = targets.reduce((sum, t) => {
    const w = sizeMiB(t.modelPath) + sizeMiB(t.mmprojPath)
    // MoE: in GPU va solo la parte attiva/shared, gli esperti restano in RAM
    return sum + (isMoeArch(readGgufHints(t.modelPath).architecture) ? w * 0.55 : w)
  }, 0)
  const overheads = targets.reduce(
    (sum, t) => sum + Math.max(400, sizeMiB(t.modelPath) * 0.09),
    0
  )
  const kvBudget = available - weights - overheads

  if (kvBudget <= 0) {
    throw new Error(
      `VRAM insufficiente su ${device.name}: i pesi dei ${targets.length} modelli occupano ${Math.round(
        weights
      )} MiB su ${Math.round(available)} MiB disponibili. Riduci il numero di modelli diversi (o usa lo stesso modello per più chat).`
    )
  }

  const minNeed = targets.reduce((sum, t) => sum + kvPerTokenMiB(t.modelPath, kv) * MIN_CTX, 0)
  if (minNeed > kvBudget) {
    throw new Error(
      `VRAM insufficiente su ${device.name} per ${targets.length} modelli contemporanei: servono almeno ${Math.round(
        minNeed
      )} MiB di KV cache oltre ai pesi, ne restano ${Math.round(kvBudget)}. Usa lo stesso modello per più chat o libera VRAM.`
    )
  }

  const share = kvBudget / targets.length
  for (const target of targets) {
    const perToken = kvPerTokenMiB(target.modelPath, kv)
    const ctx = Math.max(MIN_CTX, Math.min(requestedCtx, Math.floor(share / perToken)))
    contextByKey.set(target.key, ctx)
    if (ctx < requestedCtx) {
      notes.push(
        `${target.key}: contesto ridotto a ${ctx} token per far convivere ${targets.length} modelli su ${device.name}`
      )
    }
  }

  if (targets.length > 1) {
    notes.push(
      `${targets.length} modelli diversi su ${device.name}: ${Math.round(weights)} MiB di pesi, ${Math.round(
        kvBudget
      )} MiB di KV condivisa`
    )
  }

  return { contextByKey, notes }
}
