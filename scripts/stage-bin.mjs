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

fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })
copyReal(from, stage)

let count = 0
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(path.join(dir, entry.name))
    else count++
  }
}
walk(stage)
console.log(`[stage] ${count} file copiati in bin/stage (symlink risolti)`)
