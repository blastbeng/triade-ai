#!/usr/bin/env node
/**
 * Avanza la versione (semver) dopo ogni modifica:
 *   npm run release:patch   correzione di bug
 *   npm run release:minor   nuova funzionalità compatibile
 *   npm run release:major   cambiamento incompatibile
 * Non crea commit: la versione entra nel commit della modifica stessa.
 */
import fs from 'node:fs'

const kind = process.argv[2]
if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error('uso: node scripts/bump.mjs patch|minor|major')
  process.exit(1)
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const [major, minor, patch] = String(pkg.version).split('.').map(Number)
const next =
  kind === 'major'
    ? `${major + 1}.0.0`
    : kind === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`

pkg.version = next
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`versione: ${major}.${minor}.${patch} → ${next}`)
