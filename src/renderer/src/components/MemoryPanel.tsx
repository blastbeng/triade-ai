import { useEffect, useState } from 'react'
import type { MemoryItem, MemoryStats } from '../env'

import { useT } from '../i18n'
import { renderRichText } from '../richtext'

export default function MemoryPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const t = useT()
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

  const remove = async (id: string): Promise<void> => {
    const res = await window.triade.memoryDelete([id])
    setStats(res.stats)
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  const search = async (): Promise<void> => {
    if (!query.trim()) return refresh()
    setItems(await window.triade.memorySearch(query))
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="modalbox" onClick={(e) => e.stopPropagation()}>
        <h2>{t('memory.title')}</h2>
        <p className="lead">{renderRichText(t('memory.lead'))}</p>
        {stats && (
          <div className="memstats">
            <span>{t('memory.entries', { n: stats.entries })}</span>
            {Object.entries(stats.byKind).map(([k, v]) => (
              <span key={k}>
                {k}: {v}
              </span>
            ))}
            <span>{(stats.bytes / 1024).toFixed(0)} KB</span>
            {stats.lastTs > 0 && (
              <span>
                {t('memory.last', { date: new Date(stats.lastTs).toLocaleString() })}
              </span>
            )}
          </div>
        )}
        <div className="inline">
          <input
            value={query}
            placeholder={t('memory.search')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void search()
            }}
          />
          <button className="ghost" onClick={() => void search()}>
            {t('memory.find')}
          </button>
        </div>
        <ul className="memlist">
          {items.map((m) => (
            <li key={m.id}>
              <span className="kind">{m.kind}</span>
              <div>
                <p>{m.text}</p>
                <small>
                  {new Date(m.ts).toLocaleString()}
                  {typeof m.score === 'number' && ` · score ${m.score.toFixed(3)}`}
                </small>
              </div>
              <button className="memdel" title={t('memory.delete')} onClick={() => void remove(m.id)}>
                ×
              </button>
            </li>
          ))}
          {items.length === 0 && <li className="empty">{t('memory.empty')}</li>}
        </ul>
        <footer className="modalfooter">
          <button
            className="warn"
            onClick={async () => {
              setStats(await window.triade.memoryClear())
              setItems([])
            }}
          >
            {t('memory.clear')}
          </button>
          <button className="ghost" onClick={onClose}>
            {t('memory.close')}
          </button>
        </footer>
      </div>
    </div>
  )
}
