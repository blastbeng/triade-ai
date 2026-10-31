import fs from 'node:fs'
import path from 'node:path'
import { cacheDir } from '../paths'
import { fetchPage, webSearch } from '../search'
import { extractAudio, extractFrames } from '../media/ffmpeg'
import { transcribe } from '../media/transcribe'

export interface ToolOutcome {
  text: string
  images?: string[]
}

export const TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Cerca sul web. Restituisce titoli, URL e estratti.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Testo della ricerca' },
          max_results: { type: 'integer', description: 'Numero di risultati (1-10)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_page',
      description: 'Scarica una pagina web e ne restituisce il testo leggibile.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL http/https' },
          max_chars: { type: 'integer', description: 'Massimo numero di caratteri (default 6000)' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'image_search',
      description:
        'Cerca immagini sul web e le rende visibili al modello: le immagini trovate vengono allegate al turno successivo.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_media',
      description:
        'Cerca video o audio sul web. Se trova un file media diretto lo scarica, ne estrae i frame e ne trascrive l’audio.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          kind: { type: 'string', enum: ['video', 'audio'] }
        },
        required: ['query']
      }
    }
  }
]

async function download(url: string, maxBytes = 25 * 1024 * 1024): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(60000)
    })
    if (!res.ok || !res.body) return null
    const type = res.headers.get('content-type') ?? ''
    const len = Number(res.headers.get('content-length') ?? '0')
    if (len > maxBytes) return null
    const dir = path.join(cacheDir(), 'media')
    fs.mkdirSync(dir, { recursive: true })
    const ext = (type.split('/')[1] ?? 'bin').split(';')[0].replace(/[^a-z0-9]/g, '')
    const dest = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext || 'bin'}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) return null
    fs.writeFileSync(dest, buf)
    return dest
  } catch {
    return null
  }
}

const DIRECT_MEDIA = /\.(mp4|webm|mp3|wav|ogg|m4a|opus|mkv|mov)(\?|$)/i

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  log?: (msg: string) => void
): Promise<ToolOutcome> {
  switch (name) {
    case 'web_search': {
      const query = String(args.query ?? '').trim()
      if (!query) return { text: 'errore: query mancante' }
      const max = Math.min(10, Number(args.max_results ?? 5) || 5)
      log?.(`ricerca web: ${query}`)
      const hits = await webSearch(query, max)
      if (!hits.length) return { text: `nessun risultato per "${query}"` }
      return {
        text: hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n')
      }
    }
    case 'fetch_page': {
      const url = String(args.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) return { text: 'errore: URL non valido' }
      log?.(`lettura pagina: ${url}`)
      const text = await fetchPage(url, Math.min(20000, Number(args.max_chars ?? 6000) || 6000))
      return { text: `### ${url}\n${text}` }
    }
    case 'image_search': {
      const query = String(args.query ?? '').trim()
      log?.(`ricerca immagini: ${query}`)
      const hits = await webSearch(query, 6, true)
      const images: string[] = []
      for (const hit of hits) {
        if (images.length >= 2) break
        if (!/^https?:\/\//i.test(hit.url)) continue
        const file = await download(hit.url, 12 * 1024 * 1024)
        if (file && /\.(jpg|jpeg|png|webp|gif)$|image/i.test(file + hit.url)) images.push(file)
      }
      const list = hits.map((h, i) => `${i + 1}. ${h.title} — ${h.url}`).join('\n')
      return {
        text: `immagini trovate:\n${list}\n${images.length ? `\n${images.length} immagini scaricate e allegate: guardale e descrivi solo ciò che vedi.` : '\nnessuna immagine scaricabile.'}`,
        images
      }
    }
    case 'find_media': {
      const query = String(args.query ?? '').trim()
      const kind = String(args.kind ?? 'video')
      log?.(`ricerca ${kind}: ${query}`)
      const hits = await webSearch(`${query} ${kind === 'video' ? 'video' : 'audio'} file`, 8)
      const direct = hits.find((h) => DIRECT_MEDIA.test(h.url))
      if (!direct) {
        return {
          text:
            `nessun file ${kind} diretto trovato. Candidati:\n` +
            hits.map((h, i) => `${i + 1}. ${h.title} — ${h.url}`).join('\n') +
            '\nper una pagina usa fetch_page; per un URL diretto riprova con find_media.'
        }
      }
      const file = await download(direct.url, 80 * 1024 * 1024)
      if (!file) return { text: `download fallito: ${direct.url}` }
      const frames = await extractFrames(file, 6)
      let transcript = ''
      try {
        transcript = await transcribe(await extractAudio(file))
      } catch (err) {
        transcript = `[audio non trascritto: ${(err as Error).message}]`
      }
      return {
        text: `media scaricato: ${direct.url}\ntrascrizione audio:\n${transcript || '(vuota)'}\nallegati ${frames.length} frame.`,
        images: frames
      }
    }
    default:
      return { text: `tool sconosciuto: ${name}` }
  }
}
