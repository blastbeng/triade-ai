import { useEffect, useRef, useState } from 'react'
import type { Persona, Turn, UiSettings } from '../../../shared/types'
import Markdown from '../markdown'

export type Phase = 'prefill' | 'thinking' | 'writing' | 'tool' | 'idle'

const PHASE_LABEL: Record<Phase, string> = {
  prefill: 'preparazione del prompt',
  thinking: 'sta ragionando',
  writing: 'sta scrivendo',
  tool: 'sta usando un tool',
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
}: Props): JSX.Element {
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
        {busy && (
          <span className={`phase ${phase}`}>
            <span className="spinner" />
            {PHASE_LABEL[phase as Phase]}
            {elapsed > 0 && ` · ${elapsed}s`}
          </span>
        )}
        {!busy && calledBy && <span className="calledby">chiamato da {calledBy}</span>}
        {!busy && !calledBy && nextUp && <span className="nextup">ha la parola</span>}
        <span className="count">{turns.length}</span>
      </header>

      <div className="messages" ref={boxRef} onScroll={onScroll}>
        {turns.length === 0 && !streaming && !streamReasoning && (
          <p className="empty">
            {persona.name} non è ancora intervenuto.
            <br />
            Avvia un dibattito: riceverà il turno in automatico.
          </p>
        )}

        {turns.map((turn) => (
          <article
            key={turn.id}
            className={`bubble ${turn.agentId === 'utente' ? 'user' : ''} ${turn.interrupted ? 'interrupted' : ''}`}
          >
            <div className="meta">
              {turn.agentId === 'utente' ? 'tu' : 'turno'}
              {(ui?.showTimestamps ?? true) && ` · ${new Date(turn.ts).toLocaleTimeString('it-IT')}`}
              {turn.agentId === 'utente' && <span className="tok"> · messaggio inviato</span>}
              {(ui?.showTokens ?? true) && turn.tokensIn > 0 && (
                <span className="tok"> · {turn.tokensIn} token di prompt</span>
              )}
              {turn.cut === 'loop' && <span className="tok"> · fermato: ripetizione</span>}
              {turn.cut === 'budget' && <span className="tok"> · vicino al limite di contesto</span>}
              {turn.cut === 'handoff' && (
                <span className="tok">
                  {' '}
                  · ha passato la parola a{' '}
                  {personas.find((p) => p.id === turn.handoffTo)?.name ?? 'un altro agente'}
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
                <summary>ragionamento ({turn.reasoning.length} caratteri)</summary>
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
                  <span className="spinner" /> sta ragionando…
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
                  {PHASE_LABEL[(phase ?? 'prefill') as Phase]}…
                </div>
              )
            )}
          </article>
        )}
      </div>
    </section>
  )
}
