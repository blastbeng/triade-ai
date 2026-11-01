import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { memoryDir } from '../paths'
import { DIM, cosine, embed } from './embeddings'
import { embedTexts } from './embed-client'

export type MemoryKind = 'turno' | 'sintesi' | 'fatto' | 'documento'

export interface MemoryEntry {
  id: string
  text: string
  kind: MemoryKind
  sessionId: string
  topic: string
  ts: number
}

export interface MemoryHit extends MemoryEntry {
  score: number
}

interface Meta {
  version: number
  dim: number
  entries: MemoryEntry[]
  hashes: string[]
}

/**
 * Vector store persistente su disco (dati/memoria):
 *  - meta.json  : testi + metadati
 *  - vettori.f32: matrice dei vettori, un Float32Array dopo l'altro
 */
/** due testi sono confrontabili solo se hanno la stessa dimensione */
let activeDim = DIM

class VectorMemory {
  private entries: MemoryEntry[] = []
  private vectors: Float32Array[] = []
  private hashes = new Set<string>()
  private loaded = false
  private embedderTag = 'hash-768'
  private reindexTimer: NodeJS.Timeout | null = null
  private needsReindex = false

  private scheduleReindex(): void {
    if (this.reindexTimer) return
    this.reindexTimer = setTimeout(() => {
      this.reindexTimer = null
      void this.reindex()
    }, 4000)
  }
  private dirty = false
  private saveTimer: NodeJS.Timeout | null = null

  /**
   * Sceglie il motore di embedding (modello Qwen3 di default, remoto se configurato).
   * Se il motore cambia, i vettori esistenti vengono ricalcolati.
   */
  async prepare(): Promise<void> {
    const { getSettings } = await import('../settings')
    const s = getSettings()
    const tag = `${s.embeddings.engine}:${s.embeddings.model || 'default'}`
    const probe = await embedTexts(['probe'])
    const dim = probe?.[0]?.length ?? DIM
    this.embedderTag = probe ? tag : 'hash-768'
    const changed = Math.abs(dim - activeDim) > 0 || this.embedderTag !== this.persistedEmbedder()
    activeDim = dim
    if (changed) await this.reindex()
  }

