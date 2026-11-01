import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultPersonas } from '../src/shared/personas'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { turnLimitReached } from '../src/shared/turns'
import {
  impossibleTooEarly,
  parseClosing,
  stripClosingMarkers
} from '../src/main/debate/conclusion'
import type { DebateEvent } from '../src/shared/types'

/**
 * Il dibattito non deve interrompersi “da solo”: con `maxTurns = 0` continua
 * finché il gruppo non chiude con un consenso o con l'impossibilità dichiarata,
 * e in ogni caso la chiusura lascia una risposta finale visibile.
 */
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'triade-conclusion-'))
process.env.PORTABLE_EXECUTABLE_DIR = dataRoot

const personas = defaultPersonas('it').slice(0, 3)
const settings = {
  personaCount: 3,
  personas,
  backend: 'llama',
  backendByPersona: {},
  remote: {} as Record<string, unknown>,
  models: { active: 'modello', byPersona: {}, byPersonaBackend: {}, custom: [] },
  gpus: { byPersona: {} },
  toolsEnabled: false,
  temperature: 0.5,
  maxTokensPerTurn: 200,
  maxTurns: 0,
  contextSize: 4096,
  compressionThreshold: 0.75,
  ui: { language: 'it' },
  embeddings: { engine: 'llama', model: '' },
  search: {},
  asr: {}
}

/** risposte degli agenti, una per turno; esaurite le risposte si ripete l'ultima */
let replies: string[] = []
let judgeOk = true

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    getPath: () => dataRoot,
    getAppPath: () => dataRoot
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

vi.mock('../src/main/settings', () => ({ getSettings: () => settings, saveSettings: () => settings }))

vi.mock('../src/main/llama/server', () => ({
  llamaPool: {
    ensure: async () => ({ baseUrl: 'http://127.0.0.1:9', device: null }),
    effectiveContext: () => 4096,
    status: () => [],
    stopAll: async () => undefined
  }
}))

vi.mock('../src/main/llama/client', () => ({
  chat: async (_baseUrl: string, req: { messages: { role: string; content: unknown }[] }) => {
    // cede il turno ai timer: senza questo il ciclo (che nella realtà attende la
    // rete) gira solo in microtask e affama il polling dei test
    await new Promise((r) => setTimeout(r, 1))
    const system = String(req.messages?.[0]?.content ?? '')
    const base = { reasoning: '', toolCalls: [], interrupted: false }
    if (system.includes('Sei un giudice')) {
      return {
        ...base,
        content: judgeOk
          ? JSON.stringify({ consenso: true, risposta: 'risposta finale validata', motivo: 'ok' })
          : JSON.stringify({ consenso: false, risposta: '', motivo: 'restano disaccordi' })
      }
    }
    if (system.includes('Chiudi un dibattito')) {
      return { ...base, content: 'sintesi finale del dibattito' }
    }
    if (system.includes('PROTOCOLLO DEL DIBATTITO')) {
      const next = replies.length > 1 ? replies.shift()! : (replies[0] ?? 'intervento')
      return { ...base, content: next }
    }
    if (system.includes('Comprimi una discussione')) return { ...base, content: 'memoria' }
    return { ...base, content: 'titolo breve' }
  },
  countTokens: async () => 20
}))

vi.mock('../src/main/memory/integrate', () => ({
  recallBlock: () => '',
  rememberTurn: () => undefined,
  rememberUserNote: () => undefined,
  distillSession: async () => 0
}))

type EngineModule = typeof import('../src/main/debate/engine')

let engineModule: EngineModule

beforeAll(async () => {
  engineModule = await import('../src/main/debate/engine')
})

beforeEach(() => {
  replies = []
  judgeOk = true
  settings.maxTurns = 0
})

afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

