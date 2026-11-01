import { execFile, execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { findBinary } from '../paths'
import { parseDevices, parseVulkaninfoSummary, type Backend, type GpuDevice } from './parse'
import { log } from '../log'

export type { Backend, GpuDevice } from './parse'

export interface DetectedGpus {
  usable: GpuDevice[]
  excluded: GpuDevice[]
  backends: Backend[]
  error?: string
}

export function llamaBinaryFor(backend: Backend): string | null {
  // CUDA non è supportato: qualunque GPU passa da Vulkan
  if (backend === 'cuda') return null
  const found = findBinary('llama-server')
  if (found) return found
  // layout alternativi (pacchetto Windows: resources/bin/win, bin/vulkan, …):
  // senza binario la GPU risulterebbe "non trovata" pur essendoci
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const roots = [
    process.resourcesPath ?? '',
    path.join(process.resourcesPath ?? '', 'bin'),
    path.join(process.cwd(), 'bin'),
    path.join(path.dirname(process.execPath), 'bin')
  ].filter(Boolean)
  const subs = ['', 'win', 'vulkan', 'linux']
  for (const root of roots) {
    for (const sub of subs) {
      const candidate = path.join(root, sub, exe)
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

function run(exe: string, args: string[], timeout = 20000): string {
  try {
    return execFileSync(exe, args, { timeout, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}

function runAsync(exe: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout: 20000, windowsHide: true }, (err, stdout, stderr) =>
      resolve(`${stdout ?? ''}${stderr ?? ''}`)
    )
  })
}

/** Dedicated VRAM per adattatore, secondo il sistema operativo (Windows: WMI). */
function windowsDedicatedVram(): Map<string, number> {
  const map = new Map<string, number>()
  if (process.platform !== 'win32') return map
  const script =
    'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress'
  const text = run('powershell', ['-NoProfile', '-Command', script], 20000)
  try {
    const parsed = JSON.parse(text)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    for (const row of rows) {
      if (!row?.Name) continue
      map.set(String(row.Name), Number(row.AdapterRAM ?? 0) / (1024 * 1024))
    }
  } catch {
    /* WMI non disponibile: si prosegue con le altre evidenze */
  }
  return map
}

/**
 * Classificazione dinamica: nessun nome di GPU nel codice.
 * 1. tipo dichiarato dal driver Vulkan (vulkaninfo), se disponibile;
 * 2. memoria dedicata riportata dal sistema (Windows/WMI);
 * 3. euristica sulla memoria condivisa: con più GPU presenti, un adattatore che
 *    espone come "device local" gran parte della RAM di sistema è una iGPU.
 */
function classify(devices: GpuDevice[]): GpuDevice[] {
  const totalRamMiB = os.totalmem() / (1024 * 1024)
  const summary = process.platform === 'linux' ? parseVulkaninfoSummary(run('vulkaninfo', ['--summary'])) : new Map()
  const dedicated = windowsDedicatedVram()

  return devices.map((dev) => {
    const vk = [...summary.entries()].find(([name]) => dev.name.includes(name) || name.includes(dev.name))
    if (vk && vk[1] === 'integrated') {
      return { ...dev, integrated: true, reason: 'tipo di dispositivo dichiarato dal driver (integrata)' }
    }
    if (vk && vk[1] === 'discrete') {
      return { ...dev, integrated: false, reason: 'tipo di dispositivo dichiarato dal driver (dedicata)' }
    }
    const wmi = [...dedicated.entries()].find(([name]) => dev.name.includes(name) || name.includes(dev.name))
    if (wmi) {
      if (wmi[1] > 0 && wmi[1] < 1024) {
        return { ...dev, integrated: true, reason: `memoria dedicata ${Math.round(wmi[1])} MiB (condivisa)` }
      }
      return { ...dev, integrated: false, reason: `memoria dedicata ${Math.round(wmi[1])} MiB` }
    }
    if (devices.length > 1 && dev.vramMiB > totalRamMiB * 0.4) {
      return {
        ...dev,
        integrated: true,
        reason: `espone ${Math.round(dev.vramMiB)} MiB su ${Math.round(totalRamMiB)} MiB di RAM (memoria condivisa)`
      }
    }
    return dev
  })
}

/** GPU migliore a parità di scelta esplicita: Vulkan preferito, poi più VRAM libera. */
export function bestDevice(list: GpuDevice[]): GpuDevice | null {
  if (!list.length) return null
  return [...list].sort((a, b) => {
    const score = (d: GpuDevice): number => (d.backend === 'vulkan' ? 1e9 : 0) + d.freeMiB
    return score(b) - score(a)
  })[0]
}

let cache: { at: number; value: DetectedGpus } | null = null

export async function detectGpus(force = false): Promise<DetectedGpus> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.value

  const found: GpuDevice[] = []
  const backends: Backend[] = []

  for (const backend of ['vulkan'] as Backend[]) {
    const exe = llamaBinaryFor(backend)
    if (!exe) continue
    backends.push(backend)
    const text = await runAsync(exe, ['--list-devices'])
    for (const d of parseDevices(text, backend)) {
      // stessa scheda su backend diversi = due voci scegliibili (Vulkan e CUDA)
      if (found.some((f) => f.name === d.name && f.backend === d.backend)) continue
      found.push(d)
    }
  }

  const classified = classify(found)
  let diag = ''
  if (!classified.length) {
    const exe = llamaBinaryFor('vulkan')
    diag = exe
      ? `binario: ${exe} — risposta di --list-devices: ${(await runAsync(exe, ['--list-devices'])).slice(0, 300) || '(vuota)'}`
      : 'binario llama-server non trovato accanto all\'app: i file in bin/ non sono stati inclusi nel pacchetto'
    log.error(`[gpu] nessuna GPU: ${diag}`)
  }
  // Windows: se llama-server non enumera (DLL Vulkan vicine all'exe, percorso,
  // permessi) le schede si ricavano dal driver via WMI. L'unico backend che
  // spediamo è Vulkan, quindi una GPU dedicata va comunque proposta.
  if (!classified.some((d) => !d.integrated) && process.platform === 'win32') {
    const wmi = windowsDedicatedVram()
    let i = 0
    for (const [name, mb] of wmi) {
      if (!(mb >= 512)) continue
      const dev: GpuDevice = {
        key: `vulkan:${i}`,
        label: name,
        backend: 'vulkan',
        index: i,
        name,
        vramMiB: Math.round(mb),
        freeMiB: Math.round(mb),
        integrated: false,
        estimated: true
      }
      classified.push(dev)
      log.info(`[gpu] rilevamento da WMI: ${name} (${Math.round(mb)} MiB)`)
      i++
    }
  }

  const value: DetectedGpus = {
    usable: classified.filter((d) => !d.integrated && d.backend !== 'cuda'),
    excluded: classified.filter((d) => d.integrated),
    backends,
    error: classified.length ? undefined : `nessuna GPU Vulkan rilevata (CUDA e ROCm/HIP non sono supportati) — ${diag}`
  }
  cache = { at: Date.now(), value }
  return value
}

export function hasCudaBuild(): boolean {
  return false
}
