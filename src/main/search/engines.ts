/** Motori di ricerca senza chiave API, usati come catena di riserva. */

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

export interface EngineResult {
  hits: SearchHit[]
  engine: string
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
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

async function get(url: string, accept = 'text/html,application/xhtml+xml'): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: accept,
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) {
      if (process.env.TRIADE_DEBUG_SEARCH) console.log(`[search] GET ${url} → HTTP ${res.status}`)
      return null
    }
    const body = await res.text()
    if (process.env.TRIADE_DEBUG_SEARCH) {
      console.log(`[search] GET ${url} → ${res.status}, ${body.length} byte, b_algo=${(body.match(/<li class="b_algo/g) ?? []).length}`)
    }
    return body
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
    const snippet =
      /<p[^>]*class="content"[^>]*>([\s\S]*?)<\/p>/i.exec(block) ??
      /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    hits.push({
      title: clean(link[2]).slice(0, 160),
      url: link[1],
      snippet: snippet ? clean(snippet[1]).slice(0, 400) : ''
    })
    if (hits.length >= max) break
  }
  return hits
}

/** Bing incapsula i link in /ck/a?...&u=a1<base64>: recupera la destinazione reale. */
export function decodeBingLink(href: string): string {
  const clean = href.replace(/&amp;/g, '&')
  try {
    const url = new URL(clean)
    const enc = url.searchParams.get('u')
    if (enc && enc.startsWith('a1')) {
      const b64 = enc.slice(2).replace(/-/g, '+').replace(/_/g, '/')
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
      const decoded = Buffer.from(padded, 'base64').toString('utf8')
      if (/^https?:\/\//.test(decoded)) return decoded
    }
  } catch {
    // link non incapsulato
  }
  return clean
}

/** Bing (HTML pubblico, nessuna chiave). */
export async function bing(query: string, max: number): Promise<SearchHit[]> {
  const html = await get(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.max(10, max)}&setlang=it`
  )
  if (!html) return []
  const hits: SearchHit[] = []
  const blocks = html.split(/<li class="b_algo"/).slice(1)
  for (const block of blocks) {
    const link = /<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!link) continue
    const url = decodeBingLink(link[1])
    if (/^https?:\/\/(r\.bing\.com|www\.bing\.com|go\.microsoft\.com|support\.microsoft\.com\/help)/i.test(url)) {
      continue
    }
    if (!/^https?:\/\//.test(url)) continue
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    hits.push({
      title: clean(link[2]).slice(0, 160),
      url,
      snippet: snippet ? clean(snippet[1]).slice(0, 400) : ''
    })
    if (hits.length >= max) break
  }
  return hits
}

/** Wikipedia: enciclopedico ma affidabile e senza chiavi. */
export async function wikipedia(query: string, max: number, lang = 'it'): Promise<SearchHit[]> {
  const rc = await get(
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${max}&format=json&origin=*`,
    'application/json'
  )
  if (!rc) return []
  try {
    const data = JSON.parse(rc) as { query?: { search?: { title: string; snippet: string }[] } }
    return (data.query?.search ?? []).slice(0, max).map((r) => ({
      title: r.title,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
      snippet: clean(r.snippet).slice(0, 400)
    }))
  } catch {
    return []
  }
}

/** DuckDuckGo Instant Answer: risposte sintetiche, nessuna chiave. */
export async function duckDuckGo(query: string, max: number): Promise<SearchHit[]> {
  const text = await get(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
    'application/json'
  )
  if (!text) return []
  try {
    const data = JSON.parse(text) as {
      AbstractText?: string
      AbstractURL?: string
      Heading?: string
      RelatedTopics?: { Text?: string; FirstURL?: string; Topics?: { Text?: string; FirstURL?: string }[] }[]
    }
    const hits: SearchHit[] = []
    if (data.AbstractText && data.AbstractURL) {
      hits.push({
        title: data.Heading ?? query,
        url: data.AbstractURL,
        snippet: data.AbstractText.slice(0, 400)
      })
    }
    const flat = (data.RelatedTopics ?? []).flatMap((t) => (t.Topics ? t.Topics : [t]))
    for (const topic of flat) {
      if (hits.length >= max) break
      if (!topic.FirstURL || !topic.Text) continue
      hits.push({ title: topic.Text.slice(0, 120), url: topic.FirstURL, snippet: topic.Text.slice(0, 400) })
    }
    return hits.slice(0, max)
  } catch {
    return []
  }
}

/** Catena di riserva: restituisce il primo motore che produce risultati utili. */
export async function fallbackSearch(
  query: string,
  max: number,
  wikipediaLang = 'it'
): Promise<EngineResult> {
  const chain: { name: string; run: () => Promise<SearchHit[]> }[] = [
    { name: 'bing', run: () => bing(query, max) },
    { name: 'wikipedia', run: () => wikipedia(query, max, wikipediaLang) },
    { name: 'duckduckgo', run: () => duckDuckGo(query, max) }
  ]
  for (const engine of chain) {
    const hits = await engine.run()
    if (process.env.TRIADE_DEBUG_SEARCH) {
      console.log(`[search] ${engine.name} → ${hits.length} risultati`)
    }
    if (hits.length) return { hits, engine: engine.name }
  }
  return { hits: [], engine: 'none' }
}
