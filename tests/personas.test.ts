import { describe, expect, it } from 'vitest'
import { activePersonas, defaultPersonas } from '../src/shared/personas'
import { DEFAULT_SETTINGS } from '../src/shared/types'

describe('personalità', () => {
  it('default 3, con id stabili', () => {
    const p = defaultPersonas('it')
    expect(p).toHaveLength(3)
    expect(p.map((x) => x.id)).toEqual(['architetto', 'avvocato', 'ricercatore'])
  })
  it('una sola personalità è un assistente', () => {
    const p = defaultPersonas('it', 1)
    expect(p).toHaveLength(1)
    expect(p[0].prompt.toLowerCase()).toContain('assistente')
  })
  it('activePersonas rispetta personaCount', () => {
    expect(activePersonas({ ...DEFAULT_SETTINGS, personaCount: 2 })).toHaveLength(2)
    expect(activePersonas({ ...DEFAULT_SETTINGS, personaCount: 1 })).toHaveLength(1)
  })
  it('ogni lingua produce nomi propri', () => {
    for (const l of ['en', 'it', 'de', 'fr', 'es'] as const) {
      const p = defaultPersonas(l)
      expect(p.every((x) => x.name.trim().length > 0)).toBe(true)
    }
  })
})
