#!/usr/bin/env node
/** Genera dist/SHA256SUMS.txt per tutti gli artefatti distribuibili. */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const dist = path.join(process.cwd(), 'dist')
const files = fs.existsSync(dist)
  ? fs
      .readdirSync(dist)
      .filter((f) => !f.endsWith('.txt') && !f.endsWith('.blockmap') && !f.endsWith('.yml'))
  : []

const lines = files.map((name) => {
  const hash = createHash('sha256').update(fs.readFileSync(path.join(dist, name))).digest('hex')
  return `${hash}  ${name}`
})

fs.mkdirSync(dist, { recursive: true })
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`)
console.log(`[checksums] ${lines.length} file → dist/SHA256SUMS.txt`)
