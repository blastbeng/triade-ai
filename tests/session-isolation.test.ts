import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultPersonas } from '../src/shared/personas'
import type { Session } from '../src/shared/types'

/**
 * Verifica reale dell'isolamento: due sessioni sullo stesso engine non devono
 * scambiarsi i turni, e un messaggio inviato con una chat aperta in interfaccia
 * deve finire in quella chat (non in quella che l'engine aveva in memoria).
 *
 * Modello, GPU e memoria vettoriale sono finti: qui conta solo il legame
 * sessione ↔ contesto, che è ciò che si rompeva.
 */
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'triade-iso-'))
process.env.PORTABLE_EXECUTABLE_DIR = dataRoot

const personas = defaultPersonas('it').slice(0, 1)
const settings = {
  personaCount: 1,
  personas,
  personaBackends: {} as Record<string, string>,
  backend: 'llama',
  backendByPersona: {} as Record<string, string>,
  remote: {} as Record<string, unknown>,
  models: { active: 'modello', byPersona: {}, byPersonaBackend: {}, custom: [] },
  gpus: { byPersona: {} },
  toolsEnabled: false,
  temperature: 0.5,
  maxTokensPerTurn: 200,
  maxTurns: 1,
  contextSize: 4096,
  compressionThreshold: 0.75,
  ui: { language: 'it' },
  embeddings: { engine: 'llama', model: '' },
  search: {},
  asr: {}
}

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
  chat: async () => ({
    content: 'risposta di prova',
    reasoning: '',
    toolCalls: [],
    interrupted: false
  }),
  countTokens: async () => 20
}))

vi.mock('../src/main/memory/integrate', () => ({
  recallBlock: () => '',
  rememberTurn: () => undefined,
  rememberUserNote: () => undefined,
  distillSession: async () => 0
}))

type EngineModule = typeof import('../src/main/debate/engine')
type StoreModule = typeof import('../src/main/debate/store')

let engineModule: EngineModule
let store: StoreModule
let engine: InstanceType<EngineModule['DebateEngine']>

beforeAll(async () => {
  engineModule = await import('../src/main/debate/engine')
  store = await import('../src/main/debate/store')
  engine = new engineModule.DebateEngine()
})

afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

/** sessione su disco con turni propri (come se fosse già stata usata) */
function seeded(topic: string, texts: string[]): Session {
  const s = store.newSession(topic)
  s.turns = texts.map((text, i) => ({
    id: `${s.id}-${i}`,
    agentId: i % 2 === 0 ? 'utente' : 'persona-1',
    name: i % 2 === 0 ? 'Utente' : 'Chat1',
    text,
    ts: Date.now() + i,
    tokensIn: 0,
    tokensOut: 0,
    tools: []
  }))
  s.turnIndex = s.turns.length
  s.state = 'stopped'
  store.saveSession(s)
  return s
}

describe('isolamento del contesto fra sessioni', () => {
  it('aprire una sessione la rende corrente e conserva i suoi turni', async () => {
    const a = seeded('argomento A', ['domanda A', 'risposta A'])
    const b = seeded('argomento B', ['domanda B', 'risposta B', 'seguito B'])

    await engine.open(a.id)
    expect(engine.current?.id).toBe(a.id)
    expect(engine.current?.turns.map((t) => t.text)).toEqual(['domanda A', 'risposta A'])

    await engine.open(b.id)
    expect(engine.current?.id).toBe(b.id)
    expect(engine.current?.turns.map((t) => t.text)).toEqual([
      'domanda B',
      'risposta B',
      'seguito B'
    ])
    // la prima sessione non ha preso nulla dalla seconda
    expect(store.loadSession(a.id)?.turns.map((t) => t.text)).toEqual(['domanda A', 'risposta A'])
  })

  it('il messaggio va nella sessione aperta in interfaccia, non in quella in memoria', async () => {
    const a = seeded('argomento A2', ['domanda A2'])
    const b = seeded('argomento B2', ['domanda B2'])
    await engine.open(a.id)

    // l'utente ha aperto B nell'interfaccia e scrive: deve finire in B
    const res = await engine.submit('nuovo messaggio per B', [], undefined, b.id)
    await engine.halt()
    expect(res.id).toBe(b.id)
    // i turni dell'utente restano in B, e nulla di A finisce qui
    expect(res.turns.filter((t) => t.agentId === 'utente').map((t) => t.text)).toEqual([
      'domanda B2',
      'nuovo messaggio per B'
    ])
    expect(res.turns.some((t) => t.text.includes('A2'))).toBe(false)
    expect(store.loadSession(a.id)?.turns.map((t) => t.text)).toEqual(['domanda A2'])
  })

  it('su una chat nuova il contesto precedente non viene riusato', async () => {
    const a = seeded('argomento A3', ['domanda A3'])
    await engine.open(a.id)
    const res = await engine.submit('domanda nuova chat', [], undefined, null)
    await engine.halt()
    expect(res.id).not.toBe(a.id)
    expect(res.turns.filter((t) => t.agentId === 'utente').map((t) => t.text)).toEqual([
      'domanda nuova chat'
    ])
    expect(res.turns.some((t) => t.text.includes('A3'))).toBe(false)
    expect(store.loadSession(a.id)?.turns.map((t) => t.text)).toEqual(['domanda A3'])
  })

  it('lasciare una sessione in corso la mette in pausa su disco', async () => {
    const a = seeded('argomento A4', ['domanda A4'])
    const b = seeded('argomento B4', ['domanda B4'])
    await engine.open(a.id)
    // simula un ciclo in corso sulla sessione A
    ;(engine.current as Session).state = 'running'
    store.saveSession(engine.current as Session)

    await engine.open(b.id)
    expect(store.loadSession(a.id)?.state).toBe('paused')
    expect(engine.current?.id).toBe(b.id)
  })
})
