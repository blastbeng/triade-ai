import { useEffect, useState } from 'react'
import { LOCALES, translate, type Locale } from '../../../shared/i18n'
import type { CatalogEntry } from '../env'
import ModelSearch from './ModelSearch'
import BackendPanel from './BackendPanel'
import type { Backend, RemoteSettings } from '../../../shared/types'

interface Props {
  catalog: CatalogEntry[]
  backend: Backend
  remote: RemoteSettings
  onBackend: (backend: Backend, remote: RemoteSettings) => Promise<void> | void
  language: Locale
  onLanguage: (locale: Locale) => Promise<void> | void
  onDone: (installed: string[], active: string, personaCount: number) => Promise<void>
  onProgress: () => Promise<void>
}

export default function Onboarding({
  catalog,
  backend,
  remote,
  onBackend,
  language,
  onLanguage,
  onDone,
  onProgress
}: Props): JSX.Element {
  const [step, setStep] = useState<'language' | 'backend' | 'models'>('language')
  const [localBackend, setLocalBackend] = useState<Backend>(backend)
  const [localRemote, setLocalRemote] = useState<RemoteSettings>(remote)
  // in onboarding l'italiano è preselezionato (l'app resta in inglese finché non si conferma)
  const [locale, setLocale] = useState<Locale>(language === 'en' ? 'it' : language)
  const [selected, setSelected] = useState<string[]>([])
  const [personas, setPersonas] = useState(3)
  const [phase, setPhase] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(locale, key, params)

  useEffect(() => {
    setSelected(catalog.filter((m) => m.recommended && !m.installed).map((m) => m.id))
  }, [catalog])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        void onDone(
          catalog.filter((m) => m.installed).map((m) => m.id),
          catalog[0]?.id ?? '',
          personas
        )
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [catalog, onDone])

  const toggle = (id: string): void =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const start = async (): Promise<void> => {
    if (!selected.length) return
    setWorking(true)
    setError(null)
    try {
      for (const id of selected) {
        const entry = catalog.find((m) => m.id === id)
        if (entry?.installed) continue
        setPhase(id)
        await window.triade.modelsInstall(id)
        await onProgress()
      }
      await onDone(selected, selected[0], personas)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setWorking(false)
    }
  }

  if (step === 'language') {
    return (
      <div className="modal">
        <div className="modalbox onboarding langpick">
          <h2>{t('onboarding.langTitle')}</h2>
          <p className="lead">{t('onboarding.langLead')}</p>
          <div className="langgrid">
            {LOCALES.map((l) => (
              <button
                key={l.id}
                className={`langbutton ${l.id === locale ? 'selected' : ''}`}
                onClick={() => setLocale(l.id)}
              >
                <span className="flag">{l.flag}</span>
                <span>{l.label}</span>
                {l.id === locale && <span className="check">✓</span>}
              </button>
            ))}
          </div>
          <footer className="modalfooter">
            <button
              className="primary"
              onClick={async () => {
                await onLanguage(locale)
                setStep('backend')
              }}
            >
              {t('onboarding.continue')}
            </button>
          </footer>
        </div>
      </div>
    )
  }

  if (step === 'backend') {
    const remoteBackend = localBackend !== 'llama'
    return (
      <div className="modal">
        <div className="modalbox onboarding">
          <h2>{t('onboarding.backendTitle')}</h2>
          <p className="lead">{t('onboarding.backendLead')}</p>
          <BackendPanel
            backend={localBackend}
            remote={localRemote}
            onChange={(next, remoteCfg) => {
              setLocalBackend(next)
              setLocalRemote(remoteCfg)
            }}
          />
          <footer className="modalfooter">
            <button
              className="primary"
              onClick={async () => {
                await onBackend(localBackend, localRemote)
                if (remoteBackend) {
                  // nessun download: si passa direttamente al modello attivo
                  await onDone([], localRemote[localBackend as Exclude<Backend, 'llama'>].model, personas)
                  return
                }
                setStep('models')
              }}
            >
              {t('onboarding.continue')}
            </button>
          </footer>
        </div>
      </div>
    )
  }

  return (
    <div className="modal">
      <div className="modalbox onboarding">
        <h2>{t('onboarding.title')}</h2>
        <p className="lead">
          {t('onboarding.lead')} <code>dati/modelli/</code> {t('onboarding.lead2')}
        </p>

        <h3 className="searchtitle">{t('onboarding.personasTitle')}</h3>
        <p className="lead small">{t('onboarding.personasLead')}</p>
        <div className="personacount">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              className={`langbutton ${personas === n ? 'selected' : ''}`}
              onClick={() => setPersonas(n)}
            >
              {t(n === 1 ? 'onboarding.personasOne' : n === 2 ? 'onboarding.personasTwo' : 'onboarding.personasThree')}
            </button>
          ))}
        </div>

        <ul className="catalog">
          {catalog.map((m) => (
            <li key={m.id} className={selected.includes(m.id) ? 'picked' : ''}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(m.id) || m.installed}
                  disabled={m.installed || working}
                  onChange={() => toggle(m.id)}
                />
                <div>
                  <strong>
                    {m.name} {m.recommended && <span className="tag">{t('onboarding.recommended')}</span>}
                    {m.installed && <span className="tag ok">{t('onboarding.installed')}</span>}
                  </strong>
                  <p>{m.description}</p>
                  <span className="meta">
                    {m.architecture} · {(m.bytes / 1024 ** 3).toFixed(1)} GB ·{' '}
                    {m.vision ? t('onboarding.vision') : t('onboarding.textOnly')} · {m.license}
                  </span>
                </div>
              </label>
            </li>
          ))}
        </ul>

        <h3 className="searchtitle">{t('onboarding.searchTitle')}</h3>
        <p className="lead small">{t('onboarding.searchLead')}</p>
        <ModelSearch
          onInstalled={async (id) => {
            setSelected((prev) => (prev.includes(id) ? prev : [...prev, id]))
            await onProgress()
          }}
          onError={setError}
        />

        {working && <p className="note">{t('onboarding.downloading', { model: phase, pct: 0 })}</p>}
        {error && <p className="error">{error}</p>}

        <footer className="modalfooter">
          <button
            className="ghost"
            onClick={() =>
              void onDone(
                catalog.filter((m) => m.installed).map((m) => m.id),
                catalog[0]?.id ?? '',
                personas
              )
            }
          >
            {t('onboarding.skip')}
          </button>
          <button className="primary" onClick={() => void start()} disabled={working || !selected.length}>
            {t('onboarding.start')}
          </button>
        </footer>
      </div>
    </div>
  )
}