  private persistedEmbedder(): string {
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaFile(), 'utf8')) as { embedder?: string }
      return meta.embedder ?? 'hash-768'
    } catch {
      return 'hash-768'
    }
  }

  /** Ricalcola tutti i vettori con il motore corrente (una passata, a batch). */
  async reindex(): Promise<void> {
    this.load()
    if (!this.entries.length) {
      this.dirty = true
      return
    }
    const vectors = await embedTexts(this.entries.map((e) => e.text))
    this.vectors = this.entries.map((entry, i) => {
      const vec = vectors?.[i]
      return vec && vec.length ? vec : embed(entry.text)
    })
    activeDim = this.vectors[0]?.length ?? DIM
    this.dirty = true
    this.save(true)
  }

  private metaFile(): string {
    return path.join(memoryDir(), 'meta.json')
  }

  private vecFile(): string {
    return path.join(memoryDir(), 'vettori.f32')
  }

  load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!fs.existsSync(this.metaFile()) || !fs.existsSync(this.vecFile())) return
      const meta = JSON.parse(fs.readFileSync(this.metaFile(), 'utf8')) as Meta
      const buf = fs.readFileSync(this.vecFile())
      const n = meta.entries.length
      if (!n) return
      // dimensione dei vettori salvati: se non coincide con quella attuale
      // (cambio di motore di embedding) si ricarica solo il testo e si ri-indicizza
      const dim = Math.floor(buf.byteLength / n / 4)
      if (!Number.isFinite(dim) || dim < 8) return
      if (dim !== DIM && dim !== activeDim) {
        this.entries = meta.entries
        this.hashes = new Set(meta.hashes)
        this.vectors = meta.entries.map(() => new Float32Array(0))
        this.needsReindex = true
        return
      }
      const need = n * dim * 4
      if (buf.byteLength < need) {
        // file parziale: si tiene solo il testo e si ri-indicizza
        this.entries = meta.entries
        this.hashes = new Set(meta.hashes)
        this.vectors = meta.entries.map(() => new Float32Array(0))
        this.needsReindex = true
        return
      }
      const flat = new Float32Array(
        buf.buffer.slice(buf.byteOffset, Math.min(buf.byteOffset + need, buf.byteOffset + buf.byteLength))
      )
      this.entries = meta.entries
      this.hashes = new Set(meta.hashes)
      this.vectors = []
      for (let i = 0; i < n; i++) this.vectors.push(flat.subarray(i * DIM, (i + 1) * DIM))
    } catch {
      this.entries = []
      this.vectors = []
      this.hashes = new Set()
    }
  }

  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, 1200)
  }

  save(force = false): void {
    if (!this.dirty && !force) return
    this.load()
    const dir = memoryDir()
    fs.mkdirSync(dir, { recursive: true })
    const n = this.entries.length
    const flat = new Float32Array(n * DIM)
    for (let i = 0; i < n; i++) flat.set(this.vectors[i], i * DIM)
    const tmpVec = `${this.vecFile()}.tmp`
    fs.writeFileSync(tmpVec, Buffer.from(flat.buffer))
    fs.renameSync(tmpVec, this.vecFile())
    const meta: Meta = {
      version: 1,
      dim: DIM,
      entries: this.entries,
      hashes: [...this.hashes]
    }
    const tmpMeta = `${this.metaFile()}.tmp`
    fs.writeFileSync(tmpMeta, JSON.stringify(meta), 'utf8')
    fs.renameSync(tmpMeta, this.metaFile())
    this.dirty = false
  }

  add(items: Array<Omit<MemoryEntry, 'id' | 'ts'> & { id?: string; ts?: number }>): number {
    this.load()
    let added = 0
    for (const item of items) {
      const text = item.text.trim()
      if (text.length < 24) continue
      const hash = createHash('sha1').update(text).digest('hex')
      if (this.hashes.has(hash)) continue
      this.hashes.add(hash)
      this.entries.push({
        id: item.id ?? randomUUID(),
        text,
        kind: item.kind,
        sessionId: item.sessionId,
        topic: item.topic,
        ts: item.ts ?? Date.now()
      })
      const provisional = this.embedderTag === 'hash-768' ? embed(text) : new Float32Array(activeDim)
      this.vectors.push(provisional)
      if (this.embedderTag !== 'hash-768') this.scheduleReindex()
      added++
    }
    if (added) this.scheduleSave()
    return added
  }

  search(query: string, k = 6, excludeSessionId?: string): MemoryHit[] {
    this.load()
    if (!query.trim() || !this.entries.length) return []
    const q = embed(query)
    const scored: MemoryHit[] = []
    for (let i = 0; i < this.entries.length; i++) {
      if (excludeSessionId && this.entries[i].sessionId === excludeSessionId) continue
      const score = cosine(q, this.vectors[i])
      if (score > 0.12) scored.push({ ...this.entries[i], score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }

  recent(limit = 40): MemoryEntry[] {
    this.load()
    return [...this.entries].sort((a, b) => b.ts - a.ts).slice(0, limit)
  }

  stats(): { entries: number; byKind: Record<string, number>; bytes: number; lastTs: number } {
    this.load()
    const byKind: Record<string, number> = {}
    for (const e of this.entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
    let bytes = 0
    try {
      bytes =
        (fs.existsSync(this.vecFile()) ? fs.statSync(this.vecFile()).size : 0) +
        (fs.existsSync(this.metaFile()) ? fs.statSync(this.metaFile()).size : 0)
    } catch {
      bytes = 0
    }
    return {
      entries: this.entries.length,
      byKind,
      bytes,
      lastTs: this.entries.reduce((m, e) => Math.max(m, e.ts), 0)
    }
  }

  clear(): void {
    this.load()
    this.entries = []
    this.vectors = []
    this.hashes = new Set()
    this.dirty = true
    this.save(true)
  }

  /** Rimuove singole voci (dalla pagina memoria condivisa). */
  removeEntries(ids: string[]): number {
    this.load()
    const drop = new Set(ids)
    if (!drop.size) return 0
    const keepEntries: MemoryEntry[] = []
    const keepVectors: Float32Array[] = []
    for (let i = 0; i < this.entries.length; i++) {
      if (drop.has(this.entries[i].id)) continue
      keepEntries.push(this.entries[i])
      keepVectors.push(this.vectors[i])
    }
    const removed = this.entries.length - keepEntries.length
    if (!removed) return 0
    this.entries = keepEntries
    this.vectors = keepVectors
    this.hashes = new Set(keepEntries.map((e) => createHash('sha1').update(e.text).digest('hex')))
    this.dirty = true
    this.save(true)
    return removed
  }

  /** Rimuove le voci di una sessione eliminata. */
  removeSession(sessionId: string): void {
    this.load()
    const keepEntries: MemoryEntry[] = []
    const keepVectors: Float32Array[] = []
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i].sessionId === sessionId) continue
      keepEntries.push(this.entries[i])
      keepVectors.push(this.vectors[i])
    }
    this.entries = keepEntries
    this.vectors = keepVectors
    this.hashes = new Set(
      keepEntries.map((e) => createHash('sha1').update(e.text).digest('hex'))
    )
    this.dirty = true
    this.save(true)
  }
}

export const memory = new VectorMemory()
