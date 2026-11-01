import fs from 'node:fs'
import os from 'node:os'
import type { GpuDevice } from '../gpu/devices'
import { isMoeArch, readGgufHints } from './gguf'

const MiB = 1024 * 1024

export interface LaunchPlan {
  ctx: number
  kvType: 'f16' | 'q8_0' | 'q4_0'
  ngl: number
  batch: number
  ubatch: number
  mmprojOffload: boolean
  /** true = non passiamo -ngl e lasciamo che llama.cpp adatti i layer alla VRAM libera */
  autoFit: boolean
  threads: number
  notes: string[]
  estimate: { weightsMiB: number; kvMiB: number; overheadMiB: number; totalMiB: number; availableMiB: number }
}

interface PlanInput {
  device: GpuDevice | null
  contextSize: number
  kvPreference: 'f16' | 'q8_0'
  gpuLayers: number
  modelPath: string
  mmprojPath?: string
  autoTune: boolean
}

const ELEM_BYTES = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 } as const
const RESERVE_MIB = 1024 // desktop, driver, contesto finestra

function fileMiB(file?: string): number {
  if (!file) return 0
  try {
    return fs.statSync(file).size / MiB
  } catch {
    return 0
  }
}

/**
 * Sceglie i parametri di lancio in base a VRAM effettiva, dimensione dei pesi,
 * contesto richiesto e architettura (letta dall'header GGUF). Obiettivo: mai OOM.
 */
