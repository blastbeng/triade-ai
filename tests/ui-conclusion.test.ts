import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { catalogs } from '../src/shared/i18n'

/**
 * La risposta finale deve stare SOPRA le tre colonne: sotto finiva a ridosso
 * del composer e sembrava parte della conversazione.
 */
const root = path.resolve(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

describe('banner dell’esito finale', () => {
  const app = read('src/renderer/src/App.tsx')

  it('è renderizzato prima delle colonne', () => {
    const banner = app.indexOf('kind-${conclusion.kind}')
    const columns = app.indexOf('<main className={`columns')
    expect(banner).toBeGreaterThan(-1)
    expect(columns).toBeGreaterThan(-1)
    expect(banner).toBeLessThan(columns)
  })

  it('mostra tutte e tre le chiusure possibili, tradotte', () => {
    for (const kind of ['consenso', 'impossibile', 'limite']) {
      for (const dict of Object.values(catalogs)) {
        expect(String(dict[`app.conclusion.${kind}`] ?? '').trim(), kind).not.toBe('')
      }
    }
  })

  it('le impostazioni accettano 0 = illimitato', () => {
    const panel = read('src/renderer/src/components/SettingsPanel.tsx')
    const at = panel.indexOf("t('settings.maxTurns')")
    expect(at).toBeGreaterThan(-1)
    const input = panel.slice(at, at + 320)
    expect(input).toContain('min={0}')
  })
})
