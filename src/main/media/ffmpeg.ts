import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { cacheDir, findBinary } from '../paths'

function ffmpegPath(): string {
  const p = findBinary('ffmpeg')
  if (!p) throw new Error('ffmpeg non trovato in bin/: video e audio non sono elaborabili')
  return p
}

function run(exe: string, args: string[], timeoutMs = 120000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (b) => {
      stderr += b.toString()
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('ffmpeg: timeout'))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg codice ${code}: ${stderr.slice(-400)}`))
    })
  })
}

function durationOf(file: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), ['-i', file], { windowsHide: true })
    let err = ''
    child.stderr.on('data', (b) => {
      err += b.toString()
    })
    child.on('exit', () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(err)
      if (!m) return resolve(0)
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100)
    })
    child.on('error', () => resolve(0))
  })
}

/** Estrae frame distribuiti uniformemente (max `maxFrames`), gia ridimensionati. */
export async function extractFrames(file: string, maxFrames = 6): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(cacheDir(), 'frames-'))
  const dur = await durationOf(file)
  const fps = dur > 0 ? Math.min(2, Math.max(0.05, maxFrames / dur)) : 1
  await run(ffmpegPath(), [
    '-y',
    '-i', file,
    '-vf', `fps=${fps.toFixed(3)},scale='min(1024,iw)':-2`,
    '-frames:v', String(maxFrames),
    '-q:v', '3',
    path.join(dir, 'frame-%02d.jpg')
  ])
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .map((f) => path.join(dir, f))
}

/** Estrae l'audio in WAV mono 16 kHz, formato atteso da whisper.cpp. */
export async function extractAudio(file: string): Promise<string> {
  const out = path.join(fs.mkdtempSync(path.join(cacheDir(), 'audio-')), 'audio.wav')
  await run(ffmpegPath(), [
    '-y',
    '-i', file,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    out
  ])
  return out
}
