import { useEffect, useState } from 'react'
import type { Persona, SearchProvider, Settings } from '../../../shared/types'
import type { CatalogEntry } from '../env'
import ModelSearch from './ModelSearch'
import BackendPanel from './BackendPanel'
import { LOCALES, type Locale } from '../../../shared/i18n'
import { useT } from '../i18n'

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

type Tab = 'generale' | 'backend' | 'ui' | 'ricerca' | 'gpu' | 'personas' | 'modelli'

interface GpuInfo {
  usable: { key: string; label: string; backend: string; name: string; vramMiB: number; freeMiB: number }[]
  excluded: { key: string; label: string; backend: string; name: string; vramMiB: number; freeMiB: number }[]
  backends: string[]
  selectable: boolean
  cudaBuild: boolean
  byPersona: { id: string; name: string; deviceKey: string }[]
  error?: string
}

function renderPreview(text: string): JSX.Element[] {
  const parts = text.split(/(<b>.*?<\/b>|<i>.*?<\/i>|<c>.*?<\/c>)/g)
  return parts.filter(Boolean).map((part, index) => {
    if (part.startsWith('<b>')) return <strong key={index}>{part.slice(3, -4)}</strong>
    if (part.startsWith('<i>')) return <em key={index}>{part.slice(3, -4)}</em>
    if (part.startsWith('<c>')) return <code key={index}>{part.slice(3, -4)}</code>
    return <span key={index}>{part}</span>
  })
}

