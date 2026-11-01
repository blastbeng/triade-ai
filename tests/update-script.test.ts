import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { powershellSupervisor } from '../src/main/update-script'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

describe('supervisore PowerShell: contratto dello script', () => {
  const script = powershellSupervisor({
    target: 'C:\\TriadeAI\\TriadeAI.exe',
    newExe: 'C:\\TriadeAI\\dati\\aggiornamenti\\nuovo.exe',
    marker: 'C:\\TriadeAI\\dati\\run\\boot-0.21.0.ok',
    version: '0.21.0',
    pid: 1234,
    parentPid: 4321,
    pending: 'C:\\TriadeAI\\dati\\aggiornamenti\\pending.json',
    esito: 'C:\\TriadeAI\\dati\\aggiornamenti\\esito.json',
    logFile: 'C:\\TriadeAI\\dati\\aggiornamenti\\aggiorna.log'
  })

  it('sostituisce con rename (move), mai con una copia sopra il file in uso', () => {
    expect(script).toContain('Move-Item -LiteralPath $target -Destination $backup')
    expect(script).toContain('Move-Item -LiteralPath $newExe -Destination $target')
    expect(script).toContain('$backup = ')
    expect(script).not.toContain('Copy-Item')
  })

  it('torna indietro solo se il marker di avvio non arriva', () => {
    // niente confronti fra orari di avvio: la sola prova di vita è il marker
    expect(script).toContain('function Test-Marker')
    expect(script).toContain('if (Test-Marker) {')
    expect(script).toContain('WriteEsito "rolledback"')
    expect(script).toMatch(/\$deadline = \(Get-Date\)\.AddSeconds\(\$markerWait\)/)
  })

  it('deferisce l\'esito all\'app con esito.json', () => {
    expect(script).toContain('WriteEsito "swap-failed"')
    expect(script).toContain('UTF8Encoding($false)')
  })

  it('attende anche il launcher portable prima di avviare la nuova versione', () => {
    expect(script).toContain('$parent0')
    expect(script).toContain('GetFileNameWithoutExtension($target)')
  })

  it('l\'app lo lancia staccato e nascosto (nessuna console)', () => {
    const updater = read('src/main/updater.ts')
    expect(updater).toContain("'powershell.exe'")
    expect(updater).toContain("'-ExecutionPolicy'")
    expect(updater).toContain("'aggiorna.ps1'")
    expect(updater).toContain('detached: true')
    // il vecchio watchdog .cmd non deve tornare
    expect(updater).not.toContain('move /Y')
  })

  it('sul portable sostituisce il launcher, non la copia in %TEMP%', () => {
    const updater = read('src/main/updater.ts')
    expect(updater).toContain('PORTABLE_EXECUTABLE_FILE')
    expect(updater).toContain('/[\\\\/]Temp[\\\\/]/i.test(process.execPath)')
  })

  it('non si fida del marker di un tentativo precedente della stessa versione', () => {
    const updater = read('src/main/updater.ts')
    expect(updater).toContain('fs.rmSync(bootMarker(version), { force: true })')
  })
})

/**
 * Esecuzione reale dello script su Windows: l'unico modo per sapere se il
 * supervisore funziona davvero (PowerShell 5.1, rename di file, JSON). Su
 * Linux/macOS viene saltato.
 */
describe.skipIf(process.platform !== 'win32')('supervisore PowerShell: esecuzione', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  })

  const setup = (): {
    dir: string
    target: string
    newExe: string
    marker: string
    pending: string
    esito: string
    logFile: string
  } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triade-upd-'))
    dirs.push(dir)
    const state = path.join(dir, 'dati', 'aggiornamenti')
    const run = path.join(dir, 'dati', 'run')
    fs.mkdirSync(state, { recursive: true })
    fs.mkdirSync(run, { recursive: true })
    const target = path.join(dir, 'TriadeTest.exe')
    const newExe = path.join(state, 'nuovo.exe')
    fs.writeFileSync(target, 'OLD')
    fs.writeFileSync(newExe, 'NEW')
    const pending = path.join(state, 'pending.json')
    fs.writeFileSync(pending, JSON.stringify({ version: '0.21.0' }), 'utf8')
    return {
      dir,
      target,
      newExe,
      marker: path.join(run, 'boot-0.21.0.ok'),
      pending,
      esito: path.join(state, 'esito.json'),
      logFile: path.join(state, 'aggiorna.log')
    }
  }

  const run = (o: Parameters<typeof powershellSupervisor>[0]): void => {
    const file = path.join(path.dirname(o.pending), 'aggiorna.ps1')
    fs.writeFileSync(file, `${powershellSupervisor(o)}\r\n`, 'utf8')
    try {
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
        { stdio: 'pipe', timeout: 120_000 }
      )
    } catch (err) {
      const log = fs.existsSync(o.logFile) ? fs.readFileSync(o.logFile, 'utf8') : '(nessun log)'
      throw new Error(`supervisore fallito: ${String(err)}\n${log}`)
    }
  }

  const base = (
    s: ReturnType<typeof setup>,
    over: Partial<Parameters<typeof powershellSupervisor>[0]> = {}
  ): Parameters<typeof powershellSupervisor>[0] => ({
    target: s.target,
    newExe: s.newExe,
    marker: s.marker,
    version: '0.21.0',
    // pid inesistente (0 sarebbe il processo Idle, sempre vivo): nessuna attesa
    pid: 4_194_301,
    parentPid: 0,
    pending: s.pending,
    esito: s.esito,
    logFile: s.logFile,
    markerWaitSec: 10,
    deadGraceSec: 1,
    swapRetries: 2,
    ...over
  })

  it('marker presente: installa, tiene la nuova versione e pulisce lo stato', () => {
    const s = setup()
    fs.writeFileSync(s.marker, 'ok', 'utf8')
    run(base(s))
    expect(fs.readFileSync(s.target, 'utf8')).toBe('NEW')
    expect(fs.existsSync(`${s.target}.old`)).toBe(false)
    expect(fs.existsSync(s.pending)).toBe(false)
    expect(fs.existsSync(s.esito)).toBe(false)
  }, 60_000)

  it('marker assente: ripristina la versione precedente e lo dichiara', () => {
    const s = setup()
    run(base(s))
    expect(fs.readFileSync(s.target, 'utf8')).toBe('OLD')
    expect(fs.readFileSync(`${s.target}.failed`, 'utf8')).toBe('NEW')
    const esito = JSON.parse(fs.readFileSync(s.esito, 'utf8').replace(/^\uFEFF/, ''))
    expect(esito.result).toBe('rolledback')
    // pending.json resta: è l'app, al riavvio, a mostrare il messaggio
    expect(fs.existsSync(s.pending)).toBe(true)
  }, 60_000)

  it('nuovo eseguibile assente: non tocca niente e scrive swap-failed', () => {
    const s = setup()
    fs.rmSync(s.newExe)
    run(base(s))
    expect(fs.readFileSync(s.target, 'utf8')).toBe('OLD')
    const esito = JSON.parse(fs.readFileSync(s.esito, 'utf8').replace(/^\uFEFF/, ''))
    expect(esito.result).toBe('swap-failed')
    // pending.json resta: è l'app, al riavvio, a dire che l'aggiornamento non
    // è stato applicato (prima restava intatta ma in silenzio)
    expect(fs.existsSync(s.pending)).toBe(true)
  }, 60_000)
})
