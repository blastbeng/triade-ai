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

fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })
// dereference: le .so di llama.cpp sono symlink relativi (libX.so.0 -> libX.so.0.8.0)
// che nel pacchetto diventerebbero link rotti
fs.cpSync(from, stage, { recursive: true, dereference: true })

const files = fs.readdirSync(stage)
console.log(`[stage] ${files.length} file copiati in bin/stage`)
for (const f of files.slice(0, 20)) console.log(`  ${f}`)