export function planLaunch(input: PlanInput): LaunchPlan {
  const notes: string[] = []
  const hints = readGgufHints(input.modelPath)
  const headDim = hints.keyLength || Math.ceil(hints.embeddingLength / Math.max(1, hints.headCount))
  const valueDim = hints.valueLength || headDim
  const layers = Math.max(1, hints.blockCount)
  // solo i layer con attenzione piena consumano KV cache (i modelli ibridi SSM ne hanno 1 su N)
  const kvLayers = Math.max(1, Math.min(layers, hints.attentionLayers))

  const weightsMiB = fileMiB(input.modelPath) + fileMiB(input.mmprojPath)
  // MoE: gli esperti possono restare in RAM, in GPU va ~55% dei pesi
  const moe = isMoeArch(hints.architecture)
  const vramWeightsMiB = moe ? weightsMiB * 0.55 : weightsMiB
  if (moe) {
    notes.push(`modello MoE (${hints.architecture}): esperti in CPU, in GPU ~${Math.round(vramWeightsMiB)} MiB`)
  }
  const available = input.device ? Math.max(0, input.device.vramMiB - RESERVE_MIB) : 0
  const overheadMiB = Math.max(450, Math.round(weightsMiB * 0.09))

  const kvMiB = (ctx: number, kv: keyof typeof ELEM_BYTES): number =>
    (kvLayers * hints.headCountKv * (headDim + valueDim) * ctx * ELEM_BYTES[kv]) / MiB

  const threads = Math.max(2, Math.min(16, Math.floor(os.cpus().length / 2)))

  if (!input.autoTune) {
    return {
      ctx: input.contextSize,
      kvType: input.kvPreference,
      ngl: input.gpuLayers,
      batch: 2048,
      ubatch: 512,
      mmprojOffload: true,
      autoFit: false,
      threads,
      notes: ['auto-tuning disattivato: uso i valori delle impostazioni'],
      estimate: {
        weightsMiB,
        kvMiB: kvMiB(input.contextSize, input.kvPreference),
        overheadMiB,
        totalMiB: weightsMiB + kvMiB(input.contextSize, input.kvPreference) + overheadMiB,
        availableMiB: available
      }
    }
  }

  let ctx = Math.max(2048, input.contextSize)
  let kvType: keyof typeof ELEM_BYTES = input.kvPreference
  let mmprojOffload = true
  let ngl = input.gpuLayers

  if (!input.device) {
    notes.push('nessuna GPU dedicata selezionata: parametri conservativi, offload completo')
    return {
      ctx,
      kvType,
      ngl,
      batch: 2048,
      ubatch: 256,
      mmprojOffload,
      autoFit: false,
      threads,
      notes,
      estimate: {
        weightsMiB,
        kvMiB: kvMiB(ctx, kvType),
        overheadMiB,
        totalMiB: weightsMiB + kvMiB(ctx, kvType) + overheadMiB,
        availableMiB: available
      }
    }
  }

  const fits = (
    c: number,
    kv: keyof typeof ELEM_BYTES,
    weights = vramWeightsMiB,
    offload = mmprojOffload
  ): boolean =>
    weights + kvMiB(c, kv) + overheadMiB <= available + (offload ? 0 : fileMiB(input.mmprojPath))

  // 1) contesto richiesto con il tipo KV preferito
  if (!fits(ctx, kvType)) {
    const chain: Array<keyof typeof ELEM_BYTES> = kvType === 'f16' ? ['q8_0', 'q4_0'] : ['q4_0']
    const better = chain.find((k) => fits(ctx, k))
    if (better) {
      notes.push(
        `VRAM insufficiente per KV ${kvType} a ${ctx} token: uso KV ${better} (contesto invariato)`
      )
      kvType = better
    } else {
      // 2) mmproj sulla CPU
      if (input.mmprojPath && !fits(ctx, kvType, vramWeightsMiB - fileMiB(input.mmprojPath))) {
        notes.push('VRAM stretta: mmproj (vision) spostato sulla CPU')
      }
      if (input.mmprojPath && fits(ctx, kvType, vramWeightsMiB - fileMiB(input.mmprojPath))) {
        mmprojOffload = false
        const lowered = (['q8_0', 'q4_0'] as Array<keyof typeof ELEM_BYTES>).find((k) =>
          fits(ctx, k, vramWeightsMiB - fileMiB(input.mmprojPath))
        )
        kvType = lowered ?? kvType
      }
    }
  }

  // 3) ancora fuori: riduco il contesto mantenendo la qualità del KV scelto
  const budget = available - (mmprojOffload ? vramWeightsMiB : vramWeightsMiB - fileMiB(input.mmprojPath)) - overheadMiB
  const perTokenMiB = kvMiB(1, kvType)
  if (budget > 0 && perTokenMiB > 0) {
    const maxCtx = Math.floor(budget / perTokenMiB)
    if (maxCtx < ctx) {
      const target = Math.max(2048, Math.floor(maxCtx / 1024) * 1024)
      notes.push(
        `contesto ridotto da ${ctx} a ${target} token per evitare OOM (VRAM libera stimata ${Math.round(available)} MiB)`
      )
      ctx = target
    }
  }

  // 4) ultima risorsa: offload parziale dei layer
  const totalNeeded =
    (mmprojOffload ? vramWeightsMiB : vramWeightsMiB - fileMiB(input.mmprojPath)) +
    kvMiB(ctx, kvType) +
    overheadMiB
  if (totalNeeded > available && weightsMiB > 0) {
    const ratio = Math.max(0, (available - kvMiB(ctx, kvType) - overheadMiB) / (weightsMiB || 1))
    ngl = Math.max(0, Math.min(input.gpuLayers, Math.floor(layers * ratio)))
    notes.push(`VRAM insufficiente: offload parziale ${ngl}/${layers} layer sulla GPU`)
  }

  const ubatch = ctx >= 32768 ? 512 : 256
  const batch = Math.min(2048, Math.max(512, ubatch * 4))

  const estimate = {
    weightsMiB: Math.round(mmprojOffload ? vramWeightsMiB : vramWeightsMiB - fileMiB(input.mmprojPath)),
    kvMiB: Math.round(kvMiB(ctx, kvType)),
    overheadMiB,
    totalMiB: Math.round(
      (mmprojOffload ? vramWeightsMiB : vramWeightsMiB - fileMiB(input.mmprojPath)) +
        kvMiB(ctx, kvType) +
        overheadMiB
    ),
    availableMiB: Math.round(available)
  }

  if (estimate.totalMiB > estimate.availableMiB) {
    notes.push(
      `stima ${estimate.totalMiB} MiB oltre i ${estimate.availableMiB} MiB disponibili: monitoro il primo avvio`
    )
  }

  // con auto-tuning lasciamo a llama.cpp la scelta dei layer da mettere in GPU:
  // è l'unico che conosce la VRAM realmente libera in quel momento
  return { ctx, kvType, ngl, batch, ubatch, mmprojOffload, autoFit: true, threads, notes, estimate }
}
