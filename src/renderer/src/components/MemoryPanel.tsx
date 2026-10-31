import { useEffect, useState } from 'react'
import type { MemoryItem, MemoryStats } from '../env'

export default function MemoryPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [items, setItems] = useState<MemoryItem[]>([])
  const [query, setQuery] = useState('')

  const refresh = async (): Promise<void> => {
    setStats(await window.triade.memoryStats())
    setItems(await window.triade.memoryRecent(60))
  }

  useEffect(() => {
    void refresh()
  }, [])

  const search = async (): Promise<void> => {
    if (!query.trim()) return refresh()
    setItems(await window.triade.memorySearch(query))
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="modalbox" onClick={(e) => e.stopPropagation()}>
        <h2>Memoria condivisa</h2>
        <p className="lead">
          Tutto ciò che le chat hanno prodotto finisce in un vector store locale
          (<code>dati/memoria/</code>): i fatti delle sessioni passate vengono richiamati per
          similarità quando servono.
        </p>
        {stats && (
          <div className="memstats">
            <span>{stats.entries} elementi</span>
            {Object.entries(stats.byKind).map(([k, v]) => (
              <span key={k}>
                {k}: {v}
              </span>
            ))}
            <span>{(stats.bytes / 1024).toFixed(0)} KB</span>
            {stats.lastTs > 0 && <span>ultimo: {new Date(stats.lastTs).toLocaleString('it-IT')}</span>}
          </div>
        )}
        <div className="inline">
          <input
            value={query}
            placeholder="cerca nella memoria…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void search()
            }}
          />
          <button className="ghost" onClick={() => void search()}>
            cerca
          </button>
        </div>
        <ul className="memlist">
          {items.map((m) => (
            <li key={m.id}>
              <span className="kind">{m.kind}</span>
              <div>
                <p>{m.text}</p>
                <small>
                  {new Date(m.ts).toLocaleString('it-IT')}
                  {typeof m.score === 'number' && ` · score ${m.score.toFixed(3)}`}
                </small>
              </div>
            </li>
          ))}
          {items.length === 0 && <li className="empty">memoria vuota</li>}
        </ul>
        <footer className="modalfooter">
          <button
            className="warn"
            onClick={async () => {
              setStats(await window.triade.memoryClear())
              setItems([])
            }}
          >
            svuota memoria
          </button>
          <button className="ghost" onClick={onClose}>
            chiudi
          </button>
        </footer>
      </div>
    </div>
  )
}
