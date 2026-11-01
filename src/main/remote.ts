import { chat, endpoint } from './llama/client'
import type { Backend } from '../shared/types'

export interface RemoteProbe {
  ok: boolean
  detail: string
  models: number
}

/** Verifica rapida: elenco modelli + una generazione minima. */
export async function testBackend(payload: {
  backend: Backend
  baseUrl: string
  apiKey: string
  model: string
}): Promise<RemoteProbe> {
  const base = payload.baseUrl.replace(/\/$/, '')
  if (!base) return { ok: false, detail: 'base URL mancante', models: 0 }
  if (payload.backend !== 'ollama' && !payload.apiKey) {
    return { ok: false, detail: 'API key mancante', models: 0 }
  }
  let models = 0
  try {
    const headers: Record<string, string> = {}
    if (payload.backend === 'anthropic') {
      headers['x-api-key'] = payload.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else if (payload.apiKey) {
      headers.Authorization = `Bearer ${payload.apiKey}`
    }
    const res = await fetch(endpoint(base, '/models'), {
      headers,
      signal: AbortSignal.timeout(15000)
    })
    if (res.ok) {
      const data = (await res.json()) as { data?: unknown[]; models?: unknown[] }
      models = (data.data ?? data.models ?? []).length
    }
  } catch {
    // alcuni backend non espongono /models: si prova comunque la generazione
  }
  try {
    const res = await chat(base, {
      backend: payload.backend,
      apiKey: payload.apiKey || undefined,
      model: payload.model || undefined,
      messages: [{ role: 'user', content: 'Rispondi solo con: ok' }],
      maxTokens: 8,
      temperature: 0
    })
    return {
      ok: true,
      detail: (res.content || '').trim().slice(0, 80) || 'ok',
      models
    }
  } catch (err) {
    return { ok: false, detail: (err as Error).message.slice(0, 200), models }
  }
}
