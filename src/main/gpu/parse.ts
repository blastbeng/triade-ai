export type Backend = 'vulkan' | 'cuda' | 'other'
// 'cuda' resta nel tipo solo perché llama.cpp lo può stampare: le GPU CUDA
// vengono scartate, tutto passa da Vulkan (AMD e NVIDIA).

export interface GpuDevice {
  key: string
  label: string
  backend: Backend
  index: number
  name: string
  vramMiB: number
  freeMiB: number
  /** dedotto dinamicamente (tipo riportato dal driver, memoria dedicata, condivisione RAM) */
  integrated: boolean
  /** VRAM dedotta dal driver (non misurata): può essere troncata a 4 GiB */
  estimated?: boolean
  reason?: string
}

/** Interpreta l'output di `llama-server --list-devices`. */
export function parseDevices(text: string, backend: Backend): GpuDevice[] {
  const out: GpuDevice[] = []
  const re = /^\s{2}([A-Za-z]+)(\d+):\s+(.+?)\s+\((\d+) MiB,\s+(\d+) MiB free\)\s*$/
  for (const line of text.split('\n')) {
    const m = re.exec(line)
    if (!m) continue
    const [, tag, idxRaw, name, total, free] = m
    if (/^CPU$/i.test(tag)) continue
    const index = Number(idxRaw)
    out.push({
      key: `${backend}:${index}`,
      label: `${tag}${index}`,
      backend,
      index,
      name: name.trim(),
      vramMiB: Number(total),
      freeMiB: Number(free),
      integrated: false
    })
  }
  return out
}

/** `vulkaninfo --summary`: tipo di GPU dichiarato dal driver (INTEGRATED_GPU / DISCRETE_GPU). */
export function parseVulkaninfoSummary(text: string): Map<string, 'integrated' | 'discrete' | 'other'> {
  const map = new Map<string, 'integrated' | 'discrete' | 'other'>()
  // in vulkaninfo il deviceType precede il deviceName nello stesso blocco GPU
  let pending: 'integrated' | 'discrete' | 'other' | null = null
  for (const line of text.split('\n')) {
    const t = /deviceType\s*=\s*(.+)$/.exec(line)
    if (t) {
      const type = t[1].trim()
      pending = type.includes('INTEGRATED') ? 'integrated' : type.includes('DISCRETE') ? 'discrete' : 'other'
    }
    const n = /deviceName\s*=\s*(.+)$/.exec(line)
    if (n && pending) {
      map.set(n[1].trim(), pending)
      pending = null
    }
  }
  return map
}
