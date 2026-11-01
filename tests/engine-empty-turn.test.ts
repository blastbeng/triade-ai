import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultPersonas } from '../src/shared/personas'
import { EMPTY_TURN, visibleTurn } from '../src/shared/turns'
import type { DebateEvent } from '../src/shared/types'

/**
 * “Ogni tanto in chat compare [nessun contenuto]”: era il segnaposto scritto
 * quando un agente produceva solo un marcatore (`[[PASSA A: …]]` o
 * `[[CONSENSO: …]]`). Il turno deve restare in trascrizione — serve a rotazione
 * e limite turni — ma non deve diventare una bolla vuota.
 */
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'triade-empty-'))
// le sessioni di prova non devono finire in dati/ del repository
process.env.PORTABLE_EXECUTABLE_DIR = dataRoot

const personas = defaultPersonas('it').slice(0, 2)
const settings = {
  personaCount: 2,
  personas,
  backend: 'llama',
  backendByPersona: {},
  remote: {},
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

/** il dibattito risponde SOLO col passaggio di parola; tutto il resto è rumore */
vi.mock('../src/main/llama/client', () => ({
  chat: async (_baseUrl: string, req: { messages: { content: unknown }[] }) => {
    const system = String(req.messages?.[0]?.content ?? '')
    const handoff = system.includes('PROTOCOLLO DEL DIBATTITO')
    return {
      content: handoff ? `[[PASSA A: ${personas[1].name}]]` : 'titolo breve',
      reasoning: '',
      toolCalls: [],
      interrupted: false
    }
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
type StoreModule = typeof import('../src/main/debate/store')

let engineModule: EngineModule
let store: StoreModule

beforeAll(async () => {
  engineModule = await import('../src/main/debate/engine')
  store = await import('../src/main/debate/store')
})

afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

describe('turno senza testo (solo [[PASSA A: …]] o [[CONSENSO: …]])', () => {
  it('non produce una bolla e non scrive il segnaposto', async () => {
    const engine = new engineModule.DebateEngine()
    const events: DebateEvent[] = []
    engine.on('event', (e: DebateEvent) => events.push(e))

    const session = await engine.start('domanda di prova', [], personas[0].id)
    await engine.halt()

    const agentTurns = session.turns.filter((t) => t.agentId !== 'utente')
    expect(agentTurns).toHaveLength(1)
    // il turno resta in trascrizione ma vuoto: niente testo inventato
    expect(agentTurns[0].text).toBe('')
    expect(session.turns.some((t) => t.text.includes(EMPTY_TURN))).toBe(false)
    // nessun evento 'turn': la colonna non riceve nulla da disegnare
    expect(events.filter((e) => e.type === 'turn')).toHaveLength(0)
    // il passaggio di parola resta valido
    expect(session.nextSpeakerId).toBe(personas[1].id)
  })

  it('la sidebar non conta i turni vuoti', async () => {
    const session = store.newSession('conteggio turni')
    session.turns = [
      {
        id: 'a',
        agentId: 'utente',
        name: 'Utente',
        text: 'domanda',
        ts: 1,
        tokensIn: 0,
        tokensOut: 0,
        tools: []
      },
      {
        id: 'b',
        agentId: personas[0].id,
        name: personas[0].name,
        text: '',
        ts: 2,
        tokensIn: 0,
        tokensOut: 0,
        tools: []
      }
    ]
    store.saveSession(session)
    const row = store.listSessions().find((s) => s.id === session.id)
    expect(row?.turns).toBe(1)
  })
})

describe('visibleTurn', () => {
  it('scarta i turni senza testo, anche quelli salvati col vecchio segnaposto', () => {
    expect(visibleTurn({ text: '' } as never)).toBe(false)
    expect(visibleTurn({ text: EMPTY_TURN } as never)).toBe(false)
    expect(visibleTurn({ text: '   ' } as never)).toBe(false)
    expect(visibleTurn({ text: 'una risposta' } as never)).toBe(true)
  })

  it('un turno con solo il ragionamento resta visibile', () => {
    expect(visibleTurn({ text: '', reasoning: 'ho pensato questo' } as never)).toBe(true)
  })
})
