import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { binDir, findBinary, modelsDir } from '../paths'
import { getSettings } from '../settings'

function whisperExe(): string {
  const exe =
    findBinary('whisper/whisper-cli') ??
    findBinary('whisper/whisper') ??
    findBinary('whisper-cli') ??
    findBinary('whisper') ??
    findBinary('main')
  if (!exe) throw new Error('whisper.cpp non trovato in bin/ (atteso whisper-cli)')
  return exe
}

/** Trascrive un WAV 16 kHz mono con whisper.cpp (CLI, backend Vulkan se compilato cosi). */
export async function transcribe(wavPath: string): Promise<string> {
  const s = getSettings()
  if (!s.asr.enabled) return '[trascrizione disattivata nelle impostazioni]'
  const model = path.join(modelsDir(), s.asr.modelFile)
  if (!fs.existsSync(model)) {
    throw new Error(
      `modello ASR mancante: ${model}. Scaricalo con "npm run fetch:bin" (voce whisper-model).`
    )
  }
  const outBase = path.join(path.dirname(wavPath), 'trascrizione')
  const exe = whisperExe()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      exe,
      ['-m', model, '-f', wavPath, '-l', s.asr.language, '-otxt', '-of', outBase, '-nt'],
      { windowsHide: true, cwd: path.dirname(exe) }
    )
    let err = ''
    child.stdout.on('data', (b) => {
      err += b.toString()
    })
    child.stderr.on('data', (b) => {
      err += b.toString()
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('whisper: timeout'))
    }, 20 * 60 * 1000)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`whisper codice ${code}: ${err.slice(-300)}`))
    })
  })
  const txt = `${outBase}.txt`
  if (!fs.existsSync(txt)) throw new Error('whisper non ha prodotto la trascrizione')
  return fs.readFileSync(txt, 'utf8').trim()
}
