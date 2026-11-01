export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_video'; input_video: { url: string } }

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  tool_calls?: RawToolCall[]
  tool_call_id?: string
  name?: string
}

export interface RawToolCall {
  id: string
  type?: 'function'
  function: { name: string; arguments: string }
}

export interface ChatRequest {
  /** backend remoto; assente = llama-server locale */
  backend?: 'llama' | 'openai' | 'anthropic' | 'ollama'
  apiKey?: string
  /** nome del modello remoto (ignorato dal server locale) */
  model?: string
  messages: LlmMessage[]
  temperature?: number
  maxTokens?: number
  tools?: unknown[]
  signal?: AbortSignal
  onDelta?: (chunk: string) => void
  onReasoningDelta?: (chunk: string) => void
  jsonMode?: boolean
  /** per le chiamate strutturate: niente reasoning, risposta diretta */
  noThinking?: boolean
  /** sequenze che fermano la generazione (es. cessione di parola) */
  stops?: string[]
}

export interface ChatResult {
  content: string
  reasoning: string
  toolCalls: RawToolCall[]
  interrupted: boolean
  /** 'loop' = generazione fermata per ripetizione ossessiva */
  stopReason?: 'loop'
}

/** Rileva la ripetizione ossessiva dello stesso blocco (allucinazione a loop). */
function looksRepetitive(text: string): boolean {
  const tail = text.slice(-1500)
  for (const size of [80, 120, 200, 300]) {
    const last = tail.slice(-size)
    if (last.trim().length < 40) continue
    let count = 0
    let idx = 0
    for (;;) {
      const at = tail.indexOf(last, idx)
      if (at === -1) break
      count++
      idx = at + size
      if (count >= 3) return true
    }
  }
  return false
}

/** Unisce base e path: aggiunge /v1 solo se la base non lo contiene già. */
export function endpoint(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, '')
  return /\/v1$/.test(base) ? `${base}${path}` : `${base}/v1${path}`
}

/** Streaming di /v1/chat/completions (SSE) con accumulo dei tool call. */
export async function chat(baseUrl: string, req: ChatRequest): Promise<ChatResult> {
  if (req.backend === 'anthropic') return anthropicChat(req, baseUrl)
  if (req.backend === 'ollama') return ollamaChat(baseUrl, req)

  const body: Record<string, unknown> = {
    model: req.model ?? 'locale',
    messages: req.messages,
    stream: true,
    temperature: req.temperature ?? 0.85,
    max_tokens: req.maxTokens ?? 320
  }
  // cache_prompt è specifico di llama-server: le API remote rifiutano campi sconosciuti
  if (!req.backend || req.backend === 'llama') body.cache_prompt = true
  if (req.tools && req.tools.length) body.tools = req.tools
  if (req.jsonMode) body.response_format = { type: 'json_object' }
  if (req.noThinking) body.chat_template_kwargs = { enable_thinking: false }
  if (req.stops?.length) body.stop = req.stops

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`
  const res = await fetch(endpoint(baseUrl, '/chat/completions'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: req.signal
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    const who = req.backend ?? 'llama-server'
    throw new Error(`${who} ${res.status}: ${text.slice(0, 400)}`)
  }

  let content = ''
  let reasoning = ''
  const toolCalls: RawToolCall[] = []
  let interrupted = false
  let stopReason: 'loop' | undefined
  let sinceCheck = 0
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    let parsed: any
    try {
      parsed = JSON.parse(payload)
    } catch {
      return
    }
    const delta = parsed?.choices?.[0]?.delta
    if (!delta) return
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content
      req.onDelta?.(delta.content)
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content
      req.onReasoningDelta?.(delta.reasoning_content)
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx: number = typeof tc.index === 'number' ? tc.index : toolCalls.length
        if (!toolCalls[idx]) {
          toolCalls[idx] = { id: tc.id ?? `call_${idx}`, type: 'function', function: { name: '', arguments: '' } }
        }
        if (tc.id) toolCalls[idx].id = tc.id
        if (tc.function?.name) toolCalls[idx].function.name += tc.function.name
        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
      }
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
      sinceCheck += lines.length
      if (sinceCheck > 25 && looksRepetitive(content)) {
        stopReason = 'loop'
        break
      }
      if (stopReason) break
    }
    if (buffer) handleLine(buffer)
  } catch (err) {
    if ((err as Error).name === 'AbortError') interrupted = true
    else throw err
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
  }

  return {
    content,
    reasoning,
    toolCalls: toolCalls.filter((t) => t && t.function.name),
    interrupted,
    stopReason
  }
}

/** Conteggio token esatto usando il tokenizer del modello. */
export async function countTokens(baseUrl: string, text: string): Promise<number> {
  if (!text) return 0
  try {
    const res = await fetch(`${baseUrl}/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, add_special: true })
    })
    if (!res.ok) return Math.ceil(text.length / 3.5)
    const data = (await res.json()) as { tokens?: unknown[] }
    return Array.isArray(data.tokens) ? data.tokens.length : Math.ceil(text.length / 3.5)
  } catch {
    return Math.ceil(text.length / 3.5)
  }
}

