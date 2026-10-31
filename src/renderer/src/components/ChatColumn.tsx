import { useEffect, useRef } from 'react'
import type { Persona, Turn } from '../../../shared/types'

interface Props {
  persona: Persona
  turns: Turn[]
  streaming: string | null
  active: boolean
}

export default function ChatColumn({ persona, turns, streaming, active }: Props): JSX.Element {
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
            </div>
            <div className="text">{turn.text}</div>
            {turn.tools.length > 0 && (
              <details className="tools">
                <summary>{turn.tools.length} tool</summary>
                {turn.tools.map((t, i) => (
                  <div key={i} className="toolrow">
                    <code>{t.name}</code>
                    <pre>{t.result.slice(0, 600)}</pre>
                  </div>
                ))}
              </details>
            )}
          </article>
        ))}
        {streaming !== null && (
          <article className="bubble streaming">
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
