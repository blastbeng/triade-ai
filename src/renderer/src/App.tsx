import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Turn,
  Attachment,
  DebateEvent,
  ModelStatus,
  ServerStatus,
  Session,
  Settings,
  UiFont
} from '../../shared/types'
import ChatColumn, { type Phase } from './components/ChatColumn'
import { LocaleContext } from './i18n'
import { translate, type Locale } from '../../shared/i18n'
import Composer from './components/Composer'
import SettingsPanel from './components/SettingsPanel'
import Onboarding from './components/Onboarding'
import MemoryPanel from './components/MemoryPanel'
import type { CatalogEntry } from './env'

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const gb = n / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(0)} MB`
}

interface SessionRow {
  id: string
  topic: string
  title?: string
  updatedAt: number
  state: string
  turns: number
}

export default function App(): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [stream, setStream] = useState<{ agentId: string; text: string } | null>(null)
  const [streamReasoning, setStreamReasoning] = useState<{ agentId: string; text: string } | null>(null)
  const [phases, setPhases] = useState<Record<string, Phase>>({})
  const [servers, setServers] = useState<ServerStatus[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [showMemory, setShowMemory] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [onboarding, setOnboarding] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const v = await window.triade.version()
        if (alive && v) setVersion(String(v))
      } catch {
        try {
          const info = await window.triade.appInfo()
          if (alive && info?.version) setVersion(String(info.version))
        } catch {
          /* senza versione il badge resta vuoto, l'app funziona lo stesso */
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const locale: Locale = settings?.ui?.language ?? 'en'
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(locale, key, params)

  const pushLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev.slice(-300), `${new Date().toLocaleTimeString('it-IT')} ${msg}`])
  }, [])

  const loadAll = useCallback(async () => {
    const [s, srv, cur, list, cat] = await Promise.all([
      window.triade.getSettings(),
      window.triade.serverStatus(),
      window.triade.currentSession(),
      window.triade.listSessions(),
      window.triade.modelsCatalog()
    ])
    setSettings(s)
    setServers(srv)
    setSessions(list)
    setCatalog(cat)
    if (cur) setSession(cur)
    if (!s.onboardingDone) setOnboarding(true)
  }, [])

  useEffect(() => {
    void loadAll()
    return window.triade.onEvent((event: DebateEvent) => {
      switch (event.type) {
        case 'delta': {
          const agentId = String(event.agentId)
          const chunk = String(event.text ?? '')
          setStream((prev) =>
            prev && prev.agentId === agentId ? { agentId, text: prev.text + chunk } : { agentId, text: chunk }
          )
          break
        }
        case 'reasoning': {
          const agentId = String(event.agentId)
          const chunk = String(event.text ?? '')
          setStreamReasoning((prev) =>
            prev && prev.agentId === agentId ? { agentId, text: prev.text + chunk } : { agentId, text: chunk }
          )
          break
        }
        case 'phase': {
          const agentId = String(event.agentId)
          const phase = String(event.phase) as Phase
          setPhases((prev) => ({ ...prev, [agentId]: phase }))
          break
        }
        case 'turn':
          setStream(null)
          setStreamReasoning(null)
          void window.triade.listSessions().then(setSessions)
          break
        case 'session':
          setSession(event.session as Session | null)
          void window.triade.listSessions().then(setSessions)
          break
        case 'state':
          setSession((prev) => (prev ? { ...prev, state: event.state as Session['state'] } : prev))
          break
        case 'compression': {
          setNotice(String(event.message ?? 'contesto compresso'))
          window.setTimeout(() => setNotice(null), 6000)
          break
        }
        case 'consensus':
          setNotice('Consenso raggiunto')
          break
        case 'error':
          setNotice(String(event.message))
          pushLog(`ERRORE: ${String(event.message)}`)
          break
        case 'log':
          pushLog(String(event.message ?? ''))
          break
        case 'tool':
          pushLog(`tool ${String(event.name)} → ${String(event.result).slice(0, 160)}`)
          break
        case 'model': {
          const status = event.status as ModelStatus | undefined
          if (status) setCatalog((prev) => prev.map((m) => (m.id === status.id ? { ...m, status } : m)))
          break
        }
      }
    })
  }, [loadAll, pushLog])

  const UI_FONTS: Record<UiFont, string> = {
    system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    sans: "Inter, 'Helvetica Neue', Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    mono: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace"
  }

  useEffect(() => {
    const ui = settings?.ui
    if (!ui) return
    document.body.style.zoom = String(ui.fontScale ?? settings?.textScale ?? 1)
    document.body.style.fontFamily = UI_FONTS[ui.fontFamily] ?? UI_FONTS.system
    document.body.dataset.density = ui.density
    const root = document.documentElement
    root.style.setProperty('--ui-radius', `${ui.radius}px`)
    root.style.setProperty('--ui-line', String(ui.lineHeight))
    root.style.setProperty('--ui-accent', ui.accent)
  }, [settings?.ui])

  useEffect(() => {
    if (!session?.id) return
    void window.triade.listSessions().then(setSessions)
  }, [session?.id])

  useEffect(() => {
    const id = window.setInterval(() => {
      void window.triade.serverStatus().then(setServers)
      // la sidebar riflette sempre ciò che è su disco, indipendentemente dagli eventi
      void window.triade.listSessions().then(setSessions)
    }, 4000)
    return () => window.clearInterval(id)
  }, [])

  const personas = (settings?.personas ?? []).slice(
    0,
    Math.min(3, Math.max(1, settings?.personaCount ?? 3))
  )

  /** Turni visibili in una colonna: quelli dell'agente più i messaggi dell'utente rivolti a lui. */
  const turnsFor = (personaId: string): Turn[] => {
    const all = session?.turns ?? []
    const known = new Set(personas.map((p) => p.id))
    const out: Turn[] = []
    // un messaggio utente non deve mai restare invisibile: se il destinatario non esiste
    // più (chat vecchie, personalità rinominate) lo si attribuisce a chi risponde dopo
    const targetOf = (t: Turn, i: number): string => {
      if (t.toPersonaId && known.has(t.toPersonaId)) return t.toPersonaId
      const next = all.slice(i + 1).find((x) => x.agentId !== 'utente')?.agentId
      if (next && known.has(next)) return next
      return personas[0]?.id ?? ''
    }
    all.forEach((t, i) => {
      if (t.agentId === personaId) {
        out.push(t)
        return
      }
      if (t.agentId === 'utente' && targetOf(t, i) === personaId) out.push(t)
    })
    return out
  }
  const isRunning = session?.state === 'running'
  const activeModel = catalog.find((m) => m.active)
  const lastTokens = session?.turns[session.turns.length - 1]?.tokensIn ?? 0
  const ctxUsed = useMemo(() => {
    const last = session?.turns[session.turns.length - 1]
    const ctx = settings?.contextSize ?? 65536
    return last ? Math.min(1, last.tokensIn / ctx) : 0
  }, [session, settings])

  /** File GGUF corrotti: avvisa, ripara se possibile, altrimenti chiede un altro modello. */
  const checkIntegrity = async (): Promise<boolean> => {
    let reports: Awaited<ReturnType<typeof window.triade.modelsIntegrity>> = []
    try {
      reports = await window.triade.modelsIntegrity()
    } catch {
      return true
    }
    const broken = reports.filter((r) => !r.ok)
    if (!broken.length) return true
    const target =
      broken.find((r) => r.id === (settings?.models.active ?? '')) ?? broken[0]
    pushLog(`modello corrotto: ${target.name} (${target.reason ?? 'motivo sconosciuto'})`)
    setNotice(`${target.name}: file corrotto (${target.reason ?? 'illeggibile'}) — avvio verifica…`)
    if (!target.repairable) {
      setNotice(
        `${target.name} è corrotto e non è riparabile (sorgente non disponibile): scegli un altro modello nelle impostazioni.`
      )
      setShowSettings(true)
      return false
    }
    try {
      const fixed = await window.triade.modelsRepair(target.id)
      setCatalog(await window.triade.modelsCatalog())
      setServers(await window.triade.serverStatus())
      if (!fixed) {
        setNotice(
          `Riparazione di ${target.name} fallita: scegli un altro modello nelle impostazioni.`
        )
        setShowSettings(true)
        return false
      }
      setNotice(`${target.name} verificato e ripristinato.`)
      pushLog(`modello riparato: ${target.name}`)
      return true
    } catch (err) {
      setNotice(`Riparazione di ${target.name} fallita: ${(err as Error).message}`)
      setShowSettings(true)
      return false
    }
  }

  const ensureReady = async (): Promise<void> => {
    if (!settings) return
    const missing = personas.some((p) => {
      const id = settings.models.byPersona[p.id] ?? settings.models.active
      const entry = catalog.find((m) => m.id === id)
      return !entry?.installed
    })
    if (missing) {
      const id = settings.models.active
      setNotice('Scaricamento del modello in corso…')
      await window.triade.modelsInstall(id)
      setCatalog(await window.triade.modelsCatalog())
    }
    if (!servers.some((s) => s.running)) {
      setNotice('Avvio di llama-server (Vulkan)…')
      setServers(await window.triade.startServer())
    }
  }

  const modelLabelOf = (personaId: string): string => {
    const s = settings
    if (!s) return '—'
    const id = s.models.byPersona[personaId] ?? s.models.active
    return catalog.find((m) => m.id === id)?.name ?? id
  }

  const send = async (topic: string, personaId?: string): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      if (!(await checkIntegrity())) return
      await ensureReady()
      const files = attachments.map((a) => a.path)
      const created = await window.triade.submit(topic, files, personaId)
      setSession(created)
      setAttachments([])
      setSessions(await window.triade.listSessions())
      setNotice(null)
    } catch (err) {
      setNotice((err as Error).message)
      pushLog(`invio fallito: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const newChat = async (): Promise<void> => {
    await window.triade.newChat()
    setSession(null)
    setStream(null)
    setStreamReasoning(null)
    setAttachments([])
    setSessions(await window.triade.listSessions())
  }

  const openSession = async (id: string): Promise<void> => {
    const loaded = await window.triade.loadSession(id)
    if (loaded) {
      setSession(loaded)
      setStream(null)
    }
  }

  const stopDebate = async (): Promise<void> => {
    setBusy(true)
    try {
      const s = await window.triade.stopDebate()
      if (s) setSession(s)
      setStream(null)
      setStreamReasoning(null)
      setSessions(await window.triade.listSessions())
    } finally {
      setBusy(false)
    }
  }

  const pause = async (): Promise<void> => {
    const s = await window.triade.pauseDebate()
    if (s) setSession(s)
    setSessions(await window.triade.listSessions())
  }

  const resume = async (): Promise<void> => {
    if (!session) return
    try {
      await ensureReady()
      setSession(await window.triade.resumeDebate(session.id))
    } catch (err) {
      setNotice((err as Error).message)
    }
  }

  return (
    <LocaleContext.Provider value={locale}>
    <div className="shell">
      <aside className="sidebar">
        <button className="primary newchat" onClick={() => void newChat()}>
          {t('app.newChat')}
        </button>
        <div className="sessionlist">
          {sessions.length === 0 && <p className="empty">{t('app.noSessions')}</p>}
          {sessions.map((s) => (
            <div key={s.id} className={`sessionrow ${session?.id === s.id ? 'selected' : ''}`}>
              <button className="rowbtn" onClick={() => void openSession(s.id)}>
                <span className="title" title={s.topic}>
                  {s.title || s.topic.split('\n')[0]}
                </span>
                <span className="sub">
                  {t('app.turns', { n: s.turns })} · {s.state} ·{' '}
                {new Date(s.updatedAt).toLocaleDateString(settings?.ui?.language ?? 'en')}
                </span>
              </button>
              <button
                className="del"
                title={t('app.deleteChat')}
                onClick={async (e) => {
                  e.stopPropagation()
                  if (!window.confirm(t('app.deleteChat'))) return
                  const res = await window.triade.deleteSession(s.id)
                  setSessions(res.sessions)
                  if (session?.id === s.id) setSession(null)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button className="ghost memorybtn" onClick={() => setShowMemory(true)}>
          {t('app.memory')}
        </button>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="brand">
            <span className="logo">◆▲●</span>
            <div>
              <h1>
              TriadeAI <span className="version">v{version}</span>
            </h1>
              <p>
                {t(
                  personas.length <= 1
                    ? 'app.taglineSingle'
                    : personas.length === 2
                      ? 'app.taglineTwo'
                      : 'app.tagline',
                  {
                    model: activeModel ? activeModel.name : 'model',
                    n: personas.length
                  }
                )}
              </p>
            </div>
          </div>

          <div className="badges">
            <span className={`badge ${servers.some((s) => s.running) ? 'ok' : 'off'}`}>
              {t('app.server')} {servers.filter((s) => s.running).length}/{servers.length || 0}
            </span>
            {servers
              .filter((s) => s.running)
              .map((s) => (
                <span className="badge ok" key={s.modelId}>
                  {s.modelId} :{s.port} {s.device.includes('Vulkan') ? 'vulkan' : ''}
                </span>
              ))}
            <span
              className={`badge ${servers.some((s) => s.modelMaxCtx > 0 && s.modelMaxCtx < (settings?.contextSize ?? 0)) ? 'warnbadge' : ''}`}
              title={
                servers[0]?.modelMaxCtx
                  ? `massimo del modello: ${servers[0].modelMaxCtx} token`
                  : 'contesto richiesto nelle impostazioni'
              }
            >
              {t('app.ctx')}{' '}
              {servers.find((s) => s.running)?.contextSize || settings?.contextSize || '—'}
              {servers.some(
                (s) => s.modelMaxCtx > 0 && s.modelMaxCtx < (settings?.contextSize ?? 0)
              ) && ` ${t('app.maxModelCtx')}`}
            </span>
            <span
              className="badge ctxbadge"
              title={`token del prompt nell'ultimo turno su ${settings?.contextSize ?? 0}`}
            >
              {t('app.prompt')} {Math.round(ctxUsed * 100)}%
              {lastTokens > 0 && (
                <span className="tokcount">
                  {lastTokens > 1000 ? `${(lastTokens / 1000).toFixed(1)}k` : lastTokens}/
                  {((settings?.contextSize ?? 0) / 1000).toFixed(0)}k
                </span>
              )}
              <span className="ctxbar">
                <span style={{ width: `${Math.round(ctxUsed * 100)}%` }} />
              </span>
            </span>
          </div>

          <div className="actions">
            {isRunning && (
              <button className="warn" onClick={() => void pause()}>
                {t('app.pause')}
              </button>
            )}
            {(isRunning || session?.state === 'paused') && (
              <button
                className="danger"
                title={t('app.stop')}
                onClick={() => void stopDebate()}
              >
                {t('app.stop')}
              </button>
            )}
            {!isRunning && (
              <button
                className="primary"
                disabled={!session || busy || session.state === 'concluded'}
                onClick={() => void resume()}
              >
                {t('app.resume')}
              </button>
            )}
            <button className="ghost" onClick={() => setShowSettings(true)}>
              {t('app.settings')}
            </button>
            <button className="ghost" onClick={() => setShowLog((v) => !v)}>
              {t('app.log')}
            </button>
          </div>
        </header>

        {notice && <div className="notice">{notice}</div>}

        <main className={`columns cols-${personas.length}`}>
          {personas.map((persona) => (
            <ChatColumn
              key={persona.id}
              persona={persona}
              personas={personas}
              turns={turnsFor(persona.id)}
              streaming={stream?.agentId === persona.id ? stream.text : null}
              ui={settings?.ui}
              modelLabel={(settings?.models.byPersona as Record<string, string> | undefined)?.[persona.id] ?? settings?.models.active}
              port={servers.find((x) => x.modelId === ((settings?.models.byPersona as Record<string, string> | undefined)?.[persona.id] ?? settings?.models.active))?.port ?? null}
              ctx={servers.find((x) => x.modelId === ((settings?.models.byPersona as Record<string, string> | undefined)?.[persona.id] ?? settings?.models.active))?.contextSize ?? null}
              streamReasoning={streamReasoning?.agentId === persona.id ? streamReasoning.text : null}
              phase={phases[persona.id] ?? null}
              nextUp={
                session?.state === 'running' &&
                personas[
                  (session.turns.filter((t) => t.agentId !== 'utente').length +
                    (session.rotationOffset ?? 0)) %
                    Math.max(1, personas.length)
                ]?.id === persona.id
              }
              calledBy={
                session?.turns[session.turns.length - 1]?.mentions?.find((m) => m.targetId === persona.id)
                  ? session?.turns[session.turns.length - 1]?.name ?? null
                  : null
              }
              active={session?.state === 'running' && stream?.agentId === persona.id}
            />
          ))}
        </main>

        {session?.consensus && (
          <section className="consensus">
            <h3>{t('app.consensus')}</h3>
            <p>{session.consensus.answer}</p>
            <small>
              {t('app.proposedBy', { name: session.consensus.proposedBy })} ·{' '}
              {t('app.validatedBy', { name: session.consensus.validatedBy })}
            </small>
          </section>
        )}

        <Composer
          disabled={busy || isRunning}
          running={isRunning}
          mode={session && session.turns.length > 0 ? 'continua' : 'nuova'}
          attachments={attachments}
          onAttach={async () => {
            const picked = await window.triade.pickAttachments()
            setAttachments((prev) => [...prev, ...picked])
          }}
          onDropFiles={async (files) => {
            const added = await window.triade.ingestFiles(files)
            setAttachments((prev) => [...prev, ...added])
          }}
          onRemove={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
          onSend={send}
          personas={personas}
          modelOf={modelLabelOf}
        />

        {showLog && (
          <aside className="logpanel">
            <div className="loghead">
              <strong>log</strong>
              <button className="ghost" onClick={() => setShowLog(false)}>
                {t('common.close')}
              </button>
            </div>
            <pre>{logs.join('\n') || '—'}</pre>
            {servers.map((s) => (
              <pre className="serverlog" key={s.modelId}>
                --- {s.modelId} ---{'\n'}
                {s.log.split('\n').slice(-20).join('\n')}
              </pre>
            ))}
          </aside>
        )}

        {showMemory && <MemoryPanel onClose={() => setShowMemory(false)} />}

        {showSettings && settings && (
          <SettingsPanel
            settings={settings}
            catalog={catalog}
            onClose={() => setShowSettings(false)}
            onSave={async (patch) => {
              const next = await window.triade.saveSettings(patch)
              setSettings(next)
              setCatalog(await window.triade.modelsCatalog())
              setShowSettings(false)
            }}
            onRefresh={async () => {
              setSettings(await window.triade.getSettings())
              setCatalog(await window.triade.modelsCatalog())
            }}
          />
        )}

        {onboarding && settings && (
          <Onboarding
            catalog={catalog}
            backend={settings.backend ?? 'llama'}
            remote={settings.remote}
            onBackend={async (backend, remote) => {
              const next = await window.triade.saveSettings({ backend, remote })
              setSettings(next)
            }}
            language={locale}
            onLanguage={async (l) => {
              const next = await window.triade.saveSettings({
                ui: { ...(settings.ui ?? {}), language: l } as Settings['ui']
              })
              setSettings(next)
              setCatalog(await window.triade.modelsCatalog())
            }}
            onDone={async (installed, active, personaCount) => {
              const next = await window.triade.saveSettings({
                onboardingDone: true,
                personaCount,
                models: { ...settings.models, installed, active }
              })
              setSettings(next)
              setCatalog(await window.triade.modelsCatalog())
              setOnboarding(false)
            }}
            onProgress={async () => setCatalog(await window.triade.modelsCatalog())}
          />
        )}
      </div>
    </div>
    </LocaleContext.Provider>
  )
}
