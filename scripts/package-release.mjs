#!/usr/bin/env node
/**
 * Prepara gli archivi per la pagina Releases di GitHub:
 *
 *   dist/TriadeAI-<versione>-windows-x64-portable.zip      → contiene il .exe
 *   dist/TriadeAI-<versione>-linux-x64-appimage.tar.gz    → contiene la .AppImage
 *
 * Il tar.gz conserva il bit eseguibile dell'AppImage (un .zip lo perderebbe).
 * Ogni archivio include un VERSION-*.txt con versione, SHA-256 e istruzioni.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const dist = path.join(process.cwd(), 'dist')
if (!fs.existsSync(dist)) {
  console.log('[release] dist/ assente: esegui prima la build')
  process.exit(0)
}

// Nomi fissi DENTRO gli archivi: la versione sta nel nome dell'archivio, non
// nel file eseguibile. Convenzione: TriadeAI.exe (Windows), TriadeAI.AppImage (Linux).
// AppImage richiede l'estensione .AppImage per essere eseguibile: mantenuta.
const FIXED_EXE = 'TriadeAI.exe'
const FIXED_IMG = 'TriadeAI.AppImage'
for (const f of fs.readdirSync(dist)) {
  if (f === FIXED_EXE || f === FIXED_IMG) continue
  if (/\.exe$/i.test(f) && /^TriadeAI/i.test(f) && !/unpacked/i.test(f)) {
    fs.renameSync(path.join(dist, f), path.join(dist, FIXED_EXE))
    console.log(`[release] ${f} → ${FIXED_EXE}`)
  } else if (/\.AppImage$/i.test(f) && /^TriadeAI/i.test(f)) {
    fs.renameSync(path.join(dist, f), path.join(dist, FIXED_IMG))
    console.log(`[release] ${f} → ${FIXED_IMG}`)
  }
}
try {
  fs.chmodSync(path.join(dist, FIXED_IMG), 0o755)
} catch {
  /* su Windows non serve */
}

const files = fs.readdirSync(dist)
const pick = (re) => files.filter((f) => re.test(f))[0] ?? ''

const exe = files.find((f) => f.toLowerCase() === 'triadeai.exe') ?? ''
const appimage = files.find((f) => f.toLowerCase() === 'triadeai.appimage') ?? ''
const version =
  /TriadeAI-(\d+(?:\.\d+)*)/.exec(exe || appimage)?.[1] ??
  JSON.parse(fs.readFileSync('package.json', 'utf8')).version

function hashOf(file) {
  return createHash('sha256').update(fs.readFileSync(path.join(dist, file))).digest('hex')
}

function writeNote(name, artifact, hint) {
  const note = `TriadeAI ${version}\n` +
    `file: ${artifact}\nsha256: ${hashOf(artifact)}\n` +
    `built: ${new Date().toISOString()}\n\n${hint}\n`
  fs.writeFileSync(path.join(dist, name), note)
}

function zip(file, entries) {
  const zipPath = path.join(dist, file)
  fs.rmSync(zipPath, { force: true })
  try {
    execFileSync('zip', ['-q', '-j', zipPath, ...entries], { cwd: dist, stdio: 'inherit' })
    return
  } catch {
    // Windows senza zip.exe
  }
  const list = entries.map((e) => `'${path.join(dist, e)}'`).join(',')
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Force -Path ${list} -DestinationPath '${zipPath}'`
  ], { stdio: 'inherit' })
}

function tarGz(file, entries) {
  const out = path.join(dist, file)
  fs.rmSync(out, { force: true })
  // -C dist: dentro l'archivio i file stanno in radice, permessi preservati
  execFileSync('tar', ['-czf', out, '-C', dist, ...entries], { stdio: 'inherit' })
}

let made = 0

if (exe) {
  writeNote(
    'VERSION-windows.txt',
    exe,
    'Estrai lo zip e avvia TriadeAI.exe. Nessuna installazione.\r\nI modelli vengono scaricati al primo avvio in data\\ accanto all\'eseguibile.'
  )
  const name = `TriadeAI-${version}-windows-x64-portable.zip`
  zip(name, [exe, 'VERSION-windows.txt'])
  console.log(`[release] ${name} (${(fs.statSync(path.join(dist, name)).size / 1024 ** 2).toFixed(0)} MB) ← ${exe}`)
  fs.rmSync(path.join(dist, 'VERSION-windows.txt'), { force: true })
  made++
} else {
  console.log('[release] nessun .exe trovato')
}

if (appimage) {
  writeNote(
    'VERSION-linux.txt',
    appimage,
    'Estrai con: tar -xzf TriadeAI-<versione>-linux-x64-appimage.tar.gz\r\nPoi: chmod +x TriadeAI.AppImage && ./TriadeAI.AppImage\r\nI modelli vengono scaricati al primo avvio in data/ accanto al file.'
  )
  const name = `TriadeAI-${version}-linux-x64-appimage.tar.gz`
  tarGz(name, [appimage, 'VERSION-linux.txt'])
  console.log(`[release] ${name} (${(fs.statSync(path.join(dist, name)).size / 1024 ** 2).toFixed(0)} MB) ← ${appimage}`)
  fs.rmSync(path.join(dist, 'VERSION-linux.txt'), { force: true })
  made++
} else {
  console.log('[release] nessuna .AppImage trovata')
}

if (!made) console.log('[release] niente da impacchettare')
