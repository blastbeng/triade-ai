import { useEffect, useState } from 'react'
import type { CatalogEntry } from '../env'
import ModelSearch from './ModelSearch'

interface Props {
  catalog: CatalogEntry[]
  onDone: (installed: string[], active: string) => Promise<void>
  onProgress: () => Promise<void>
}

export default function Onboarding({ catalog, onDone, onProgress }: Props): JSX.Element {
  const [selected, setSelected] = useState<string[]>(
    catalog.filter((m) => m.recommended && !m.installed).map((m) => m.id)
  )
  const [phase, setPhase] = useState<string>('')
  const [pct, setPct] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void onDone(catalog.filter((m) => m.installed).map((m) => m.id), catalog[0]?.id ?? '')
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
      await onDone(selected, selected[0])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="modal">
      <div className="modalbox onboarding">
        <h2>Benvenuto in TriadeAI</h2>
        <p className="lead">
          Scegli quali modelli vuoi usare. Puoi selezionarne più di uno: verranno scaricati in
          <code> dati/modelli/</code>, accanto all’app. Ogni chat potrà poi usare il proprio modello.
        </p>

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
                    {m.name} {m.recommended && <span className="tag">consigliato</span>}
                    {m.installed && <span className="tag ok">installato</span>}
                  </strong>
                  <p>{m.description}</p>
                  <span className="meta">
                    {m.architecture} · {(m.bytes / 1024 ** 3).toFixed(1)} GB ·{' '}
                    {m.vision ? 'vision' : 'solo testo'} · {m.license}
                  </span>
                </div>
              </label>
            </li>
          ))}
        </ul>

        <h3 className="searchtitle">oppure cerca un altro modello su HuggingFace</h3>
        <p className="lead small">
          Ogni candidato viene verificato prima di essere proposto: se non ha la vision (mmproj) o se
          nessun quant entra nella tua GPU, viene escluso con il motivo.
        </p>
        <ModelSearch
          onInstalled={async (id) => {
            setSelected((prev) => (prev.includes(id) ? prev : [...prev, id]))
            await onProgress()
          }}
          onError={setError}
        />

        {working && (
          <p className="note">
            download di {phase}: {Math.round(pct)}%
          </p>
        )}
        {error && <p className="error">{error}</p>}

        <footer className="modalfooter">
          <button className="ghost" onClick={() => void onDone(catalog.filter((m) => m.installed).map((m) => m.id), catalog[0].id)}>
            salta per ora
          </button>
          <button className="primary" onClick={() => void start()} disabled={working || !selected.length}>
            scarica e inizia
          </button>
        </footer>
      </div>
    </div>
  )
}
