import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { posixSupervisor, shLiteral } from '../src/main/update-script'

const opts = (over: Record<string, unknown> = {}): Parameters<typeof posixSupervisor>[0] => ({
  target: '/home/u/Apps/TriadeAI.AppImage',
  newExe: '/home/u/Apps/dati/aggiornamenti/nuovo/TriadeAI.AppImage',
  marker: '/home/u/Apps/dati/run/boot-0.21.2.ok',
  version: '0.21.2',
  pid: 4242,
  pending: '/home/u/Apps/dati/aggiornamenti/pending.json',
  esito: '/home/u/Apps/dati/aggiornamenti/esito.json',
  logFile: '/home/u/Apps/dati/aggiornamenti/aggiorna.log',
  ...over
})

describe('shLiteral', () => {
  it('racchiude fra apici e raddoppia quelli interni', () => {
    expect(shLiteral('/home/u/Apps/TriadeAI.AppImage')).toBe("'/home/u/Apps/TriadeAI.AppImage'")
    expect(shLiteral("/home/u/it's/TriadeAI.AppImage")).toBe("'/home/u/it'\\''s/TriadeAI.AppImage'")
  })
})

describe('supervisore POSIX: contratto dello script', () => {
  const script = posixSupervisor(opts())

  it('sostituisce in place con rename, senza copiare sopra il file in uso', () => {
    expect(script).toContain('mv -f "$target" "$backup"')
    expect(script).toContain('mv -f "$newexe" "$target"')
    expect(script).not.toContain('cp ')
  })

  it('torna indietro solo se il marker non arriva', () => {
    expect(script).toContain('marker_ok()')
    expect(script).toContain('write_esito "rolledback"')
    expect(script).toMatch(/deadline=\$\(\( \$\(date \+%s\) \+ marker_wait \)\)/)
  })

  it('riporta l esito all app e si elimina da solo', () => {
    expect(script).toContain('write_esito "swap-failed"')
    expect(script).toContain('rm -f "$0"')
  })

  it('su swap-failed lascia pending.json: il messaggio lo dá l app al riavvio', () => {
    expect(script).not.toContain('rm -f "$pending"')
  })

  it('è uno script sh valido', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triade-sh-'))
    const file = path.join(dir, 'aggiorna.sh')
    fs.writeFileSync(file, script, 'utf8')
    execFileSync('sh', ['-n', file]) // sintassi: nessun output = ok
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * Esecuzione reale su Linux/macOS: l'app finta è uno script che esce subito,
 * quindi il ramo "nessun marker" si chiude in pochi secondi.
 */
describe.skipIf(process.platform === 'win32')('supervisore POSIX: esecuzione', () => {
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triade-upd-sh-'))
    dirs.push(dir)
    const state = path.join(dir, 'dati', 'aggiornamenti', 'nuovo')
    const run = path.join(dir, 'dati', 'run')
    fs.mkdirSync(state, { recursive: true })
    fs.mkdirSync(run, { recursive: true })
    const target = path.join(dir, 'TriadeTest.AppImage')
    const newExe = path.join(state, 'TriadeTest.AppImage')
    fs.writeFileSync(target, '#!/bin/sh\nexit 0\n# OLD\n', { mode: 0o755 })
    fs.writeFileSync(newExe, '#!/bin/sh\nexit 0\n# NEW\n', { mode: 0o755 })
    const pending = path.join(dir, 'dati', 'aggiornamenti', 'pending.json')
    fs.writeFileSync(pending, JSON.stringify({ version: '0.21.2' }), 'utf8')
    return {
      dir,
      target,
      newExe,
      marker: path.join(run, 'boot-0.21.2.ok'),
      pending,
      esito: path.join(dir, 'dati', 'aggiornamenti', 'esito.json'),
      logFile: path.join(dir, 'dati', 'aggiornamenti', 'aggiorna.log')
    }
  }

  /** pid di un processo già terminato: lo script non deve attendere nulla */
  const deadPid = async (): Promise<number> => {
    const child = spawn('sh', ['-c', 'exit 0'])
    await new Promise((r) => child.on('exit', r))
    return child.pid ?? 0
  }

  const run = async (
    s: ReturnType<typeof setup>,
    over: Record<string, unknown> = {}
  ): Promise<void> => {
    const file = path.join(s.dir, 'dati', 'aggiornamenti', 'aggiorna.sh')
    fs.writeFileSync(
      file,
      posixSupervisor(
        opts({
          target: s.target,
          newExe: s.newExe,
          marker: s.marker,
          pending: s.pending,
          esito: s.esito,
          logFile: s.logFile,
          pid: await deadPid(),
          ...over
        })
      ),
      { mode: 0o755 }
    )
    try {
      execFileSync('sh', [file], { stdio: 'pipe', timeout: 60_000 })
    } catch (err) {
      const log = fs.existsSync(s.logFile) ? fs.readFileSync(s.logFile, 'utf8') : '(nessun log)'
      throw new Error(`supervisore fallito: ${String(err)}\n${log}`)
    }
  }

  it('la nuova versione scrive il marker: installa e pulisce lo stato', async () => {
    const s = setup()
    // l'AppImage nuova finta si segna da sola come avviata, come fa l'app vera
    fs.writeFileSync(
      s.newExe,
      `#!/bin/sh\necho ok > '${s.marker}'\nexit 0\n# NEW\n`,
      { mode: 0o755 }
    )
    await run(s, { markerWaitSec: 20 })
    expect(fs.readFileSync(s.target, 'utf8')).toContain('NEW')
    expect(fs.existsSync(`${s.target}.old`)).toBe(false)
    expect(fs.existsSync(s.pending)).toBe(false)
    expect(fs.existsSync(s.esito)).toBe(false)
    // lo script si elimina da solo
    expect(fs.existsSync(path.join(s.dir, 'dati', 'aggiornamenti', 'aggiorna.sh'))).toBe(false)
  }, 60_000)

  it('marker assente: ripristina la versione precedente', async () => {
    const s = setup()
    await run(s, { markerWaitSec: 20, swapRetries: 2 })
    expect(fs.readFileSync(s.target, 'utf8')).toContain('OLD')
    expect(fs.readFileSync(`${s.target}.failed`, 'utf8')).toContain('NEW')
    const esito = JSON.parse(fs.readFileSync(s.esito, 'utf8'))
    expect(esito.result).toBe('rolledback')
    expect(fs.existsSync(s.pending)).toBe(true)
  }, 60_000)

  it('nuovo eseguibile assente: lascia tutto com e scrive swap-failed', async () => {
    const s = setup()
    fs.rmSync(s.newExe)
    await run(s, { swapRetries: 1 })
    expect(fs.readFileSync(s.target, 'utf8')).toContain('OLD')
    const esito = JSON.parse(fs.readFileSync(s.esito, 'utf8'))
    expect(esito.result).toBe('swap-failed')
    // pending.json resta: è l'app, al riavvio, a dire che l'aggiornamento non
    // è stato applicato (prima restava intatta ma in silenzio)
    expect(fs.existsSync(s.pending)).toBe(true)
  }, 60_000)
})
