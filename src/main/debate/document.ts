import type { Attachment } from '../../shared/types'

const CHUNK = 6000

/** Termini significativi del testo (per scegliere i chunk pertinenti). */
function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3)
  )
}

function score(chunk: string, wanted: Set<string>): number {
  let hits = 0
  for (const t of terms(chunk)) if (wanted.has(t)) hits++
  return hits
}

/**
 * Testo degli allegati per il prompt, a chunk: invece di troncare i primi 6000
 * caratteri (perdendo il resto del documento) si scelgono i passaggi più
 * pertinenti all'argomento, entro un budget complessivo.
 */
export function attachmentContext(
  attachments: Attachment[],
  query: string,
  budgetChars = 24000
): string {
  const wanted = terms(query)
  const out: string[] = []
  let left = budgetChars

  for (const a of attachments) {
    const head = `ALLEGATO: ${a.name} (${a.kind})`
    if (!a.text) {
      out.push(head)
      continue
    }
    const chunks: string[] = []
    for (let i = 0; i < a.text.length; i += CHUNK) chunks.push(a.text.slice(i, i + CHUNK))
    const ranked = chunks
      .map((text, index) => ({ text, index, score: score(text, wanted) }))
      .sort((x, y) => y.score - x.score || x.index - y.index)

    const picked: { index: number; text: string }[] = []
    for (const c of ranked) {
      if (left <= 0) break
      const slice = c.text.slice(0, Math.min(left, c.text.length))
      picked.push({ index: c.index, text: slice })
      left -= slice.length
    }
    picked.sort((x, y) => x.index - y.index)
    const body = picked
      .map((p, i) => (i === 0 || p.index === picked[i - 1].index + 1 ? p.text : `[…]\n${p.text}`))
      .join('')
    const omitted = chunks.length - picked.length
    out.push(`${head}${omitted > 0 ? ` (${chunks.length} sezioni, ${omitted} omesse)` : ''}\n${body}`)
  }

  return out.join('\n\n')
}
