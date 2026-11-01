#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const target = process.argv[2]
if (target !== 'win' && target !== 'linux') {
  console.error('uso: node scripts/stage-bin.mjs [win|linux]')
  process.exit(1)
}

const root = path.join(import.meta.dirname, '..')
const from = path.join(root, 'bin', target)
const stage = path.join(root, 'bin', 'stage')

if (!fs.existsSync(from)) {
  console.error(`manca ${from}: esegui prima "npm run fetch:bin ${target}"`)
  process.exit(1)
}

/**
 * Controllo di integrità: la radice di bin/<target> deve contenere esattamente
 * i file dell'archivio ufficiale di llama.cpp (più ffmpeg), con le stesse
 * dimensioni. Un file di whisper.cpp o della build CUDA finito qui sovrascrive
 * una DLL di llama.cpp con una di un altro build: su Windows è 0xC0000139
 * ("impossibile trovare il punto di ingresso ... in mtmd.dll").
 */
function verify(from) {
  const manifest = path.join(from, '.llama-files.json')
  if (!fs.existsSync(manifest)) {
    console.error(`[stage] manca ${manifest}: esegui "npm run fetch:bin" prima della build`)
    process.exit(1)
  }
  const expected = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  const bad = []
  for (const [name, size] of Object.entries(expected)) {
    const file = path.join(from, name)
    if (!fs.existsSync(file)) bad.push(`${name}: mancante`)
    else if (fs.statSync(file).size !== size) bad.push(`${name}: dimensione diversa (${size} → ${fs.statSync(file).size})`)
  }
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue
    if (entry.name in expected) continue
    if (/^(ffmpeg|ffprobe)(\.exe)?$/i.test(entry.name)) continue
    bad.push(`${entry.name}: file estraneo (non proviene dall'archivio llama.cpp)`)
  }
  if (bad.length) {
    console.error('[stage] BINARI INCONSISTENTI:')
    for (const b of bad) console.error('  - ' + b)
    console.error('[stage] rilancia "npm run fetch:bin -- ' + target + ' --force": la radice deve essere solo llama.cpp')
    process.exit(1)
  }
  console.log(`[stage] integrità ok: ${Object.keys(expected).length} file llama.cpp + ffmpeg`)
}

/** Copia i contenuti reali: nel pacchetto i symlink relativi diventerebbero link rotti. */
function copyReal(src, dest) {
  const stat = fs.statSync(src) // segue i symlink
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true })
    for (const name of fs.readdirSync(src)) copyReal(path.join(src, name), path.join(dest, name))
    return
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  fs.chmodSync(dest, stat.mode & 0o777)
}

verify(from)

fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })
copyReal(from, stage)
// il manifest è solo per il controllo, non deve finire nel pacchetto
fs.rmSync(path.join(stage, '.llama-files.json'), { force: true })

let count = 0
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(path.join(dir, entry.name))
    else count++
  }
}
walk(stage)
console.log(`[stage] ${count} file copiati in bin/stage (symlink risolti)`)
