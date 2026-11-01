import fs from 'node:fs'
import os from 'node:os'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { cacheDir } from '../paths'
import type { Attachment } from '../../shared/types'
import { extractAudio, extractFrames } from './ffmpeg'
import { transcribe } from './transcribe'

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const VIDEO = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi'])
const AUDIO = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.opus'])
const TEXT = new Set(['.txt', '.md', '.json', '.csv', '.log', '.yml', '.yaml'])

export function kindOf(file: string): Attachment['kind'] {
  const ext = path.extname(file).toLowerCase()
  if (IMAGE.has(ext)) return 'image'
  if (VIDEO.has(ext)) return 'video'
  if (AUDIO.has(ext)) return 'audio'
  return 'file'
}

function copyIntoCache(file: string): string {
  const dir = path.join(cacheDir(), 'allegati')
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, `${Date.now()}-${path.basename(file).replace(/[^\w.\-]+/g, '_')}`)
  fs.copyFileSync(file, dest)
  return dest
}

/** Prepara un file dell'utente: frame per i video, trascrizione per audio/video. */
export async function ingest(file: string, onLog?: (msg: string) => void): Promise<Attachment> {
  const kind = kindOf(file)
  const local = copyIntoCache(file)
  const base: Attachment = {
    path: local,
    kind,
    name: path.basename(file),
    mime: kind === 'image' ? 'image/jpeg' : ''
  }
  if (kind === 'video') {
    onLog?.(`estrazione frame da ${base.name}`)
    base.frames = await extractFrames(local, 6)
    try {
      onLog?.(`trascrizione audio di ${base.name}`)
      base.text = await transcribe(await extractAudio(local))
    } catch (err) {
      base.text = `[audio non trascritto: ${(err as Error).message}]`
    }
  } else if (kind === 'audio') {
    onLog?.(`trascrizione di ${base.name}`)
    base.text = await transcribe(await extractAudio(local))
  } else if (kind === 'file') {
    const ext = path.extname(local).toLowerCase()
    const size = fs.statSync(local).size
    if (TEXT.has(ext)) {
      base.text = fs.readFileSync(local, 'utf8').slice(0, 120000)
    } else if (ext === '.pdf') {
      onLog?.(`estrazione testo da ${base.name}`)
      const extracted = extractPdfText(local)
      base.text = extracted
        ? extracted.slice(0, 120000)
        : `[PDF ${base.name}: nessun testo estraibile (scansione? serve OCR), ${size} byte]`
    } else if (ext === '.docx' || ext === '.odt') {
      onLog?.(`estrazione testo da ${base.name}`)
      const extracted = extractZipXmlText(local, ext === '.docx' ? 'word/document.xml' : 'content.xml')
      base.text = extracted
        ? extracted.slice(0, 120000)
        : `[${base.name}: contenuto non estraibile, ${size} byte]`
    } else {
      base.text = `[file ${base.name}: formato non leggibile, ${size} byte]`
    }
  }
  return base
}

/** Testo da PDF: decompressione degli stream FlateDecode + operatori di testo. */
function extractPdfText(file: string): string {
  try {
    const raw = fs.readFileSync(file)
    const parts: string[] = []
    let index = raw.indexOf('stream')
    while (index !== -1 && parts.length < 4000) {
      let start = index + 6
      if (raw[start] === 0x0d) start++
      if (raw[start] === 0x0a) start++
      const end = raw.indexOf('endstream', start)
      if (end === -1) break
      const chunk = raw.subarray(start, end)
      let text = ''
      try {
        text = zlib.inflateSync(chunk).toString('latin1')
      } catch {
        text = chunk.toString('latin1')
      }
      // estrae le stringhe dentro gli operatori Tj/TJ
      const matches = text.match(/\(([^()\\]{2,})\)\s*(?:Tj|TJ|')/g)
      if (matches) {
        for (const match of matches) {
          parts.push(match.replace(/^\(/, '').replace(/\)\s*.*$/, ''))
        }
      }
      index = raw.indexOf('stream', end)
    }
    const joined = parts
      .join(' ')
      .replace(/\\[nrt]/g, ' ')
      .replace(/\\\d{3}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return joined.length > 40 ? joined : ''
  } catch {
    return ''
  }
}

/** Testo da DOCX/ODT: XML dentro lo zip, tag rimossi. */
function readZipEntry(file: string, entry: string): string {
  try {
    return execFileSync('unzip', ['-p', file, entry], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
  } catch {
    // Windows non ha unzip: si usa PowerShell (Expand-Archive) in una cartella temporanea
    if (process.platform !== 'win32') return ''
    const tmp = path.join(os.tmpdir(), `triade-zip-${Date.now()}`)
    try {
      execFileSync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -Force -LiteralPath '${file}' -DestinationPath '${tmp}'; Get-Content -Raw -LiteralPath (Join-Path '${tmp}' '${entry}')`
      ], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
      return fs.readFileSync(path.join(tmp, entry), 'utf8')
    } catch {
      return ''
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

function extractZipXmlText(file: string, entry: string): string {
  try {
    const xml = readZipEntry(file, entry)
    return xml
      .replace(/<\/(w:p|text:p)>/g, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  } catch {
    return ''
  }
}
