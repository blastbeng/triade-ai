import fs from 'node:fs'

export interface GgufHints {
  architecture: string
  blockCount: number
  /** layer con attenzione piena (i modelli ibridi SSM ne usano 1 ogni N) */
  attentionLayers: number
  embeddingLength: number
  headCount: number
  headCountKv: number
  keyLength: number
  valueLength: number
  hybrid: boolean
  /** contesto massimo dichiarato dal modello (0 = non dichiarato) */
  contextLength: number
}

/** Architetture con esperti (MoE): solo una parte dei pesi è attiva per token. */
export function isMoeArch(arch: string): boolean {
  return /moe|mixtral|deepseek2|gpt-?oss|granitemoe|phimoe|dbrx/i.test(arch)
}

const DEFAULTS: GgufHints = {
  architecture: 'unknown',
  blockCount: 32,
  attentionLayers: 32,
  embeddingLength: 4096,
  headCount: 32,
  headCountKv: 8,
  keyLength: 128,
  valueLength: 128,
  hybrid: false,
  contextLength: 0
}

const SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }

/**
 * Legge l'header GGUF (solo i metadati) per stimare con precisione la KV cache:
 * block_count, head_count_kv, key/value_length e, sui modelli ibridi, quanti layer
 * hanno attenzione piena.
 */
export function readGgufHints(file: string, maxBytes = 16 * 1024 * 1024): GgufHints {
  let fd: number | null = null
  try {
    const len = Math.min(fs.statSync(file).size, maxBytes)
    const buf = Buffer.alloc(len)
    fd = fs.openSync(file, 'r')
    fs.readSync(fd, buf, 0, len, 0)
    return parseGgufBuffer(buf)
  } catch {
    return DEFAULTS
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/** Interpreta un header GGUF già in memoria (file locale o primi MB scaricati via Range). */
export function parseGgufBuffer(buf: Buffer): GgufHints {
  try {
    const len = buf.length
    if (buf.toString('utf8', 0, 4) !== 'GGUF') return DEFAULTS

    let off = 16
    const kvCount = Number(buf.readBigUInt64LE(off))
    off += 8

    const readStr = (o: number): [string, number] => {
      const n = Number(buf.readBigUInt64LE(o))
      const start = o + 8
      return [buf.toString('utf8', start, start + n), start + n]
    }
    const scalar = (type: number, o: number): number => {
      switch (type) {
        case 0:
          return buf.readUInt8(o)
        case 1:
          return buf.readInt8(o)
        case 2:
          return buf.readUInt16LE(o)
        case 3:
          return buf.readInt16LE(o)
        case 4:
          return buf.readUInt32LE(o)
        case 5:
          return buf.readInt32LE(o)
        case 6:
          return buf.readFloatLE(o)
        case 7:
          return buf.readUInt8(o)
        case 10:
          return Number(buf.readBigUInt64LE(o))
        case 11:
          return Number(buf.readBigInt64LE(o))
        case 12:
          return buf.readDoubleLE(o)
        default:
          return 0
      }
    }

    const values: Record<string, number | string> = {}
    for (let i = 0; i < kvCount; i++) {
      try {
        if (off >= len - 8) break
        const [key, afterKey] = readStr(off)
        off = afterKey
        const type = buf.readUInt32LE(off)
        off += 4
        if (type === 8) {
          const [str, next] = readStr(off)
          values[key] = str.slice(0, 512)
          off = next
        } else if (type === 9) {
          const itemType = buf.readUInt32LE(off)
          off += 4
          const n = Number(buf.readBigUInt64LE(off))
          off += 8
          let first = 0
          for (let j = 0; j < n && off < len - 8; j++) {
            if (itemType === 8) {
              const [, next] = readStr(off)
              off = next
            } else {
              const v = scalar(itemType, off)
              if (j === 0) first = v
              off += SIZES[itemType] ?? 4
            }
          }
          values[key] = first
        } else {
          values[key] = scalar(type, off)
          off += SIZES[type] ?? 4
        }
      } catch {
        break
      }
    }

    const arch = String(values['general.architecture'] ?? 'unknown')
    const num = (suffix: string, fallback: number): number => {
      const v = values[`${arch}.${suffix}`]
      return typeof v === 'number' && Number.isFinite(v) ? v : fallback
    }

    const blockCount = num('block_count', DEFAULTS.blockCount)
    const interval = num('full_attention_interval', 0)
    const hybrid = interval > 1 || values[`${arch}.ssm.conv_kernel`] !== undefined
    const attentionLayers = interval > 1 ? Math.max(1, Math.ceil(blockCount / interval)) : blockCount

    return {
      architecture: arch,
      blockCount,
      attentionLayers,
      embeddingLength: num('embedding_length', DEFAULTS.embeddingLength),
      headCount: num('attention.head_count', DEFAULTS.headCount),
      headCountKv: num('attention.head_count_kv', DEFAULTS.headCountKv),
      keyLength: num('attention.key_length', 0),
      valueLength: num('attention.value_length', 0),
      hybrid,
      contextLength: num('context_length', 0)
    }
  } catch {
    return DEFAULTS
  }
}