export default function SettingsPanel({ settings, catalog, onClose, onSave, onRefresh }: Props): JSX.Element {
  const [draft, setDraft] = useState<Settings>(structuredClone(settings))
  const t = useT()
  const [activeTab, setActiveTab] = useState<Tab>('generale')
  const [downloading, setDownloading] = useState<string | null>(null)
  const [gpu, setGpu] = useState<GpuInfo | null>(null)
  const [gpuDraft, setGpuDraft] = useState<Record<string, string>>({})
  const [embedProbe, setEmbedProbe] = useState<string | null>(null)
  const [integrity, setIntegrity] = useState<
    { id: string; name: string; ok: boolean; reason?: string; repairable: boolean }[]
  >([])

  const refreshIntegrity = async (): Promise<void> => {
    try {
      setIntegrity(await window.triade.modelsIntegrity())
    } catch {
      setIntegrity([])
    }
  }

  useEffect(() => {
    void refreshIntegrity()
  }, [])

  const reportOf = (id: string): { ok: boolean; reason?: string; repairable: boolean } | undefined =>
    integrity.find((r) => r.id === id)
  const [probeQuery, setProbeQuery] = useState('vulkan amd')
  const [probe, setProbe] = useState<{ engine: string; hits: { title: string; url: string }[] } | null>(null)
  const [probeBusy, setProbeBusy] = useState(false)

  const runProbe = async (): Promise<void> => {
    setProbeBusy(true)
    try {
      setProbe(await window.triade.searchWeb(probeQuery, 3))
    } catch (err) {
      setProbe({ engine: `errore: ${(err as Error).message}`, hits: [] })
    } finally {
      setProbeBusy(false)
    }
  }

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

  const [modelsByBackend, setModelsByBackend] = useState<Record<string, string[]>>({})
  useEffect(() => {
    const targets = new Set<string>()
    for (const p of draft.personas) {
      const b = draft.backendByPersona?.[p.id] ?? draft.backend ?? 'llama'
      if (b !== 'llama') targets.add(b)
    }
    for (const backend of targets) {
      if (modelsByBackend[backend]) continue
      const cfg = draft.remote[backend as 'openai' | 'anthropic' | 'ollama']
      if (!cfg) continue
      void window.triade
        .remoteModels(backend, cfg.baseUrl, cfg.apiKey)
        .then((list) =>
          setModelsByBackend((prev) => ({ ...prev, [backend]: list }))
        )
        .catch(() => setModelsByBackend((prev) => ({ ...prev, [backend]: [] })))
    }
  }, [draft.backend, draft.backendByPersona, draft.personas.length])

  const remoteBackend = (draft.backend ?? 'llama') !== 'llama'
  const remoteCfg = remoteBackend
    ? draft.remote[draft.backend as 'openai' | 'anthropic' | 'ollama']
    : null
  const [remoteList, setRemoteList] = useState<string[]>([])
  useEffect(() => {
    if (!remoteCfg) return setRemoteList([])
    let alive = true
    void window.triade
      .remoteModels(draft.backend, remoteCfg.baseUrl, remoteCfg.apiKey)
      .then((list) => {
        if (alive) setRemoteList(list)
      })
      .catch(() => {
        if (alive) setRemoteList([])
      })
    return () => {
      alive = false
    }
  }, [draft.backend, remoteCfg?.baseUrl, remoteCfg?.apiKey])

  return (
    <div className="modal" onClick={onClose}>
      <div className="modalbox settings" onClick={(e) => e.stopPropagation()}>
        <h2>{t('settings.title')}</h2>
        <nav className="tabs">
          {(['generale', 'backend', 'ui', 'ricerca', 'gpu', 'personas', 'modelli'] as Tab[]).map((tab) => (
            <button
              key={tab}
              className={activeTab === tab ? 'tab active' : 'tab'}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'personas'
                ? t('settings.tab.personas')
                : tab === 'modelli'
                  ? t('settings.tab.models')
                  : t(`settings.tab.${tab}`)}
            </button>
          ))}
        </nav>

        {activeTab === 'backend' && (
          <div className="form">
            <BackendPanel
              backend={draft.backend ?? 'llama'}
              remote={draft.remote}
              onChange={(backend, remote) => setDraft({ ...draft, backend, remote })}
            />
            <h3 className="searchtitle">{t('embeddings.title')}</h3>
            <label>
              {t('embeddings.engine')}
              <select
                value={draft.embeddings?.engine ?? 'llama'}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    embeddings: {
                      engine: e.target.value as 'llama' | 'openai' | 'ollama',
                      model: draft.embeddings?.model ?? ''
                    }
                  })
                }
              >
                <option value="llama">llama-server (locale)</option>
                <option value="openai">OpenAI API</option>
                <option value="ollama">Ollama</option>
              </select>
            </label>
            <label>
              {t('embeddings.model')}
              <input
                value={draft.embeddings?.model ?? 'Qwen3-Embedding-0.6B-Q8_0.gguf'}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    embeddings: {
                      engine: draft.embeddings?.engine ?? 'llama',
                      model: e.target.value
                    }
                  })
                }
              />
            </label>
            <div className="inline">
              <button
                className="ghost"
                onClick={async () => {
                  setEmbedProbe('…')
                  try {
                    const res = await window.triade.embeddingsProbe()
                    setEmbedProbe(res.ok ? `ok · ${res.detail}` : `errore: ${res.detail}`)
                  } catch (err) {
                    setEmbedProbe(`errore: ${(err as Error).message}`)
                  }
                }}
              >
                {t('embeddings.test')}
              </button>
              <span className="note">{embedProbe ?? ''}</span>
            </div>
            <p className="note">{t('embeddings.note')}</p>

            {(draft.backend ?? 'llama') !== 'llama' && (
              <p className="note">{t('backend.perChatNote')}</p>
            )}
          </div>
        )}

        {activeTab === 'generale' && (
          <div className="form">
            <label>
              {t('settings.context')}
              <input
                type="number"
                min={2048}
                step={1024}
                value={draft.contextSize}
                onChange={(e) => setDraft({ ...draft, contextSize: Number(e.target.value) })}
              />
            </label>
            <label>
              {t('settings.compression')}
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
              {t('settings.maxTokens')}
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
              {t('settings.maxTurns')}
              <input
                type="number"
                min={3}
                value={draft.maxTurns}
                onChange={(e) => setDraft({ ...draft, maxTurns: Number(e.target.value) })}
              />
            </label>
            <label>
              {t('settings.temperature')}
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
              {t('settings.gpuLayers')}
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
              {t('settings.flashAttention')}
            </label>
            <label>
              {t('settings.kv')}
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
              {t('settings.autoTune')}
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.toolsEnabled}
                onChange={(e) => setDraft({ ...draft, toolsEnabled: e.target.checked })}
              />
              {t('settings.tools')}
            </label>
            <label>
              {t('settings.asrModel')}
              <input
                value={draft.asr.modelFile}
                onChange={(e) => setDraft({ ...draft, asr: { ...draft.asr, modelFile: e.target.value } })}
              />
            </label>
            <label>
              {t('settings.asrLang')}
              <input
                value={draft.asr.language}
                onChange={(e) => setDraft({ ...draft, asr: { ...draft.asr, language: e.target.value } })}
              />
            </label>
            <p className="note">
              Contesto, strati GPU, flash attention, {t('settings.kv')} e modelli forzano il riavvio dei
              llama-server attivi.
            </p>
          </div>
        )}

        {activeTab === 'ui' && (
          <div className="form">
            <label>
              {t('settings.language')}
              <select
                value={draft.ui?.language ?? 'en'}
                onChange={(e) =>
                  setDraft({ ...draft, ui: { ...draft.ui, language: e.target.value as Locale } })
                }
              >
                {LOCALES.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.flag} {l.label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              {t('settings.textSize')}
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
              {t('settings.font')}
              <select
                value={draft.ui?.fontFamily ?? 'system'}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    ui: { ...draft.ui, fontFamily: e.target.value as Settings['ui']['fontFamily'] }
                  })
                }
              >
                <option value="system">{t('settings.fontSystem')}</option>
                <option value="sans">{t('settings.fontSans')}</option>
                <option value="serif">{t('settings.fontSerif')}</option>
                <option value="mono">{t('settings.fontMono')}</option>
              </select>
            </label>

            <label>
              {t('settings.density')}
              <select
                value={draft.ui?.density ?? 'comfortable'}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    ui: { ...draft.ui, density: e.target.value as Settings['ui']['density'] }
                  })
                }
              >
                <option value="comfortable">{t('settings.densityComfort')}</option>
                <option value="compact">{t('settings.densityCompact')}</option>
              </select>
            </label>

            <label>
              {t('settings.lineHeight')}
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
              {t('settings.radius')}
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
              {t('settings.accent')}
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
              {t('settings.showTokens')}
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={draft.ui?.markdown ?? true}
                onChange={(e) => setDraft({ ...draft, ui: { ...draft.ui, markdown: e.target.checked } })}
              />
              {t('settings.markdown')}
            </label>

            <div className="uipreview">
              <span className="previewtitle">Anteprima</span>
              <p>
                {renderPreview(t('settings.previewText'))}
              </p>
              <ul>
                <li>{t('settings.previewItem1')}</li>
                <li>{t('settings.previewItem2')}</li>
              </ul>
              <p className="note">
                Le modifiche a carattere, densità, interlinea, angoli e colore si vedono subito dopo
                il salvataggio.
              </p>
            </div>
          </div>
        )}

        {activeTab === 'ricerca' && (
          <div className="form">
            <label>
              {t('settings.provider')}
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
              {t('settings.searxUrl')}
              <input
                value={draft.search.searxngUrl}
                onChange={(e) => setDraft({ ...draft, search: { ...draft.search, searxngUrl: e.target.value } })}
                placeholder="https://searx.be"
              />
            </label>
            <label>
              {t('settings.maxResults')}
              <input
                type="number"
                min={1}
                max={10}
                value={draft.search.maxResults}
                onChange={(e) => setDraft({ ...draft, search: { ...draft.search, maxResults: Number(e.target.value) } })}
              />
            </label>
            <label>
              {t('settings.testSearch')}
              <div className="inline">
                <input
                  value={probeQuery}
                  onChange={(e) => setProbeQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void runProbe()
                  }}
                />
                <button className="ghost" onClick={() => void runProbe()} disabled={probeBusy}>
                  {probeBusy ? '…' : t('search.find')}
                </button>
              </div>
            </label>
            {probe && (
              <p className="note">
                {probe.engine}
                {probe.hits.length > 0 && (
                  <>
                    {' · '}
                    {probe.hits.map((h) => h.title.slice(0, 48)).join(' | ')}
                  </>
                )}
              </p>
            )}
            <label>
              {t('settings.braveKey')}
              <input
                type="password"
                value={draft.search.braveKey}
                onChange={(e) => setDraft({ ...draft, search: { ...draft.search, braveKey: e.target.value } })}
              />
            </label>
            <label>
              {t('settings.tavilyKey')}
              <input
                type="password"
                value={draft.search.tavilyKey}
                onChange={(e) => setDraft({ ...draft, search: { ...draft.search, tavilyKey: e.target.value } })}
              />
            </label>
            <label>
              {t('settings.googleKey')}
              <input
                type="password"
                value={draft.search.googleKey}
                onChange={(e) => setDraft({ ...draft, search: { ...draft.search, googleKey: e.target.value } })}
              />
            </label>
            <label>
              {t('settings.googleCx')}
              <input
                value={draft.search.googleCx}
                onChange={(e) => setDraft({ ...draft, search: { ...draft.search, googleCx: e.target.value } })}
              />
            </label>
          </div>
        )}

        {activeTab === 'gpu' && (
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
              {t('settings.redetect')}
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
                      {gpu && gpu.usable.length === 1 ? gpu.usable[0].name : t('settings.autoDevice')}
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
              {t('settings.gpuNote')}
              {gpu && !gpu.cudaBuild && ` ${t('settings.cudaMissing')}`}
            </p>
          </div>
        )}

        {activeTab === 'personas' && (
          <div className="form personas">
            <label>
              {t('settings.personasCount')}
              <select
                value={draft.personaCount ?? 3}
                onChange={(e) => setDraft({ ...draft, personaCount: Number(e.target.value) })}
              >
                <option value={1}>{t('settings.personasOne')}</option>
                <option value={2}>{t('settings.personasTwo')}</option>
                <option value={3}>{t('settings.personasThree')}</option>
              </select>
            </label>
            <p className="note">{t('settings.personasCountNote')}</p>
            {draft.personas.slice(0, draft.personaCount ?? 3).map((p, i) => (
              <fieldset key={p.id}>
                <legend>
                  <input className="emoji" value={p.emoji} onChange={(e) => setPersona(i, { emoji: e.target.value })} />
                  <input value={p.name} onChange={(e) => setPersona(i, { name: e.target.value })} />
                  <input type="color" value={p.color} onChange={(e) => setPersona(i, { color: e.target.value })} />
                  <select
                    title={t('settings.personaBackend')}
                    value={draft.backendByPersona?.[p.id] ?? draft.backend ?? 'llama'}
                    onChange={(e) => {
                      const backend = e.target.value as 'llama' | 'openai' | 'anthropic' | 'ollama'
                      setDraft({
                        ...draft,
                        backendByPersona: { ...(draft.backendByPersona ?? {}), [p.id]: backend }
                      })
                    }}
                  >
                    <option value="llama">llama-server</option>
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="ollama">Ollama</option>
                  </select>
                  <select
                    title="modello di questa chat"
                    value={
                      (draft.backendByPersona?.[p.id] ?? draft.backend ?? 'llama') === 'llama'
                        ? (draft.models.byPersona[p.id] ?? draft.models.active)
                        : (draft.models.byPersonaBackend?.[p.id]?.[
                            draft.backendByPersona?.[p.id] ?? draft.backend ?? 'llama'
                          ] ?? '')
                    }
                    onChange={(e) => {
                      const backend = draft.backendByPersona?.[p.id] ?? draft.backend ?? 'llama'
                      if (backend === 'llama') {
                        setDraft({
                          ...draft,
                          models: {
                            ...draft.models,
                            byPersona: { ...draft.models.byPersona, [p.id]: e.target.value }
                          }
                        })
                      } else {
                        setDraft({
                          ...draft,
                          models: {
                            ...draft.models,
                            byPersonaBackend: {
                              ...(draft.models.byPersonaBackend ?? {}),
                              [p.id]: {
                                ...(draft.models.byPersonaBackend?.[p.id] ?? {}),
                                [backend]: e.target.value
                              }
                            }
                          }
                        })
                      }
                    }}
                  >
                    {(draft.backendByPersona?.[p.id] ?? draft.backend ?? 'llama') === 'llama'
                      ? catalog.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))
                      : (() => {
                          const backend = draft.backendByPersona?.[p.id] ?? draft.backend ?? 'llama'
                          const cfg =
                            draft.remote[backend as 'openai' | 'anthropic' | 'ollama']
                          const chosen = draft.models.byPersonaBackend?.[p.id]?.[backend] ?? ''
                          const options = [
                            ...new Set([
                              ...(chosen ? [chosen] : []),
                              ...(cfg?.model ? [cfg.model] : []),
                              ...(modelsByBackend[backend] ?? [])
                            ])
                          ]
                          return options.map((id) => (
                            <option key={id} value={id}>
                              {id}
                            </option>
                          ))
                        })()}
                  </select>
                </legend>
                <textarea rows={7} value={p.prompt} onChange={(e) => setPersona(i, { prompt: e.target.value })} />
              </fieldset>
            ))}
            <p className="note">{t('settings.personasNote')}</p>
          </div>
        )}

        {activeTab === 'modelli' && (
          <div className="form">
            {catalog.map((m) => (
              <div className={`modelcard ${m.active ? 'active' : ''}`} key={m.id}>
                <div className="modelhead">
                  <strong>{m.name}</strong>
                  {m.recommended && <span className="tag">consigliato</span>}
                  {m.installed && <span className="tag ok">installato</span>}
                  {m.active && <span className="tag">{t('settings.active')}</span>}
                </div>
                <p>{m.description}</p>
                <span className="meta">
                  {m.architecture} · {(m.bytes / 1024 ** 3).toFixed(1)} GB · {m.vision ? 'vision' : 'testo'}
                </span>
                {m.status && (
                  <p className="note">
                    {t('settings.status')}:{' '}
                    {m.status.modelReady ? t('settings.modelOk') : t('settings.modelMissing')} ·{' '}
                    {m.status.mmprojReady ? t('settings.mmprojOk') : t('settings.mmprojMissing')}
                    {m.status?.downloading &&
                      ` · ${m.status.phase} ${Math.round((m.status.progress ?? 0) * 100)}%`}
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
                    {m.installed ? t('settings.verify') : t('settings.download')}
                  </button>
                  <button className="ghost" onClick={async () => {
                    await window.triade.modelsSetActive(m.id)
                    await onRefresh()
                  }}>
                    {t('settings.useActive')}
                  </button>
                  {m.installed && (
                    <button
                      className="ghost"
                      onClick={async () => {
                        await window.triade.modelsRemove(m.id)
                        await onRefresh()
                      }}
                    >
                      {t('settings.deleteFiles')}
                    </button>
                  )}
                </div>
                {m.assignedTo.length > 0 && (
                  <p className="note">{t('settings.inUseBy', { names: m.assignedTo.join(', ') })}</p>
                )}
                {m.status?.downloading && (
                  <div className="dlbar">
                    <div
                      className="dlfill"
                      style={{ width: `${Math.round((m.status.progress ?? 0) * 100)}%` }}
                    />
                  </div>
                )}
                {reportOf(m.id) && !reportOf(m.id)!.ok && (
                  <p className="note warn">
                    {t('settings.corruptBadge')} · {reportOf(m.id)!.reason}
                    {reportOf(m.id)!.repairable ? (
                      <button
                        className="ghost"
                        onClick={async () => {
                          setDownloading(m.id)
                          const ok = await window.triade.modelsRepair(m.id)
                          await refreshIntegrity()
                          await onRefresh()
                          setDownloading(null)
                          if (!ok) window.alert(t('settings.corruptNotRepairable'))
                        }}
                      >
                        {t('settings.repair')}
                      </button>
                    ) : (
                      <span> — {t('settings.corruptNotRepairable')}</span>
                    )}
                  </p>
                )}
              </div>
            ))}
            <p className="note">
              {t('settings.modelsNote')}
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
