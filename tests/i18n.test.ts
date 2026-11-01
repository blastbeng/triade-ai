import { describe, expect, it } from 'vitest'
import { catalogs, translate } from '../src/shared/i18n'

const locales = Object.keys(catalogs) as (keyof typeof catalogs)[]
const base = Object.keys(catalogs.en).sort()

describe('traduzioni', () => {
  it('tutte le lingue hanno le stesse chiavi', () => {
    for (const l of locales) expect(Object.keys(catalogs[l]).sort(), l).toEqual(base)
  })
  it('nessun valore vuoto', () => {
    for (const l of locales) {
      for (const [k, v] of Object.entries(catalogs[l])) expect(String(v).trim(), `${l}.${k}`).not.toBe('')
    }
  })
  it('interpola i parametri', () => {
    const out = translate('en', 'update.message', { version: '9.9.9' })
    expect(out).toContain('9.9.9')
  })
  it('chiave mancante non lancia', () => {
    expect(translate('it', 'non.esiste')).toBe('non.esiste')
  })
})
