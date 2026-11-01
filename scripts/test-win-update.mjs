// Verifica su Windows NATIVO la meccanica di sostituzione usata dall'auto-update:
// move (rename) dell'exe in uso + rollback. Non richiede Electron né rete.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (process.platform !== 'win32') {
  console.log('[test] salto: questo test gira solo su Windows')
  process.exit(0)
}

// contratto: lo script generato dall'app deve usare rename con retry, non copy
const src = fs.readFileSync('src/main/updater.ts', 'utf8')
for (const needle of ['move /Y', 'for /L %%i', 'start ""', '.old']) {
  if (!src.includes(needle)) {
    console.error(`[test] updater.ts non contiene "${needle}"`)
    process.exit(1)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'triade-upd-'))
const target = path.join(tmp, 'TriadeAI-test.exe')
const newExe = path.join(tmp, 'nuovo', 'TriadeAI-test.exe')
fs.mkdirSync(path.dirname(newExe), { recursive: true })
fs.writeFileSync(target, 'OLD')
fs.writeFileSync(newExe, 'NEW-VERSION')

const cmd = path.join(tmp, 'swap.cmd')
fs.writeFileSync(
  cmd,
  [
    '@echo off',
    `move /Y "${target}" "${target}.old" >nul`,
    `move /Y "${newExe}" "${target}" >nul`,
    `if not exist "${target}" move /Y "${target}.old" "${target}" >nul`
  ].join('\r\n')
)
execFileSync('cmd.exe', ['/c', cmd], { stdio: 'inherit' })

const got = fs.readFileSync(target, 'utf8')
const old = fs.readFileSync(`${target}.old`, 'utf8')
if (got !== 'NEW-VERSION' || old !== 'OLD') {
  console.error(`[test] swap fallito: nuovo=${got} backup=${old}`)
  process.exit(1)
}

fs.renameSync(`${target}.old`, target)
if (fs.readFileSync(target, 'utf8') !== 'OLD') {
  console.error('[test] rollback fallito')
  process.exit(1)
}

// 3) watchdog: se la nuova versione non è viva, lo script deve ripristinare l'originale
const target2 = path.join(tmp, 'Watchdog.exe')
fs.writeFileSync(target2, 'NEW-BROKEN')
fs.writeFileSync(`${target2}.old`, 'OLD-GOOD')
const wd = path.join(tmp, 'watchdog.cmd')
fs.writeFileSync(
  wd,
  [
    '@echo off',
    'tasklist /FI "IMAGENAME eq triade-nonexistent-xyz.exe" | find /I "triade-nonexistent-xyz.exe" >nul',
    'if errorlevel 1 (',
    `  move /Y "${target2}" "${target2}.failed" >nul`,
    `  move /Y "${target2}.old" "${target2}" >nul`,
    ')'
  ].join('\r\n')
)
execFileSync('cmd.exe', ['/c', wd], { stdio: 'inherit' })
if (fs.readFileSync(target2, 'utf8') !== 'OLD-GOOD') {
  console.error('[test] il watchdog non ha ripristinato la versione precedente')
  process.exit(1)
}
console.log('[test] watchdog: ripristino della versione precedente OK')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('[test] swap rename + rollback su Windows: OK')
