import { useEffect, useRef, useState } from 'react'
import type { Persona, Turn, UiSettings } from '../../../shared/types'
import Markdown from '../markdown'
import { useT } from '../i18n'

export type Phase = 'prefill' | 'thinking' | 'writing' | 'tool' | 'idle'

const PHASE_KEY: Record<Phase, string> = {
  prefill: 'chat.phase.prefill',
  thinking: 'chat.phase.thinking',
  writing: 'chat.phase.writing',
  tool: 'chat.phase.tool',
  idle: ''
}

interface Props {
  persona: Persona
  /** tutte le personalità: serve per tradurre l'id in nome nelle menzioni/cessioni */
  personas: Persona[]
  turns: Turn[]
  streaming: string | null
  streamReasoning: string | null
  phase: Phase | null
  calledBy: string | null
  nextUp?: boolean
  ui?: UiSettings
  active: boolean
  /** modello assegnato a questa chat (es. ornith-1.5-9b) */
  modelLabel?: string
  /** porta del server che la serve */
  port?: number | null
  /** contesto effettivo di quel server */
  ctx?: number | null
}

export default function ChatColumn({
  persona,
  personas,
  turns,
  streaming,
  streamReasoning,
  phase,
  calledBy,
  nextUp,
  ui,
  active
  modelLabel,
  port,
  ctx
}: Props): JSX.Element {
  const t = useT()
  const boxRef = useRef<HTMLDivElement>(null)
  const reasoningRef = useRef<HTMLPreElement>(null)
  const stickRef = useRef(true)
  const startRef = useRef<number>(0)
  const [elapsed, setElapsed] = useState(0)
  const busy = phase !== null && phase !== 'idle'

  // cronometro visibile accanto allo stato: mostra che sta succedendo qualcosa
  useEffect(() => {
    if (!busy) {
      setElapsed(0)
      return
    }
    if (!startRef.current) startRef.current = Date.now()
    const id = window.setInterval(() => setElapsed(Math.round((Date.now() - startRef.current) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [busy])

  useEffect(() => {
    if (!busy) startRef.current = 0
  }, [busy])

  // il blocco del ragionamento deve scorrere da solo mentre cresce
  useEffect(() => {
    const pre = reasoningRef.current
    if (pre) pre.scrollTop = pre.scrollHeight
  }, [streamReasoning])

  // se l'utente è in fondo, la vista segue i nuovi token; se risale, resta dov'è
  const onScroll = (): void => {
    const box = boxRef.current
    if (!box) return
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight
    stickRef.current = distance < 80
  }

  useEffect(() => {
    const box = boxRef.current
    if (!box || !stickRef.current) return
    const frame = requestAnimationFrame(() => {
      box.scrollTop = box.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [turns.length, streaming, streamReasoning, phase])

  return (
    <section className={`column ${busy ? 'busy' : ''}`} style={{ ['--accent' as string]: persona.color }}>
      <header>
        <span className="dot">{persona.emoji}</span>
        <h2>{persona.name}</h2>
        {modelLabel && (
          <span className="modelchip" title={`${modelLabel}${port ? ` · porta ${port}` : ''}`}>
            {modelLabel}
            {port ? ` :${port}` : ''}
            {ctx ? ` · ${Math.round(ctx / 1024)}k` : ''}
          </span>
        )}
        {busy && (
          <span className={`phase ${phase}`}>
            <span className="spinner" />
            {t(PHASE_KEY[phase as Phase])}
            {elapsed > 0 && ` · ${elapsed}s`}
          </span>
        )}
        {!busy && calledBy && <span className="calledby">{t('chat.calledBy', { name: calledBy })}</span>}
        {!busy && !calledBy && nextUp && <span className="nextup">{t('chat.nextUp')}</span>}
        <span className="count">{turns.length}</span>
      </header>

      <div className="messages" ref={boxRef} onScroll={onScroll}>
        {turns.length === 0 && !streaming && !streamReasoning && (
          <p className="empty">
            {(personas.length <= 1
              ? t('chat.emptySingle', { name: persona.name })
              : t('chat.empty', { name: persona.name })
            ).split('\n').map((line, i) => (
              <span key={i}>
                {line}
                <br />
              </span>
            ))}
          </p>
        )}

        {turns.map((turn) => (
          <article
            key={turn.id}
            className={`bubble ${turn.agentId === 'utente' ? 'user' : ''} ${turn.interrupted ? 'interrupted' : ''}`}
          >
            <div className="meta">
              {turn.agentId === 'utente' ? t('chat.you') : t('chat.turn')}
              {(ui?.showTimestamps ?? true) && ` · ${new Date(turn.ts).toLocaleTimeString('it-IT')}`}
              {turn.agentId === 'utente' && <span className="tok"> · {t('chat.sent')}</span>}
              {turn.agentId === 'utente' && turn.toPersonaId === persona.id && (
                <span className="tok"> · → {persona.name}</span>
              )}
              {(ui?.showTokens ?? true) && turn.tokensIn > 0 && (
                <span className="tok"> · {t('chat.promptTokens', { n: turn.tokensIn })}</span>
              )}
              {turn.cut === 'loop' && <span className="tok"> · {t('chat.cutLoop')}</span>}
              {turn.cut === 'budget' && <span className="tok"> · {t('chat.cutBudget')}</span>}
              {turn.cut === 'handoff' && (
                <span className="tok">
                  {' '}
                  ·{' '}
                  {t('chat.handoff', {
                    name: personas.find((p) => p.id === turn.handoffTo)?.name ?? '—'
                  })}
                </span>
              )}
            </div>

            {ui?.markdown === false ? <pre className="plain">{turn.text}</pre> : <Markdown text={turn.text} />}

            {turn.mentions && turn.mentions.length > 0 && (
              <div className="mentions">
                {turn.mentions.map((m) => (
                  <span className="mention" key={`${turn.id}-${m.targetId}`}>
                    <strong>→ {m.targetName}</strong>
                    <em>{m.reason}</em>
                  </span>
                ))}
              </div>
            )}

            {turn.reasoning && (
              <details className="reasoning">
                <summary>{t('chat.reasoning', { n: turn.reasoning.length })}</summary>
                <pre>{turn.reasoning}</pre>
              </details>
            )}

            {turn.tools.length > 0 && (
              <div className="toolcards">
                {turn.tools.map((t, i) => (
                  <details key={i} className={`toolcard ${t.ok ? 'ok' : 'ko'}`}>
                    <summary>
                      <code>{t.name}</code>
                      <span className="args">
                        {Object.entries(t.args)
                          .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
                          .join(' · ')
                          .slice(0, 90)}
                      </span>
                    </summary>
                    <pre>{t.result.slice(0, 2000)}</pre>
                  </details>
                ))}
              </div>
            )}
          </article>
        ))}

        {(streaming !== null || streamReasoning !== null || (busy && streaming === null)) && (
          <article className="bubble streaming">
            {streamReasoning && (
              <details className="reasoning live" open>
                <summary>
                  <span className="spinner" /> {t('chat.thinkingNow')}
                </summary>
                <pre ref={reasoningRef}>{streamReasoning}</pre>
              </details>
            )}
            {streaming !== null ? (
              <div className="md streamingText">
                {ui?.markdown === false ? <pre className="plain">{streaming}</pre> : <Markdown text={streaming} />}
                <span className="caret" />
              </div>
            ) : (
              busy &&
              !streamReasoning && (
                <div className="waiting">
                  <span className="spinner" />
                  {t(PHASE_KEY[(phase ?? 'prefill') as Phase])}…
                </div>
              )
            )}
          </article>
        )}
      </div>
    </section>
  )
}
