import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anthropicChat } from '../src/main/llama/client'

let server: ReturnType<typeof createServer>
let base = ''
let lastHeaders: Record<string, unknown> = {}
let lastBody: Record<string, unknown> = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    lastHeaders = req.headers as Record<string, unknown>
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      lastBody = JSON.parse(raw || '{}') as Record<string, unknown>
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (obj: unknown): void => {
        res.write(`event: ${(obj as { type: string }).type}\ndata: ${JSON.stringify(obj)}\n\n`)
      }
      send({ type: 'message_start', message: { id: 'm1', role: 'assistant' } })
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ciao ' } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'mondo' } })
      send({ type: 'content_block_stop', index: 0 })
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })
      send({ type: 'message_stop' })
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(() => {
  server?.close()
})

describe('adattatore Anthropic', () => {
  it('compone il testo dagli eventi SSE e manda le intestazioni giuste', async () => {
    let streamed = ''
    const result = await anthropicChat({
      backend: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-test',
      messages: [
        { role: 'system', content: 'sei un test' },
        { role: 'user', content: 'di ciao' }
      ],
      onDelta: (t: string) => {
        streamed += t
      }
    } as never, base)
    expect(result.content).toBe('Ciao mondo')
    expect(streamed).toBe('Ciao mondo')
    expect(String(lastHeaders['x-api-key'])).toBe('test-key')
    expect(String(lastHeaders['anthropic-version'])).toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(lastBody['model']).toBe('claude-test')
    // il system prompt va separato dai messaggi
    expect(String(lastBody['system'])).toContain('sei un test')
    expect(Array.isArray(lastBody['messages'])).toBe(true)
  })
})
