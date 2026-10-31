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

/** Streaming di /v1/chat/completions (SSE) con accumulo dei tool call. */
export async function chat(baseUrl: string, req: ChatRequest): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: 'locale',
    messages: req.messages,
    stream: true,
    temperature: req.temperature ?? 0.85,
    max_tokens: req.maxTokens ?? 320,
    cache_prompt: true
  }
  if (req.tools && req.tools.length) body.tools = req.tools
  if (req.jsonMode) body.response_format = { type: 'json_object' }
  if (req.noThinking) body.chat_template_kwargs = { enable_thinking: false }

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: req.signal
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`llama-server ${res.status}: ${text.slice(0, 400)}`)
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
