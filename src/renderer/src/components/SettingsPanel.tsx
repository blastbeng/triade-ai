import { useEffect, useState } from 'react'
import type { Persona, SearchProvider, Settings } from '../../../shared/types'
import type { CatalogEntry } from '../env'
import ModelSearch from './ModelSearch'

interface Props {
  settings: Settings
  catalog: CatalogEntry[]
  onClose: () => void
  onSave: (patch: Partial<Settings>) => Promise<void>
  onRefresh: () => Promise<void>
}

const PROVIDERS: { id: SearchProvider; label: string }[] = [
  { id: 'searxng', label: 'SearXNG' },
  { id: 'brave', label: 'Brave Search' },
  { id: 'tavily', label: 'Tavily' },
  { id: 'googlecse', label: 'Google CSE' }
]

type Tab = 'generale' | 'ui' | 'ricerca' | 'gpu' | 'personas' | 'modelli'

interface GpuInfo {
  usable: { key: string; label: string; backend: string; name: string; vramMiB: number; freeMiB: number }[]
  excluded: { key: string; label: string; backend: string; name: string; vramMiB: number; freeMiB: number }[]
  backends: string[]
  selectable: boolean
  cudaBuild: boolean
  byPersona: { id: string; name: string; deviceKey: string }[]
  error?: string
}

