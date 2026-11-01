import fs from 'node:fs'
import path from 'node:path'
import { cacheDir } from './paths'

const MAX_LOG_BYTES = 5 * 1024 * 1024
const KEEP = 3

/** Ruota un log quando supera 5 MB: file, file.1, file.2 (max 3 copie). */
export function rotateLog(file: string): void {
  try {
    if (!fs.existsSync(file)) return
    if (fs.statSync(file).size < MAX_LOG_BYTES) return
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`
      const to = `${file}.${i}`
      if (fs.existsSync(from)) {
        fs.rmSync(to, { force: true })
        fs.renameSync(from, to)
      }
    }
    fs.writeFileSync(file, '')
  } catch {
    /* best effort: un log che non ruota non deve mai fermare l'app */
  }
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/**
 * Svuota la cache (frame video, pagine web) quando cresce troppo o è vecchia.
 * Ritorna i byte liberati.
 */
export function evictCache(maxBytes = 2 * 1024 ** 3, maxAgeDays = 30): number {
  const dir = cacheDir()
  if (!fs.existsSync(dir)) return 0
  const now = Date.now()
  const maxAge = maxAgeDays * 24 * 60 * 60 * 1000
  let freed = 0
  const files: { file: string; size: number; mtime: number }[] = []
  for (const file of walk(dir)) {
    try {
      const st = fs.statSync(file)
      files.push({ file, size: st.size, mtime: st.mtimeMs })
    } catch {
      /* ignore */
    }
  }
  // prima i file scaduti
  for (const f of files) {
    if (now - f.mtime > maxAge) {
      try {
        fs.rmSync(f.file, { force: true })
        freed += f.size
      } catch {
        /* ignore */
      }
    }
  }
  const alive = files.filter((f) => now - f.mtime <= maxAge)
  let total = alive.reduce((n, f) => n + f.size, 0)
  if (total <= maxBytes) return freed
  // poi i più vecchi finché si rientra nel budget
  alive.sort((a, b) => a.mtime - b.mtime)
  for (const f of alive) {
    if (total <= maxBytes) break
    try {
      fs.rmSync(f.file, { force: true })
      total -= f.size
      freed += f.size
    } catch {
      /* ignore */
    }
  }
  return freed
}
