import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { submitTarget } from '../src/main/debate/target'
import type { Session } from '../src/shared/types'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

const session = (id: string, turns = 3): Pick<Session, 'id' | 'turns'> => ({
  id,
  turns: Array.from({ length: turns }, () => ({}) as never)
})

/**
 * Il contesto di ogni sessione deve restare suo: l'engine continuava la chat che
 * aveva in memoria anche quando l'interfaccia ne mostrava un'altra, quindi le tre
 * colonne sembravano le stesse in ogni sessione (solo la memoria è condivisa).
 */
describe('a quale sessione appartiene un messaggio', () => {
  it('la chat aperta comanda: un altro id fa caricare quella sessione', () => {
    expect(submitTarget(session('A'), 'B')).toEqual({ kind: 'open', sessionId: 'B' })
  })

  it('se la chat aperta è quella in memoria, si continua', () => {
    expect(submitTarget(session('A'), 'A')).toEqual({ kind: 'continue', sessionId: 'A' })
  })

  it('su una chat nuova la sessione in memoria non va continuata', () => {
    expect(submitTarget(session('A'), null)).toEqual({ kind: 'new' })
  })

  it('chat nuova anche quando l engine è già vuoto', () => {
    expect(submitTarget(null, null)).toEqual({ kind: 'new' })
  })

  it('senza indicazione resta il comportamento storico (continua se ha turni)', () => {
    expect(submitTarget(session('A'), undefined)).toEqual({ kind: 'continue', sessionId: 'A' })
    expect(submitTarget(session('A', 0), undefined)).toEqual({ kind: 'new' })
    expect(submitTarget(null, undefined)).toEqual({ kind: 'new' })
  })
})

describe('cambio sessione: contesto isolato anche nel codice collegato', () => {
  const engine = read('src/main/debate/engine.ts')
  const ipc = read('src/main/ipc.ts')
  const preload = read('src/preload/index.ts')
  const app = read('src/renderer/src/App.tsx')

  it('l engine rispetta la sessione richiesta nel submit', () => {
    expect(engine).toContain('submitTarget(this.session, sessionId)')
    expect(engine).toContain("if (target.kind === 'open') await this.open(target.sessionId)")
    expect(engine).toContain("if (target.kind === 'new' && this.session) await this.reset()")
  })

  it('aprire una chat ferma il ciclo della precedente e ne salva lo stato', () => {
    const open = engine.slice(engine.indexOf('async open(id: string)'))
    expect(open).toContain('await this.halt()')
    expect(open).toContain("this.setState('paused')")
    expect(open).toContain("this.emitEvent({ type: 'session', session: loaded })")
  })

  it('la chat scelta nell interfaccia arriva fino all engine', () => {
    // App -> preload -> ipc: l'id non deve perdersi per strada
    expect(app).toContain('window.triade.submit(topic, files, personaId, session?.id ?? null)')
    expect(preload).toContain("ipcRenderer.invoke('debate:submit', { topic, files, personaId, sessionId })")
    expect(ipc).toContain('engine.submit(payload.topic, attachments, payload.personaId, payload.sessionId)')
  })

  it('aprire una sessione dalla sidebar la rende corrente (non solo letta da disco)', () => {
    expect(app).toContain('await window.triade.openSession(id)')
    expect(preload).toContain("ipcRenderer.invoke('session:open', id)")
    expect(ipc).toContain("ipcMain.handle('session:open', (_e, id: string) => engine.open(id))")
  })

  it('cambiando sessione il testo in streaming viene azzerato', () => {
    const switchCase = app.slice(app.indexOf("case 'session':"))
    expect(switchCase.slice(0, 400)).toContain('setStream(null)')
    expect(switchCase.slice(0, 400)).toContain('setStreamReasoning(null)')
  })
})
