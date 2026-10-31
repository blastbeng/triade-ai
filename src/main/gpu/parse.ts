export type Backend = 'vulkan' | 'cuda' | 'other'

export interface GpuDevice {
  key: string
  label: string
  backend: Backend
  index: number
  name: string
  vramMiB: number
  freeMiB: number
  integrated: boolean
}

const IGPU_PATTERNS = [
  /\(RADV (RAPHAEL|RENOIR|CEZANNE|PICASSO|BARCELO|MENDOCINO|VANGOGH|REM\s?BRANDT)/i,
  /Ryzen.*(Processor|Graphics)/i,
  /Intel.*(Graphics|UHD|Iris)/i,
  /llvmpipe|lavapipe|software rasterizer|Microsoft Basic Render/i,
  /Apple M\d/i
]

export function isIntegrated(name: string): boolean {
  return IGPU_PATTERNS.some((p) => p.test(name))
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
      integrated: isIntegrated(name)
    })
  }
  return out
}
