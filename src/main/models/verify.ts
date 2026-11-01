import fs from 'node:fs'

export interface GgufCheck {
  ok: boolean
  reason?: string
  bytes?: number
  tensors?: number
}

/**
 * Controllo di integrità dell'header GGUF: intercetta i file troncati o
 * sovrascritti che il solo confronto di dimensione non vede.
 */
export function validateGgufFile(file: string): GgufCheck {
  if (!fs.existsSync(file)) return { ok: false, reason: 'file assente' }
  const bytes = fs.statSync(file).size
  if (bytes < 1024 * 1024) return { ok: false, reason: `file troppo piccolo (${bytes} byte)`, bytes }
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(24)
    const read = fs.readSync(fd, head, 0, 24, 0)
    if (read < 24) return { ok: false, reason: 'header incompleto', bytes }
    if (head.subarray(0, 4).toString('ascii') !== 'GGUF') {
      return { ok: false, reason: 'non è un file GGUF (magic assente)', bytes }
    }
    const version = head.readUInt32LE(4)
    if (version < 1 || version > 4) return { ok: false, reason: `versione GGUF inattesa (${version})`, bytes }
    const tensors = Number(head.readBigUInt64LE(8))
    const kv = Number(head.readBigUInt64LE(16))
    if (!Number.isFinite(tensors) || tensors <= 0 || tensors > 1_000_000) {
      return { ok: false, reason: `numero di tensori non plausibile (${tensors})`, bytes }
    }
    if (!Number.isFinite(kv) || kv > 1_000_000) {
      return { ok: false, reason: `metadati non plausibili (${kv})`, bytes }
    }
    // la coda del file deve essere leggibile: un troncamento a metà lo impedisce
    const tail = Buffer.alloc(16)
    fs.readSync(fd, tail, 0, 16, Math.max(0, bytes - 16))
    return { ok: true, bytes, tensors }
  } catch (err) {
    return { ok: false, reason: (err as Error).message, bytes }
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}
