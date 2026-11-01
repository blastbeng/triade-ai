import { useEffect, useState } from 'react'
import { useT } from '../i18n'

type Verdict = Awaited<ReturnType<typeof window.triade.hfInspect>>
type Row = { repo: string; downloads: number; tags: string[] }

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`

interface Props {
  /** chiamata dopo che il modello è stato aggiunto (e avviato il download) */
  onInstalled?: (id: string) => void
  onError?: (message: string) => void
  /** barra di avanzamento del download (in impostazioni non ce n'è un'altra) */
  showProgress?: boolean
}

export default function ModelSearch({ onInstalled, onError, showProgress }: Props): JSX.Element {
  const t = useT()
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [quant, setQuant] = useState<string>('')
  const [message, setMessage] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ pct: number; phase: string } | null>(null)

  // un modello da 5 GB non si scarica in un attimo: senza avanzamento la
  // finestra sembrerebbe bloccata (l'IPC di install ritorna a fine download)
  useEffect(() => {
    if (!showProgress) return
    return window.triade.onEvent((event) => {
      if (event.type !== 'model') return
      const st = event.status as
        | { id?: string; progress?: number; phase?: string; downloading?: boolean }
        | undefined
      if (!st) return
      if (installing && st.id !== installing) return
      if (!st.downloading) {
        setProgress(null)
        return
      }
      setProgress({ pct: Math.round((st.progress ?? 0) * 100), phase: st.phase ?? '' })
    })
  }, [showProgress, installing])

  const search = async (): Promise<void> => {
    const q = query.trim()
    if (!q) return
    setBusy(true)
    setVerdict(null)
    setMessage(null)
    try {
      setRows(await window.triade.hfSearch(q))
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const inspect = async (repo: string): Promise<void> => {
    setBusy(true)
    setMessage(null)
    setVerdict(null)
    try {
      const v = await window.triade.hfInspect(repo)
      setVerdict(v)
      setQuant(v.quant ?? v.variants.find((x) => x.fits)?.quant ?? '')
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const add = async (): Promise<void> => {
    if (!verdict || !quant) return
    setBusy(true)
    setMessage(null)
    setProgress(null)
    try {
      const res = await window.triade.modelsAddCustom(verdict.repo, quant)
      setMessage(t('search.added', { name: verdict.name, quant }))
      setInstalling(res.entry.id)
      try {
        await window.triade.modelsInstall(res.entry.id)
      } finally {
        setInstalling(null)
        setProgress(null)
      }
      onInstalled?.(res.entry.id)
    } catch (err) {
      const text = (err as Error).message
      setMessage(text)
      onError?.(text)
    } finally {
      setBusy(false)
    }
  }

  const reasonText = (v: Verdict): string => {
    const main = t(v.reasonCode || 'reason.noFiles', v.reasonParams)
    const notes = (v.notes ?? []).map((n) => t(n.code, n.params)).join('')
    return `${main}${notes}`
  }

  return (
    <div className="modelsearch">
      <div className="inline">
        <input
          value={query}
          placeholder={t('search.placeholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search()
          }}
        />
        <button className="ghost" onClick={() => void search()} disabled={busy}>
          {t('search.find')}
        </button>
      </div>

      {rows.length > 0 && (
        <ul className="hfresults">
          {rows.map((r) => (
            <li key={r.repo}>
              <button className="hfrepo" onClick={() => void inspect(r.repo)} disabled={busy}>
                <span className="repo">{r.repo}</span>
                <span className="meta">
                  {t('search.downloads', { n: r.downloads.toLocaleString() })}
                  {r.tags.includes('image-text-to-text') || r.tags.includes('vision')
                    ? ` · ${t('search.vision')}`
                    : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {verdict && (
        <div className={`verdict ${verdict.ok ? 'ok' : 'ko'}`}>
          <div className="vhead">
            <strong>{verdict.name}</strong>
            <span className={`tag ${verdict.ok ? 'ok' : 'ko'}`}>
              {verdict.ok ? t('search.usable') : t('search.excluded')}
            </span>
          </div>
          <p>{reasonText(verdict)}</p>
          <p className="note">
            {t('search.gpu')}: {verdict.deviceName ?? t('search.none')} ·{' '}
            {t('search.available', { n: verdict.availableMiB })} ·{' '}
            {t('search.ram', { n: (verdict.ramMiB / 1024).toFixed(0) })} ·{' '}
            {verdict.vision ? t('search.visionYes') : t('search.visionNo')}
          </p>
          <div className="chips">
            <span className="chip">{verdict.arch}</span>
            {verdict.moe && <span className="chip moe">{t('search.moe')}</span>}
            {verdict.mode === 'partial' && <span className="chip warn">{t('search.expertsOnCpu')}</span>}
            {verdict.mode === 'full' && <span className="chip ok">{t('search.allInGpu')}</span>}
            {verdict.ok && verdict.contextSuggestion > 0 && (
              <span className="chip">{t('search.ctxSuggestion', { n: verdict.contextSuggestion })}</span>
            )}
            {verdict.ok && verdict.mode === 'partial' && (
              <span className="chip">{t('search.ramNeeded', { n: (verdict.ramNeededMiB / 1024).toFixed(1) })}</span>
            )}
          </div>

          {verdict.ok && (
            <>
              <label>
                {t('search.quant')}
                <select value={quant} onChange={(e) => setQuant(e.target.value)}>
                  {verdict.variants.map((v) => (
                    <option key={v.quant} value={v.quant} disabled={!v.fits && !v.fitsPartial}>
                      {v.quant} · {gb(v.bytes)} ·{' '}
                      {v.fits
                        ? t('search.allGpu', { n: v.ctxFull })
                        : v.fitsPartial
                          ? t('search.expertsCpu', { n: v.ctxPartial })
                          : t('search.noFit')}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary" onClick={() => void add()} disabled={busy || !quant}>
                {t('search.add')}
              </button>
            </>
          )}
        </div>
      )}

      {progress && (
        <>
          <div className="dlbar">
            <div className="dlfill" style={{ width: `${progress.pct}%` }} />
          </div>
          <p className="note">
            {progress.phase} · {progress.pct}%
          </p>
        </>
      )}
      {message && <p className="note">{message}</p>}
      {busy && <p className="note">{t('search.checking')}</p>}
    </div>
  )
}
