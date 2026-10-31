/** Motori di ricerca senza chiave API, usati come catena di riserva. */

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

function clean(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

async function get(url: string, accept = 'text/html'): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

/** HTML delle istanze SearXNG (quando l'API JSON è disattivata). */
export function parseSearxHtml(html: string, max: number): SearchHit[] {
  const hits: SearchHit[] = []
  const blocks = html.split(/<article\s+class="result[^"]*"/i).slice(1)
  for (const block of blocks) {
    const link = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!link) continue
    const snippet = /<p[^>]*class="content"[^>]*>([\s\S]*?)<\/p>/i.exec(block) ?? /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    hits.push({
      title: clean(link[2]).slice(0, 160),
      url: link[1],
      snippet: snippet ? clean(snippet[1]).slice(0, 400) : ''
    })
    if (hits.length >= max) break
  }
  return hits
}

/** DuckDuckGo Instant Answer API: nessuna chiave, risposte sintetiche. */
export async function duckDuckGo(query: string, max: number): Promise<SearchHit[]> {
  const text = await get(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
    'application/json'
  )
  if (!text) return []
  try {
    const data = JSON.parse(text) as {
      Abstract?: string
      AbstractURL?: string
      Heading?: string
      RelatedTopics?: { Text?: string; FirstURL?: string; Topics?: { Text?: string; FirstURL?: string }[] }[]
    }
    const hits: SearchHit[] = []
    if (data.Abstract && data.AbstractURL) {
      hits.push({ title: data.Heading ?? query, url: data.AbstractURL, snippet: data.Abstract })
    }
    for (const topic of data.RelatedTopics ?? []) {
      const items = topic.Topics ?? [topic]
      for (const item of items) {
        if (!item.FirstURL || !item.Text) continue
        hits.push({ title: item.Text.split(' - ')[0].slice(0, 120), url: item.FirstURL, snippet: item.Text })
        if (hits.length >= max) break
      }
      if (hits.length >= max) break
    }
    return hits
  } catch {
    return []
  }
}

/** Wikipedia (API ufficiale): ottimo per fatti, definizioni, riferimenti. */
export async function wikipedia(query: string, max: number, lang = 'it'): Promise<SearchHit[]> {
  const text = await get(
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${max}`,
    'application/json'
  )
  if (!text) return []
  try {
    const data = JSON.parse(text) as {
      query?: { search?: { title: string; snippet: string }[] }
    }
    return (data.query?.search ?? []).map((r) => ({
      title: r.title,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
      snippet: clean(r.snippet)
    }))
  } catch {
    return []
  }
}

/** Catena di riserva: si ferma al primo motore che restituisce risultati. */
export async function fallbackSearch(query: string, max: number): Promise<{ hits: SearchHit[]; engine: string }> {
  const chain: Array<[string, () => Promise<SearchHit[]>]> = [
    ['duckduckgo', () => duckDuckGo(query, max)],
    ['wikipedia-it', () => wikipedia(query, max, 'it')],
    ['wikipedia-en', () => wikipedia(query, max, 'en')]
  ]
  for (const [name, fn] of chain) {
    const hits = await fn()
    if (hits.length) return { hits, engine: name }
  }
  return { hits: [], engine: 'nessuno' }
}
