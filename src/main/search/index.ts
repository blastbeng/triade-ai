import { getSettings } from '../settings'
import { fallbackSearch, parseSearxHtml, type SearchHit } from './engines'

export type { SearchHit }

export interface SearchAnswer {
  hits: SearchHit[]
  engine: string
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

async function jsonFetch(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(`ricerca fallita: HTTP ${res.status}`)
  return res.json()
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

async function searxng(query: string, max: number, images = false): Promise<SearchHit[]> {
  const base = getSettings().search.searxngUrl.replace(/\/$/, '')
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    language: 'it',
    safesearch: '0'
  })
  if (images) params.set('categories', 'images')
  try {
    const data = await jsonFetch(`${base}/search?${params.toString()}`)
    const results = Array.isArray(data?.results) ? data.results : []
    return results.slice(0, max).map((r: any) => ({
      title: String(r.title ?? ''),
      url: String(r.url ?? r.img_src ?? ''),
      snippet: stripTags(String(r.content ?? r.title ?? ''))
    }))
  } catch {
    // Istanza senza API JSON: fallback su parsing HTML.
    const res = await fetch(`${base}/search?${new URLSearchParams({ q: query }).toString()}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(20000)
    })
    if (!res.ok) return []
    const html = await res.text()
    return parseSearxHtml(html, max)
  }
}

async function brave(query: string, max: number): Promise<SearchHit[]> {
  const key = getSettings().search.braveKey.trim()
  if (!key) throw new Error('chiave Brave non configurata')
  const data = await jsonFetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`,
    { headers: { 'X-Subscription-Token': key } }
  )
  const results = data?.web?.results ?? []
  return results.slice(0, max).map((r: any) => ({
    title: String(r.title ?? ''),
    url: String(r.url ?? ''),
    snippet: stripTags(String(r.description ?? ''))
  }))
}

async function tavily(query: string, max: number): Promise<SearchHit[]> {
  const key = getSettings().search.tavilyKey.trim()
  if (!key) throw new Error('chiave Tavily non configurata')
  const data = await jsonFetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: max, search_depth: 'basic' })
  })
  const results = data?.results ?? []
  return results.slice(0, max).map((r: any) => ({
    title: String(r.title ?? ''),
    url: String(r.url ?? ''),
    snippet: stripTags(String(r.content ?? ''))
  }))
}

async function googleCse(query: string, max: number): Promise<SearchHit[]> {
  const { googleKey, googleCx } = getSettings().search
  if (!googleKey.trim() || !googleCx.trim()) throw new Error('chiave/CX Google non configurati')
  const data = await jsonFetch(
    `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(googleKey)}&cx=${encodeURIComponent(googleCx)}&q=${encodeURIComponent(query)}&num=${Math.min(10, max)}`
  )
  const results = data?.items ?? []
  return results.slice(0, max).map((r: any) => ({
    title: String(r.title ?? ''),
    url: String(r.link ?? ''),
    snippet: stripTags(String(r.snippet ?? ''))
  }))
}

export async function webSearchDetailed(
  query: string,
  max?: number,
  images = false
): Promise<SearchAnswer> {
  const s = getSettings()
  const n = max ?? s.search.maxResults
  const primary = async (): Promise<SearchHit[]> => {
    switch (s.search.provider) {
      case 'brave':
        return brave(query, n)
      case 'tavily':
        return tavily(query, n)
      case 'googlecse':
        return googleCse(query, n)
      case 'searxng':
      default:
        return searxng(query, n, images)
    }
  }

  let hits: SearchHit[] = []
  let primaryError: string | null = null
  try {
    hits = await primary()
  } catch (err) {
    primaryError = (err as Error).message
  }

  // SearXNG pubblici spesso rispondono con captcha: catena di riserva senza chiavi.
  if (!hits.length) {
    const lang = (s.ui?.language ?? 'it') === 'en' ? 'en' : 'it'
    const fallback = await fallbackSearch(query, n, lang)
    if (fallback.hits.length) {
      console.log(`[search] "${query}" → ${fallback.engine} (${fallback.hits.length})`)
      return { hits: fallback.hits, engine: fallback.engine }
    }
    if (primaryError) throw new Error(primaryError)
    throw new Error('nessun motore di ricerca ha restituito risultati')
  }
  return { hits, engine: s.search.provider }
}

export async function webSearch(query: string, max?: number, images = false): Promise<SearchHit[]> {
  return (await webSearchDetailed(query, max, images)).hits
}

/** Estrae il testo leggibile di una pagina, senza dipendenze pesanti. */
/** Rifiuta URL che puntano a reti locali/private (SSRF). */
export function assertPublicUrl(raw: string): URL {
  const url = new URL(raw)
  if (!/^https?:$/.test(url.protocol)) throw new Error('protocollo non supportato')
  const host = url.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    throw new Error('indirizzo locale non consentito')
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    const privato =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    if (privato) throw new Error('indirizzo di rete privata non consentito')
  }
  return url
}

export async function fetchPage(url: string, maxChars = 6000): Promise<string> {
  assertPublicUrl(url)
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} su ${url}`)
  const type = res.headers.get('content-type') ?? ''
  const raw = await res.text()
  if (!type.includes('html')) return raw.slice(0, maxChars)
  const cleaned = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
  const text = decodeEntities(cleaned.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.slice(0, maxChars)
}