const agentTurns = (session: { turns: { agentId: string }[] }): number =>
  session.turns.filter((t) => t.agentId !== 'utente').length

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('marcatori di chiusura', () => {
  it('riconosce consenso e impossibilità, con e senza testo', () => {
    expect(parseClosing('basta, [[CONSENSO: la risposta è 42]]')).toEqual({
      kind: 'consenso',
      answer: 'la risposta è 42'
    })
    expect(parseClosing('[[CONSENSO]]')).toEqual({ kind: 'consenso', answer: '' })
    expect(parseClosing('[[IMPOSSIBILE: dati non verificabili]]')).toEqual({
      kind: 'impossibile',
      answer: 'dati non verificabili'
    })
    expect(parseClosing('nessun marcatore qui')).toBeNull()
  })

  it('toglie i marcatori dal testo mostrato in chat', () => {
    expect(stripClosingMarkers('ho finito [[CONSENSO: ok]]')).toBe('ho finito')
    expect(stripClosingMarkers('[[IMPOSSIBILE: no]]')).toBe('')
  })

  it('l’impossibilità non si dichiara al primo turno', () => {
    expect(impossibleTooEarly(1)).toBe(true)
    expect(impossibleTooEarly(2)).toBe(true)
    expect(impossibleTooEarly(3)).toBe(false)
  })
})

describe('limite di turni', () => {
  it('0 = illimitato, un tetto positivo vale dal turno indicato', () => {
    expect(turnLimitReached(0, 500)).toBe(false)
    expect(turnLimitReached(undefined, 500)).toBe(false)
    expect(turnLimitReached(5, 4)).toBe(false)
    expect(turnLimitReached(5, 5)).toBe(true)
  })

  it('il default delle impostazioni è illimitato', () => {
    expect(DEFAULT_SETTINGS.maxTurns).toBe(0)
  })
})

describe('fine del dibattito', () => {
  it('con maxTurns 0 il gruppo continua invece di fermarsi', async () => {
    replies = ['intervento uno', 'intervento due']
    const engine = new engineModule.DebateEngine()
    const session = await engine.start('argomento senza tetto', [], personas[0].id)
    await waitFor(() => agentTurns(session) >= 8)
    await engine.pause()
    await engine.halt()

    expect(agentTurns(session)).toBeGreaterThanOrEqual(8)
    expect(session.state).not.toBe('concluded')
    expect(session.conclusion).toBeUndefined()
  })

  it('con un tetto configurato chiude con una sintesi finale', async () => {
    settings.maxTurns = 2
    replies = ['intervento uno', 'intervento due']
    const engine = new engineModule.DebateEngine()
    const session = await engine.start('argomento con tetto', [], personas[0].id)
    await waitFor(() => session.state === 'concluded')

    expect(agentTurns(session)).toBe(2)
    expect(session.conclusion?.kind).toBe('limite')
    expect(session.conclusion?.answer).toBe('sintesi finale del dibattito')
  })

  it('il consenso validato chiude con la risposta del giudice', async () => {
    replies = ['prima tesi', '[[CONSENSO: la risposta è 42]]']
    const engine = new engineModule.DebateEngine()
    const events: DebateEvent[] = []
    engine.on('event', (e: DebateEvent) => events.push(e))
    const session = await engine.start('argomento con consenso', [], personas[0].id)
    await waitFor(() => session.state === 'concluded')

    expect(session.conclusion?.kind).toBe('consenso')
    expect(session.conclusion?.answer).toBe('risposta finale validata')
    expect(session.conclusion?.validatedBy).toBeTruthy()
    // il campo storico resta allineato per le versioni precedenti
    expect(session.consensus?.answer).toBe('risposta finale validata')
    expect(events.some((e) => e.type === 'conclusion')).toBe(true)
  })

  it('l’impossibilità dichiarata chiude indicando il motivo', async () => {
    replies = ['prima tesi', 'seconda tesi', '[[IMPOSSIBILE: i dati non sono verificabili]]']
    const engine = new engineModule.DebateEngine()
    const session = await engine.start('argomento impossibile', [], personas[0].id)
    await waitFor(() => session.state === 'concluded')

    expect(session.conclusion?.kind).toBe('impossibile')
    expect(session.conclusion?.answer).toBe('i dati non sono verificabili')
    expect(session.consensus).toBeUndefined()
  })

  it('una chiusura dichiarata troppo presto viene ignorata', async () => {
    replies = ['[[IMPOSSIBILE: troppo presto]]', 'continuo a discutere']
    const engine = new engineModule.DebateEngine()
    const events: DebateEvent[] = []
    engine.on('event', (e: DebateEvent) => events.push(e))
    const session = await engine.start('argomento troppo presto', [], personas[0].id)
    await waitFor(() => agentTurns(session) >= 2)
    await engine.pause()
    await engine.halt()

    expect(session.conclusion).toBeUndefined()
    expect(
      events.some((e) => e.type === 'log' && String(e.message).includes('troppo breve'))
    ).toBe(true)
  })
})
