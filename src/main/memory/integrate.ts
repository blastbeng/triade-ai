import { chat } from '../llama/client'
import type { Session, Turn } from '../../shared/types'
import { memory } from './store'

/** Salva un turno nel vectordb: la chat vecchia resta consultabile come memoria. */
export function rememberTurn(session: Session, turn: Turn): void {
  if (turn.text.length < 40) return
  memory.add([
    {
      text: `[${session.topic.split('\n')[0].slice(0, 160)}] ${turn.name}: ${turn.text.slice(0, 2400)}`,
      kind: 'turno',
      sessionId: session.id,
      topic: session.topic.slice(0, 200)
    }
  ])
}

export function rememberUserNote(session: Session, text: string): void {
  memory.add([
    {
      text: `[${session.topic.split('\n')[0].slice(0, 160)}] Utente: ${text.slice(0, 2400)}`,
      kind: 'turno',
      sessionId: session.id,
      topic: session.topic.slice(0, 200)
    }
  ])
}

/** Blocco di memoria storica da iniettare nel system prompt. */
export function recallBlock(query: string, excludeSessionId?: string, k = 6, maxChars = 1600): string {
  const hits = memory.search(query, k, excludeSessionId)
  if (!hits.length) return ''
  const lines = hits.map((h) => {
    const when = new Date(h.ts).toLocaleDateString('it-IT')
    return `- (${when}, ${h.kind}) ${h.text.replace(/\s+/g, ' ').slice(0, 260)}`
  })
  const body = lines.join('\n').slice(0, maxChars)
  return `MEMORIA STORICA (sessioni precedenti, recuperata per similarità):\n${body}`
}

/**
 * A fine sessione il modello estrae i fatti riutilizzabili e li salva come
 * memoria permanente: è ciò che permette alle chat future di "ricordare".
 */
export async function distillSession(baseUrl: string, session: Session): Promise<number> {
  const transcript = session.turns
    .slice(-30)
    .map((t) => `[${t.name}] ${t.text}`)
    .join('\n\n')
    .slice(-16000)
  if (transcript.length < 200) return 0

  const res = await chat(baseUrl, {
    messages: [
      {
        role: 'system',
        content:
          'Estrai i fatti riutilizzabili da una discussione. Rispondi SOLO con JSON: {"fatti":["...","..."],"sintesi":"..."}. Ogni fatto deve essere autosufficiente (senza "lui", "questo", "prima"), massimo 200 caratteri, con numeri/URL se presenti. Massimo 8 fatti. Niente opinioni.'
      },
      {
        role: 'user',
        content: `ARGOMENTO: ${session.topic.slice(0, 800)}\n\nDISCUSSIONE:\n${transcript}`
      }
    ],
    temperature: 0,
    maxTokens: 800,
    jsonMode: true,
    noThinking: true
  })

  let facts: string[] = []
  let summary = ''
  try {
    const json = JSON.parse(res.content.replace(/^[^{]*/, '').replace(/[^}]*$/, ''))
    facts = Array.isArray(json.fatti) ? json.fatti.filter((f: unknown) => typeof f === 'string') : []
    summary = typeof json.sintesi === 'string' ? json.sintesi : ''
  } catch {
    facts = []
  }

  const items: Array<{ text: string; kind: 'fatto' | 'sintesi'; sessionId: string; topic: string }> =
    facts.map((f) => ({
      text: `[${session.topic.split('\n')[0].slice(0, 160)}] ${f}`,
      kind: 'fatto' as const,
      sessionId: session.id,
      topic: session.topic.slice(0, 200)
    }))
  if (summary) {
    items.push({
      text: `[${session.topic.split('\n')[0].slice(0, 160)}] Sintesi: ${summary.slice(0, 1200)}`,
      kind: 'sintesi',
      sessionId: session.id,
      topic: session.topic.slice(0, 200)
    })
  }
  return memory.add(items)
}
