import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { catalogs } from '../src/shared/i18n'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

/**
 * La ricerca HuggingFace era importata ma mai disegnata: in Impostazioni →
 * modelli e download non c'era modo di aggiungere un modello. Il componente è
 * uno solo (usato dall'onboarding), quindi il test guarda i punti che, se
 * sparissero, riporterebbero il bug.
 */
describe('impostazioni: ricerca modelli su HuggingFace', () => {
  const panel = read('src/renderer/src/components/SettingsPanel.tsx')

  it('la scheda “modelli e download” disegna la ricerca', () => {
    const tab = panel.slice(panel.indexOf("activeTab === 'modelli'"))
    expect(tab).toContain('<ModelSearch')
    expect(tab.indexOf('<ModelSearch')).toBeLessThan(tab.indexOf('catalog.map'))
  })

  it('la sezione ha il titolo tradotto in tutte le lingue', () => {
    expect(panel).toContain("t('settings.searchModelsTitle')")
    for (const locale of Object.keys(catalogs)) {
      expect(catalogs[locale as keyof typeof catalogs]['settings.searchModelsTitle']).toBeTruthy()
    }
  })

  it('dopo l aggiunta la lista dei modelli viene ricaricata', () => {
    const tab = panel.slice(panel.indexOf('<ModelSearch'))
    expect(tab.slice(0, tab.indexOf('/>'))).toContain('onInstalled')
    expect(tab.slice(0, tab.indexOf('/>'))).toContain('onRefresh')
  })

  it('salvare le impostazioni non cancella un modello appena aggiunto', () => {
    // `models.custom` lo scrive subito models:addCustom: il salvataggio deve
    // riprendere la lista vera, non la copia congelata all'apertura
    expect(panel).toContain('custom: fresh.models.custom')
  })

  it('la nota sui file non mostra i tag a schermo', () => {
    // la traduzione contiene <c>dati/modelli/</c>: va convertita, non stampata
    expect(panel).toContain("renderRichText(t('settings.modelsNote'))")
    expect(panel).not.toContain("{t('settings.modelsNote')}")
  })

  it('in impostazioni il download mostra l avanzamento', () => {
    const search = read('src/renderer/src/components/ModelSearch.tsx')
    expect(search).toContain('showProgress')
    expect(search).toContain("event.type !== 'model'")
    expect(search).toContain('className="dlfill"')
  })
})