export async function serverHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`)
    if (!res.ok) return false
    const body = (await res.json()) as { status?: string }
    return body.status === 'ok'
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * Adattatore Anthropic (POST /v1/messages, SSE diverso da OpenAI)
 * ------------------------------------------------------------------ */

interface AnthropicBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result'
  text?: string
  source?: { type: 'base64'; media_type: string; data: string }
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string
}

function toAnthropicMessages(messages: LlmMessage[]): {
  system: string
  messages: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[]
} {
  const system: string[] = []
  const out: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] = []
  for (const message of messages) {
    const blocks: AnthropicBlock[] = []
    if (typeof message.content === 'string') {
      if (message.content.trim()) blocks.push({ type: 'text', text: message.content })
    } else {
      for (const part of message.content) {
        if (part.type === 'text' && part.text) {
          blocks.push({ type: 'text', text: part.text })
        } else if (part.type === 'image_url') {
          const url = part.image_url?.url ?? ''
          const match = /^data:([^;]+);base64,(.*)$/s.exec(url)
          if (match) {
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: match[1], data: match[2] }
            })
          }
        }
      }
    }
    if (message.role === 'system') {
      system.push(blocks.map((b) => b.text ?? '').join('\n'))
      continue
    }
    if (message.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: blocks.map((b) => b.text ?? '').join('\n') }
        ]
      })
      continue
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        let input: unknown = {}
        try {
          input = JSON.parse(call.function.arguments || '{}')
        } catch {
          input = {}
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input })
      }
    }
    if (!blocks.length) continue
    out.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: blocks })
  }
  return { system: system.join('\n\n'), messages: out }
}

export async function anthropicChat(req: ChatRequest, baseUrlOverride?: string): Promise<ChatResult> {
  const base = baseUrlOverride ?? 'https://api.anthropic.com/v1'
  const { system, messages } = toAnthropicMessages(req.messages)
  const tools = (req.tools ?? []).map((tool) => {
    const fn = (tool as { function?: { name: string; description?: string; parameters?: unknown } }).function
    if (!fn) return tool
    return { name: fn.name, description: fn.description ?? '', input_schema: fn.parameters ?? { type: 'object', properties: {} } }
  })
  const body: Record<string, unknown> = {
    model: req.model ?? 'claude-sonnet-4-5',
    max_tokens: req.maxTokens && req.maxTokens > 0 ? req.maxTokens : 4096,
    system: system || undefined,
    messages,
    stream: true,
    temperature: Math.min(1, Math.max(0, req.temperature ?? 0.7))
  }
  if (tools.length) body.tools = tools

  const res = await fetch(endpoint(base, '/messages'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': req.apiKey ?? '',
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body),
    signal: req.signal
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`anthropic ${res.status}: ${text.slice(0, 400)}`)
  }

  let content = ''
  let reasoning = ''
  const toolCalls: RawToolCall[] = []
  const partialJson = new Map<number, { id: string; name: string; json: string }>()
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const handle = (raw: string): void => {
    const line = raw.trim()
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    let event: any
    try {
      event = JSON.parse(payload)
    } catch {
      return
    }
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      partialJson.set(event.index, {
        id: event.content_block.id,
        name: event.content_block.name,
        json: ''
      })
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta ?? {}
      if (delta.type === 'text_delta' && delta.text) {
        content += delta.text
        req.onDelta?.(delta.text)
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        reasoning += delta.thinking
        req.onReasoningDelta?.(delta.thinking)
      } else if (delta.type === 'input_json_delta') {
        const slot = partialJson.get(event.index)
        if (slot) slot.json += delta.partial_json ?? ''
      }
    } else if (event.type === 'content_block_stop') {
      const slot = partialJson.get(event.index)
      if (slot) {
        toolCalls.push({
          id: slot.id,
          type: 'function',
          function: { name: slot.name, arguments: slot.json || '{}' }
        })
        partialJson.delete(event.index)
      }
    } else if (event.type === 'error') {
      throw new Error(`anthropic: ${event.error?.message ?? 'errore sconosciuto'}`)
    }
  }

  let sinceCheck = 0
  let stopReason: 'loop' | undefined
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) handle(line)
    sinceCheck += value?.length ?? 0
    if (sinceCheck > 600 && looksRepetitive(content)) {
      stopReason = 'loop'
      await reader.cancel().catch(() => undefined)
      break
    }
    if (sinceCheck > 600) sinceCheck = 0
  }
  if (buffer) handle(buffer)

  return { content, reasoning, toolCalls, interrupted: Boolean(req.signal?.aborted) && !content, stopReason }
}

/* ------------------------------------------------------------------ *
 * Adattatore Ollama (API nativa: POST /api/chat, NDJSON)
 * ------------------------------------------------------------------ */

export async function ollamaChat(baseUrl: string, req: ChatRequest): Promise<ChatResult> {
  const base = baseUrl.replace(/\/$/, '')
  const url = /\/api$/.test(base) ? `${base}/chat` : `${base}/api/chat`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(req.apiKey ? { Authorization: `Bearer ${req.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      options: {
        temperature: req.temperature ?? 0.8,
        num_predict: req.maxTokens && req.maxTokens > 0 ? req.maxTokens : 4096
      }
    }),
    signal: req.signal
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`ollama ${res.status}: ${text.slice(0, 300)}`)
  }

  let content = ''
  let reasoning = ''
  const toolCalls: RawToolCall[] = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const handle = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: any
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return
    }
    if (parsed.error) throw new Error(`ollama: ${parsed.error}`)
    const message = parsed.message ?? {}
    if (typeof message.content === 'string' && message.content) {
      content += message.content
      req.onDelta?.(message.content)
    }
    if (typeof message.thinking === 'string' && message.thinking) {
      reasoning += message.thinking
      req.onReasoningDelta?.(message.thinking)
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        toolCalls.push({
          id: call.id ?? `ollama-${toolCalls.length}`,
          type: 'function',
          function: {
            name: call.function?.name ?? '',
            arguments:
              typeof call.function?.arguments === 'string'
                ? call.function.arguments
                : JSON.stringify(call.function?.arguments ?? {})
          }
        })
      }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) handle(line)
  }
  if (buffer) handle(buffer)

  return { content, reasoning, toolCalls, interrupted: Boolean(req.signal?.aborted) && !content, stopReason: undefined }
}
