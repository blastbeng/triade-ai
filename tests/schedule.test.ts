import { describe, expect, it } from 'vitest'
import { chooseNextSpeaker, parseHandoff } from '../src/main/debate/schedule'
import { defaultPersonas } from '../src/shared/personas'
import type { Turn } from '../src/shared/types'

const personas = defaultPersonas('en')
const [a, b, c] = personas

/** turni degli agenti: l'utente è sempre filtrabile per agentId */
const turns = (...ids: string[]): Turn[] =>
  ids.map((agentId, i) => ({ id: String(i), agentId, ts: i, text: 'x' })) as unknown as Turn[]

describe('chooseNextSpeaker', () => {
  it('senza turni parla la prima personalità', () => {
    expect(chooseNextSpeaker({ personas, turns: [] }).id).toBe(a.id)
  })

  it('con un turno fatto, passa alla successiva', () => {
    expect(chooseNextSpeaker({ personas, turns: turns(a.id) }).id).toBe(b.id)
  })

  it('rispetta l’interlocutore richiesto', () => {
    expect(chooseNextSpeaker({ personas, turns: turns(a.id), nextSpeakerId: c.id }).id).toBe(c.id)
  })

  it('se il richiesto ha appena parlato, con 3 agenti si passa a un altro', () => {
    const next = chooseNextSpeaker({ personas, turns: turns(a.id), nextSpeakerId: a.id })
    expect(next.id).not.toBe(a.id)
  })

  it('con 2 agenti il richiesto può ripetere (non ci sono alternative)', () => {
    const two = [a, b]
    const next = chooseNextSpeaker({ personas: two, turns: turns(a.id), nextSpeakerId: a.id })
    expect(next.id).toBe(a.id)
  })

  it('rotationOffset sceglie chi apre il dibattito', () => {
    expect(chooseNextSpeaker({ personas, turns: [], rotationOffset: 2 }).id).toBe(c.id)
  })

  it('non fa parlare due volte di fila lo stesso agente', () => {
    const next = chooseNextSpeaker({ personas, turns: turns(a.id, b.id) })
    expect(next.id).not.toBe(b.id)
  })

  it('con una sola personalità parla sempre lei', () => {
    expect(chooseNextSpeaker({ personas: [a], turns: turns(a.id) }).id).toBe(a.id)
  })

  it('ignora i turni dell’utente nel conteggio della rotazione', () => {
    expect(chooseNextSpeaker({ personas, turns: turns('utente', 'utente') }).id).toBe(a.id)
  })
})

describe('parseHandoff', () => {
  it('riconosce [[PASSA A: Nome]]', () => {
    expect(parseHandoff(`... [[PASSA A: ${c.name}]]`, personas, a.id)?.id).toBe(c.id)
  })

  it('riconosce il nome anche parziale', () => {
    expect(parseHandoff(`[[PASSA A: ${b.name.slice(0, 6)}]]`, personas, c.id)?.id).toBe(b.id)
  })

  it('non cede la parola a sé stesso', () => {
    expect(parseHandoff(`[[PASSA A: ${a.name}]]`, personas, a.id)).toBeNull()
  })

  it('senza marcatore non restituisce nulla', () => {
    expect(parseHandoff('nessuna cessione qui', personas, a.id)).toBeNull()
  })
})
