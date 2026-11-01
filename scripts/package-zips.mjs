#!/usr/bin/env node
/**
 * Dopo la build crea due archivi pronti per le release GitHub:
 *   dist/TriadeAI-<versione>-win-portable.zip   → contiene il .exe
 *   dist/TriadeAI-<versione>-linux-appimage.zip → contiene la .AppImage
 *
 * Ogni zip include anche un file VERSION.txt con versione, data, SHA-256 e
 * istruzioni di avvio. Usa `zip` se disponibile, altrimenti PowerShell o 7z.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const dist = path.join(process.cwd(), 'dist')
if (!fs.existsSync(dist)) {
  console.log('[zip] dist/ assente: esegui prima la build')
  process.exit(0)
}

const files = fs.readdirSync(dist)
const pick = (re) => files.filter((f) => re.test(f) && !f.endsWith('.zip'))

const targets = [
  {
    artifact: pick(/TriadeAI-[\d.]+-portable\.exe$/i),
    suffix: 'win-portable',
    hint: 'Estrai e avvia TriadeAI-<versione>-portable.exe. Nessuna installazione.\r\nI modelli vengono scaricati al primo avvio in data/ accanto all\'exe.'
  },
  {
    artifact: pick(/TriadeAI-[\d.]+\.AppImage$/i),
    suffix: 'linux-appimage',
    hint: 'Rendi eseguibile l\'AppImage (chmod +x) e avviala.\r\nI modelli vengono scaricati al primo avvio in data/ accanto al file.'
  }
]

function zipFiles(zipPath, entries, cwd) {
  const hasZip = (() => {
    try {
      execFileSync('which', ['zip'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()
  if (hasZip) {
    execFileSync('zip', ['-q', '-j', zipPath, ...entries], { cwd, stdio: 'inherit' })
    return
  }
  if (process.platform === 'win32') {
    const list = entries.map((e) => `'${path.join(cwd, e)}'`).join(',')
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Force -Path ${list} -DestinationPath '${zipPath}'`],
      { stdio: 'inherit' }
    )
    return
  }
  execFileSync('7z', ['a', '-tzip', zipPath, ...entries], { cwd, stdio: 'inherit' })
}

let created = 0
for (const target of targets) {
  if (!target.artifact.length) {
    console.log(`[zip] nessun artefatto per ${target.suffix}`)
    continue
  }
  const artifact = target.artifact[0]
  const version = /TriadeAI-([\d.]+)/.exec(artifact)?.[1] ?? 'unknown'
  const zipName = `TriadeAI-${version}-${target.suffix}.zip`
  const zipPath = path.join(dist, zipName)
  fs.rmSync(zipPath, { force: true })

  const hash = createHash('sha256')
    .update(fs.readFileSync(path.join(dist, artifact)))
    .digest('hex')
  const note = `TriadeAI ${version} — ${target.suffix}\n` +
    `file: ${artifact}\nsha256: ${hash}\ndata: ${new Date().toISOString()}\n\n${target.hint}\n`
  const noteFile = `VERSION-${target.suffix}.txt`
  fs.writeFileSync(path.join(dist, noteFile), note)

  zipFiles(zipPath, [artifact, noteFile], dist)
  fs.rmSync(path.join(dist, noteFile), { force: true })
  const size = (fs.statSync(zipPath).size / 1024 ** 2).toFixed(0)
  console.log(`[zip] ${zipName} (${size} MB) ← ${artifact}`)
  created++
}

if (!created) console.log('[zip] niente da impacchettare')