export default function SettingsPanel({ settings, catalog, onClose, onSave, onRefresh }: Props): JSX.Element {
  const [draft, setDraft] = useState<Settings>(structuredClone(settings))
  const [tab, setTab] = useState<Tab>('generale')
  const [downloading, setDownloading] = useState<string | null>(null)
  const [gpu, setGpu] = useState<GpuInfo | null>(null)
  const [gpuDraft, setGpuDraft] = useState<Record<string, string>>({})

  const loadGpu = async (force = false): Promise<void> => {
    const info = await window.triade.gpuList(force)
    setGpu(info)
    setGpuDraft(Object.fromEntries(info.byPersona.map((p) => [p.id, p.deviceKey])))
  }

  useEffect(() => {
    void loadGpu()
  }, [])

  const setPersona = (i: number, patch: Partial<Persona>): void => {
    const personas = [...draft.personas]
    personas[i] = { ...personas[i], ...patch }
    setDraft({ ...draft, personas })
  }

  const modelName = (id: string): string => catalog.find((m) => m.id === id)?.name ?? id

  return (
    <div className="modal" onClick={onClose}>
      <div className="modalbox settings" onClick={(e) => e.stopPropagation()}>
        <h2>Impostazioni</h2>
        <nav className="tabs">
          {(['generale', 'ui', 'ricerca', 'gpu', 'personas', 'modelli'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
              {t === 'personas' ? 'personalità' : t === 'modelli' ? 'modelli e download' : t}
            </button>
          ))}
        </nav>

        {tab === 'generale' && (
          <div className="form">
            <label>
              Contesto (token, uguale per le 3 chat)
              <input
                type="number"
                min={2048}
                step={1024}
                value={draft.contextSize}
                onChange={(e) => setDraft({ ...draft, contextSize: Number(e.target.value) })}
              />
            </label>
            <label>
              Prompt compression a
              <div className="inline">
                <input
                  type="range"
                  min={50}
                  max={95}
                  value={Math.round(draft.compressionThreshold * 100)}
                  onChange={(e) => setDraft({ ...draft, compressionThreshold: Number(e.target.value) / 100 })}
                />
                <span>{Math.round(draft.compressionThreshold * 100)}%</span>
              </div>
            </label>
            <label>
              Max token per turno (0 = nessun tetto, il limite è solo il contesto)
              <input
                type="number"
                min={0}
                max={262144}
                step={512}
                value={draft.maxTokensPerTurn}
                onChange={(e) => setDraft({ ...draft, maxTokensPerTurn: Number(e.target.value) })}
              />
            </label>
            <label>
              Max turni (stop automatico)
              <input
                type="number"
                min={3}
                value={draft.maxTurns}
                onChange={(e) => setDraft({ ...draft, maxTurns: Number(e.target.value) })}
              />
            </label>
            <label>
              Temperatura
              <input
                type="number"
                min={0}
                max={2}
                step={0.05}
                value={draft.temperature}
                onChange={(e) => setDraft({ ...draft, temperature: Number(e.target.value) })}
              />
            </label>
            <label>
              Strati su GPU (-ngl)
              <input
                type="number"
                min={0}
                max={999}
                value={draft.gpuLayers}
                onChange={(e) => setDraft({ ...draft, gpuLayers: Number(e.target.value) })}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.flashAttention}
                onChange={(e) => setDraft({ ...draft, flashAttention: e.target.checked })}
              />
              Flash attention
            </label>
            <label>
              KV cache
              <select
                value={draft.kvCacheType}
                onChange={(e) => setDraft({ ...draft, kvCacheType: e.target.value as 'f16' | 'q8_0' })}
              >
                <option value="q8_0">q8_0 (meno VRAM)</option>
                <option value="f16">f16 (più preciso)</option>
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.autoTune}
                onChange={(e) => setDraft({ ...draft, autoTune: e.target.checked })}
              />
              Auto-tuning dei parametri llama-server (contesto, KV, offload) in base alla VRAM
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.toolsEnabled}
                onChange={(e) => setDraft({ ...draft, toolsEnabled: e.target.checked })}
              />
              Tool abilitati (ricerca web, immagini, media)
            </label>
            <label>
              Modello whisper (ASR)
              <input
                value={draft.asr.modelFile}
                onChange={(e) => setDraft({ ...draft, asr: { ...draft.asr, modelFile: e.target.value } })}
              />
            </label>
            <label>
              Lingua trascrizione
              <input
                value={draft.asr.language}
                onChange={(e) => setDraft({ ...draft, asr: { ...draft.asr, language: e.target.value } })}
              />
            </label>
            <p className="note">
              Contesto, strati GPU, flash attention, KV cache e modelli forzano il riavvio dei
              llama-server attivi.
            </p>
          </div>
        )}

        {tab === 'ui' && (
          <div className="form">
            <label>
              Dimensione del testo
              <div className="inline">
                <input
                  type="range"
                  min={85}
                  max={160}
                  step={5}
                  value={Math.round((draft.ui?.fontScale ?? 1) * 100)}
                  onChange={(e) => {
                    const scale = Number(e.target.value) / 100
                    setDraft({ ...draft, textScale: scale, ui: { ...draft.ui, fontScale: scale } })
                  }}
                />
                <span>{Math.round((draft.ui?.fontScale ?? 1) * 100)}%</span>
              </div>
            </label>

            <label>
              Carattere
              <select
                value={draft.ui?.fontFamily ?? 'system'}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    ui: { ...draft.ui, fontFamily: e.target.value as Settings['ui']['fontFamily'] }
                  })
                }
              >
                <option value="system">Sistema (consigliato)</option>
                <option value="sans">Sans (Inter/Helvetica)</option>
                <option value="serif">Serif (Georgia)</option>
                <option value="mono">Monospace (JetBrains Mono)</option>
              </select>
            </label>

            <label>
              Densità
              <select
                value={draft.ui?.density ?? 'comfortable'}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    ui: { ...draft.ui, density: e.target.value as Settings['ui']['density'] }
                  })
                }
              >
                <option value="comfortable">Comoda</option>
                <option value="compact">Compatta (più messaggi a schermo)</option>
              </select>
            </label>

            <label>
              Interlinea
              <div className="inline">
                <input
                  type="range"
                  min={130}
                  max={190}
                  step={5}
                  value={Math.round((draft.ui?.lineHeight ?? 1.55) * 100)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      ui: { ...draft.ui, lineHeight: Number(e.target.value) / 100 }
                    })
                  }
                />
                <span>{(draft.ui?.lineHeight ?? 1.55).toFixed(2)}</span>
              </div>
            </label>

            <label>
              Angoli
              <div className="inline">
                <input
                  type="range"
                  min={0}
                  max={16}
                  step={1}
                  value={draft.ui?.radius ?? 10}
                  onChange={(e) =>
                    setDraft({ ...draft, ui: { ...draft.ui, radius: Number(e.target.value) } })
                  }
                />
                <span>{draft.ui?.radius ?? 10}px</span>
              </div>
            </label>

            <label className="inline">
              Colore di evidenza
              <input
                type="color"
                value={draft.ui?.accent ?? '#5eead4'}
                onChange={(e) => setDraft({ ...draft, ui: { ...draft.ui, accent: e.target.value } })}
              />
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={draft.ui?.showTimestamps ?? true}
                onChange={(e) =>
                  setDraft({ ...draft, ui: { ...draft.ui, showTimestamps: e.target.checked } })
                }
              />
              Mostra l'orario dei turni
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={draft.ui?.showTokens ?? true}
                onChange={(e) => setDraft({ ...draft, ui: { ...draft.ui, showTokens: e.target.checked } })}
              />
              Mostra il conteggio dei token di prompt
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={draft.ui?.markdown ?? true}
                onChange={(e) => setDraft({ ...draft, ui: { ...draft.ui, markdown: e.target.checked } })}
              />
              Formattazione markdown nelle risposte (testo grezzo se disattivata)
            </label>

            <div className="uipreview">
              <strong>Anteprima</strong>
              <p>
                Testo normale con <strong>grassetto</strong>, <em>corsivo</em> e <code>codice</code>.
              </p>
              <ul>
                <li>primo punto dell'elenco</li>
                <li>secondo punto dell'elenco</li>
              </ul>
              <p className="note">
                Le modifiche a carattere, densità, interlinea, angoli e colore si vedono subito dopo
                il salvataggio.
              </p>
            </div>
          </div>
        )}

        {tab === 'ricerca' && (
          <div className="form">
            <label>
              Provider
              <select
                value={draft.search.provider}
                onChange={(e) =>
                  setDraft({ ...draft, search: { ...draft.search, provider: e.target.value as SearchProvider } })
                }
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              URL SearXNG
              <input
                value={draft.search.searxngUrl}
                onChange={(e) => setDraft({ ...draft, search: { ...draft.search, searxngUrl: e.target.value } })}
                placeholder="https://searx.be"
              />
            </label>
            <label>
              Risultati massimi
              <input
                type="number"
                min={1}
                max={10}
                value={draft.search.maxResults}
                onChange={(e) => setDraft({ ...draft, search: { ...draft.search, maxResults: Number(e.target.value) } })}
              />
            </label>
            <label>
              Brave API key
              <input
                type="password"
                value={draft.search.braveKey}
                onChange={(e) => setDraft({ ...draft, search: { ...draft.search, braveKey: e.target.value } })}
              />
            </label>
            <label>
              Tavily API key
              <input
                type="password"
                value={draft.search.tavilyKey}
                onChange={(e) => setDraft({ ...draft, search: { ...draft.search, tavilyKey: e.target.value } })}
              />
            </label>
            <label>
              Google API key
              <input
                type="password"
                value={draft.search.googleKey}
                onChange={(e) => setDraft({ ...draft, search: { ...draft.search, googleKey: e.target.value } })}
              />
            </label>
            <label>
              Google CX
              <input
                value={draft.search.googleCx}
                onChange={(e) => setDraft({ ...draft, search: { ...draft.search, googleCx: e.target.value } })}
              />
            </label>
          </div>
        )}

        {tab === 'gpu' && (
          <div className="form">
            {gpu?.error && <p className="error">{gpu.error}</p>}
            {gpu && !gpu.selectable && (
              <p className="note">
                Una sola GPU dedicata utilizzabile: la scelta per chat è disattivata, tutte le chat
                usano <strong>{gpu.usable[0]?.name ?? 'la GPU rilevata'}</strong>.
              </p>
            )}
            <table className="gputable">
              <thead>
                <tr>
                  <th>GPU</th>
                  <th>backend</th>
                  <th>VRAM</th>
                  <th>libera</th>
                </tr>
              </thead>
              <tbody>
                {(gpu?.usable ?? []).map((d) => (
                  <tr key={d.key}>
                    <td>{d.name}</td>
                    <td>{d.backend}</td>
                    <td>{(d.vramMiB / 1024).toFixed(1)} GB</td>
                    <td>{(d.freeMiB / 1024).toFixed(1)} GB</td>
                  </tr>
                ))}
                {(gpu?.excluded ?? []).map((d) => (
                  <tr key={d.key} className="excluded">
                    <td>{d.name} <span className="tag">integrata, esclusa</span></td>
                    <td>{d.backend}</td>
                    <td>{(d.vramMiB / 1024).toFixed(1)} GB</td>
                    <td>—</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="ghost" onClick={() => void loadGpu(true)}>
              rileva di nuovo
            </button>
            <div className="gpuassign">
              {draft.personas.map((p) => (
                <label key={p.id}>
                  {p.name}
                  <select
                    value={gpuDraft[p.id] ?? 'auto'}
                    disabled={!gpu?.selectable}
                    onChange={(e) => setGpuDraft({ ...gpuDraft, [p.id]: e.target.value })}
                  >
                    <option value="auto">
                      {gpu && gpu.usable.length === 1 ? `automatica (${gpu.usable[0].name})` : 'automatica'}
                    </option>
                    {(gpu?.usable ?? []).map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.name} · {d.backend}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <p className="note">
              Ogni chat può usare una GPU diversa: il pool avvia un llama-server per ogni coppia
              modello+GPU. Le GPU integrate (es. Radeon del Ryzen) sono escluse. Nessun supporto
              ROCm/HIP: solo Vulkan e, se la build CUDA è presente, CUDA.
              {gpu && !gpu.cudaBuild && ' Build CUDA non installata (si scarica con fetch:bin --cuda).'}
            </p>
          </div>
        )}

        {tab === 'personas' && (
          <div className="form personas">
            {draft.personas.map((p, i) => (
              <fieldset key={p.id}>
                <legend>
                  <input className="emoji" value={p.emoji} onChange={(e) => setPersona(i, { emoji: e.target.value })} />
                  <input value={p.name} onChange={(e) => setPersona(i, { name: e.target.value })} />
                  <input type="color" value={p.color} onChange={(e) => setPersona(i, { color: e.target.value })} />
                  <select
                    title="modello di questa chat"
                    value={draft.models.byPersona[p.id] ?? draft.models.active}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        models: {
                          ...draft.models,
                          byPersona: { ...draft.models.byPersona, [p.id]: e.target.value }
                        }
                      })
                    }
                  >
                    {catalog.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </legend>
                <textarea rows={7} value={p.prompt} onChange={(e) => setPersona(i, { prompt: e.target.value })} />
              </fieldset>
            ))}
            <p className="note">
              Le personalità sono solo system prompt. Il modello è per chat: stesso modello per tutte
              e tre = un solo processo llama-server; modelli diversi = un processo per modello.
            </p>
          </div>
        )}

        {tab === 'modelli' && (
          <div className="form">
            {catalog.map((m) => (
              <div className={`modelcard ${m.active ? 'active' : ''}`} key={m.id}>
                <div className="modelhead">
                  <strong>{m.name}</strong>
                  {m.recommended && <span className="tag">consigliato</span>}
                  {m.installed && <span className="tag ok">installato</span>}
                  {m.active && <span className="tag">attivo</span>}
                </div>
                <p>{m.description}</p>
                <span className="meta">
                  {m.architecture} · {(m.bytes / 1024 ** 3).toFixed(1)} GB · {m.vision ? 'vision' : 'testo'}
                </span>
                {m.status && (
                  <p className="note">
                    stato: {m.status.modelReady ? 'modello ok' : 'modello mancante'} ·{' '}
                    {m.status.mmprojReady ? 'mmproj ok' : 'mmproj mancante'}
                    {m.status.downloading && ` · ${m.status.phase} ${Math.round(m.status.progress * 100)}%`}
                  </p>
                )}
                <div className="modelactions">
                  <button
                    className="primary"
                    disabled={downloading === m.id}
                    onClick={async () => {
                      setDownloading(m.id)
                      try {
                        await window.triade.modelsInstall(m.id)
                        await onRefresh()
                      } finally {
                        setDownloading(null)
                      }
                    }}
                  >
                    {m.installed ? 'verifica / riprendi' : 'scarica'}
                  </button>
                  <button className="ghost" onClick={async () => {
                    await window.triade.modelsSetActive(m.id)
                    await onRefresh()
                  }}>
                    usa come attivo
                  </button>
                  {m.installed && (
                    <button
                      className="ghost"
                      onClick={async () => {
                        await window.triade.modelsRemove(m.id)
                        await onRefresh()
                      }}
                    >
                      elimina file
                    </button>
                  )}
                </div>
                {m.assignedTo.length > 0 && <p className="note">in uso da: {m.assignedTo.join(', ')}</p>}
              </div>
            ))}
            <p className="note">
              I file stanno in <code>dati/modelli/</code>, accanto all’eseguibile. Il download riprende
              da dove si era interrotto.
            </p>
          </div>
        )}

        <footer className="modalfooter">
          <button className="ghost" onClick={onClose}>
            annulla
          </button>
          <button
            className="primary"
            onClick={async () => {
              await onSave(draft)
              for (const p of draft.personas) {
                const id = draft.models.byPersona[p.id] ?? draft.models.active
                await window.triade.modelsAssign(p.id, id)
              }
              for (const [personaId, deviceKey] of Object.entries(gpuDraft)) {
                await window.triade.gpuAssign(personaId, deviceKey)
              }
            }}
          >
            salva
          </button>
        </footer>
      </div>
    </div>
  )
}
