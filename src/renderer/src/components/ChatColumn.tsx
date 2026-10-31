import { useEffect, useRef } from 'react'
import type { Persona, Turn } from '../../../shared/types'

interface Props {
  persona: Persona
  turns: Turn[]
  streaming: string | null
  streamReasoning: string | null
  active: boolean
}

export default function ChatColumn({ persona, turns, streaming, streamReasoning, active }: Props): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const box = boxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [turns.length, streaming])

  return (
    <section className="column" style={{ ['--accent' as string]: persona.color }}>
      <header>
        <span className="dot">{persona.emoji}</span>
        <h2>{persona.name}</h2>
        {active && <span className="pulse" />}
        <span className="count">{turns.length}</span>
      </header>

      <div className="messages" ref={boxRef}>
        {turns.length === 0 && !streaming && (
          <p className="empty">In attesa del primo turno.</p>
        )}
        {turns.map((turn) => (
          <article key={turn.id} className={`bubble ${turn.interrupted ? 'interrupted' : ''}`}>
            <div className="meta">
              turno · {new Date(turn.ts).toLocaleTimeString('it-IT')}
              {turn.tokensIn > 0 && <span className="tok"> · {turn.tokensIn} in</span>}
              {turn.cut === 'loop' && <span className="tok"> · fermato: ripetizione</span>}
              {turn.cut === 'budget' && <span className="tok"> · vicino al 75% di contesto</span>}
            </div>
            <div className="text">{turn.text}</div>

            {turn.reasoning && (
              <details className="reasoning">
                <summary>ragionamento</summary>
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
        {(streaming !== null || streamReasoning !== null) && (
          <article className="bubble streaming">
            {streamReasoning && (
              <details className="reasoning live">
                <summary>sta ragionando…</summary>
                <pre>{streamReasoning}</pre>
              </details>
            )}
            <div className="text">
              {streaming}
              <span className="caret" />
            </div>
          </article>
        )}
      </div>
    </section>
  )
}
