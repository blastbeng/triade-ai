import fs from 'node:fs'
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
    if (TEXT.has(ext)) {
      base.text = fs.readFileSync(local, 'utf8').slice(0, 20000)
    } else {
      base.text = `[file ${base.name}: formato non leggibile, ${fs.statSync(local).size} byte]`
    }
  }
  return base
}
