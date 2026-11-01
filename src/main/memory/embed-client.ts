import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getSettings } from '../settings'
import { findBinary, freePort, modelsDir } from '../paths'
import { endpoint } from '../llama/client'

/** Modello di embedding predefinito (Qwen3-Embedding-0.6B Q8_0). */
export const DEFAULT_EMBED_MODEL = 'Qwen3-Embedding-0.6B-Q8_0.gguf'

interface EmbedServer {
  port: number
  child: ReturnType<typeof import('node:child_process').spawn>
}

let server: EmbedServer | null = null
let warming: Promise<EmbedServer | null> | null = null

function modelPath(): string {
  return path.join(modelsDir(), getSettings().embeddings.model || DEFAULT_EMBED_MODEL)
}

async function ensureLocalServer(): Promise<EmbedServer | null> {
  if (server) return server
  if (warming) return warming
  warming = (async () => {
    const file = modelPath()
    if (!fs.existsSync(file)) return null
    const exe = findBinary('llama-server')
    if (!exe) return null
    const { spawn } = await import('node:child_process')
    const port = await freePort()
    const child = spawn(exe, ['-m', file, '--embeddings', '--port', String(port), '--host', '127.0.0.1', '-c', '4096', '-ngl', '99'], { stdio: 'ignore' })
    server = { port, child }
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500))
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
        if (res.ok) return server
      } catch {
        // ancora in caricamento
      }
    }
    child.kill()
    server = null
    return null
  })()
  const result = await warming
  warming = null
  return result
}

export function stopEmbedServer(): void {
  if (server) {
    try {
      server.child.kill()
    } catch {
      /* ignore */
    }
    server = null
  }
}

/** Embedding via motore configurato; null = non disponibile (usa il fallback locale). */
export async function embedTexts(texts: string[]): Promise<Float32Array[] | null> {
  if (!texts.length) return []
  const s = getSettings()
  const engine = s.embeddings.engine

  try {
    if (engine === 'llama') {
      const local = await ensureLocalServer()
      if (!local) return null
      const res = await fetch(`http://127.0.0.1:${local.port}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'embed', input: texts }),
        signal: AbortSignal.timeout(120000)
      })
      if (!res.ok) return null
      const data = (await res.json()) as { data?: { embedding: number[] }[] }
      return (data.data ?? []).map((d) => Float32Array.from(d.embedding))
    }

    if (engine === 'ollama') {
      const cfg = s.remote.ollama
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: s.embeddings.model || 'qwen3-embedding', input: texts }),
        signal: AbortSignal.timeout(60000)
      })
      if (!res.ok) return null
      const data = (await res.json()) as { embeddings?: number[][] }
      return (data.embeddings ?? []).map((e) => Float32Array.from(e))
    }

    // openai (o qualunque endpoint compatibile)
    const cfg = s.remote.openai
    const res = await fetch(endpoint(cfg.baseUrl, '/embeddings'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
      },
      body: JSON.stringify({ model: s.embeddings.model || 'text-embedding-3-small', input: texts }),
      signal: AbortSignal.timeout(60000)
    })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: { embedding: number[] }[] }
    return (data.data ?? []).map((d) => Float32Array.from(d.embedding))
  } catch {
    return null
  }
}

/** Diagnostica: dice quale motore risponde e con quale dimensione. */
export async function probeEmbeddings(): Promise<{ ok: boolean; detail: string; dim: number }> {
  const out = await embedTexts(['prova di embedding'])
  if (!out || !out[0]) {
    const s = getSettings()
    const hint =
      s.embeddings.engine === 'llama'
        ? `modello ${s.embeddings.model || DEFAULT_EMBED_MODEL} non trovato in dati/modelli`
        : 'endpoint non raggiungibile o chiave non valida'
    return { ok: false, detail: hint, dim: 0 }
  }
  return { ok: true, detail: `${out[0].length} dimensioni`, dim: out[0].length }
}
