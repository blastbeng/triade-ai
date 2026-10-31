import { execFile } from 'node:child_process'
import { findBinary } from '../paths'
import { parseDevices, type Backend, type GpuDevice } from './parse'

export type { Backend, GpuDevice } from './parse'

export interface DetectedGpus {
  usable: GpuDevice[]
  excluded: GpuDevice[]
  backends: Backend[]
  error?: string
}

export function llamaBinaryFor(backend: Backend): string | null {
  if (backend === 'cuda') return findBinary('cuda/llama-server')
  return findBinary('llama-server')
}



function runList(exe: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(exe, ['--list-devices'], { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
      resolve(`${stdout ?? ''}${stderr ?? ''}` || (err ? '' : ''))
    })
  })
}

let cache: { at: number; value: DetectedGpus } | null = null

/**
 * Elenca le GPU realmente utilizzabili. Le integrate vengono riconosciute dal nome
 * (Raphael/Mendocino, Intel iGPU, llvmpipe) ed escluse dalla selezione.
 */
export async function detectGpus(force = false): Promise<DetectedGpus> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.value
  const found: GpuDevice[] = []
  const backends: Backend[] = []
  let error: string | undefined

  for (const backend of ['vulkan', 'cuda'] as Backend[]) {
    const exe = llamaBinaryFor(backend)
    if (!exe) continue
    backends.push(backend)
    const text = await runList(exe)
    const devices = parseDevices(text, backend)
    if (!devices.length) continue
    for (const d of devices) {
      if (found.some((f) => f.name === d.name)) continue
      found.push(d)
    }
  }

  if (!found.length) error = 'nessuna GPU rilevata (manca la build llama.cpp o il driver Vulkan)'

  const value: DetectedGpus = {
    usable: found.filter((d) => !d.integrated),
    excluded: found.filter((d) => d.integrated),
    backends,
    error
  }
  cache = { at: Date.now(), value }
  return value
}

export function hasCudaBuild(): boolean {
  return Boolean(findBinary('cuda/llama-server'))
}
