import { useState } from 'react'

type Verdict = Awaited<ReturnType<typeof window.triade.hfInspect>>
type Row = { repo: string; downloads: number; tags: string[] }

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`

interface Props {
  /** chiamata dopo che il modello è stato aggiunto (e avviato il download) */
  onInstalled?: (id: string) => void
  onError?: (message: string) => void
}

export default function ModelSearch({ onInstalled, onError }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [quant, setQuant] = useState<string>('')
  const [message, setMessage] = useState<string | null>(null)

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
    try {
      const res = await window.triade.modelsAddCustom(verdict.repo, quant)
      setMessage(`aggiunto: ${verdict.name} ${quant} — download in corso`)
      await window.triade.modelsInstall(res.entry.id)
      onInstalled?.(res.entry.id)
    } catch (err) {
      const text = (err as Error).message
      setMessage(text)
      onError?.(text)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modelsearch">
      <div className="inline">
        <input
          value={query}
          placeholder="cerca un modello GGUF su HuggingFace (es. qwen2.5-vl, gemma-3, mistral)"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search()
          }}
        />
        <button className="ghost" onClick={() => void search()} disabled={busy}>
          cerca
        </button>
      </div>

      {rows.length > 0 && (
        <ul className="hfresults">
          {rows.map((r) => (
            <li key={r.repo}>
              <button className="hfrepo" onClick={() => void inspect(r.repo)} disabled={busy}>
                <span className="repo">{r.repo}</span>
                <span className="meta">
                  {r.downloads.toLocaleString('it-IT')} download
                  {r.tags.includes('image-text-to-text') || r.tags.includes('vision') ? ' · vision' : ''}
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
              {verdict.ok ? 'usabile' : 'escluso'}
            </span>
          </div>
          <p>{verdict.reason}</p>
          <p className="note">
            GPU: {verdict.deviceName ?? 'nessuna'} · VRAM disponibile {verdict.availableMiB} MiB · RAM{' '}
            {(verdict.ramMiB / 1024).toFixed(0)} GB · vision: {verdict.vision ? 'sì' : 'no'}
          </p>

          {verdict.ok && (
            <>
              <label>
                Quant
                <select value={quant} onChange={(e) => setQuant(e.target.value)}>
                  {verdict.variants.map((v) => (
                    <option key={v.quant} value={v.quant} disabled={!v.fits}>
                      {v.quant} · {gb(v.bytes)} · ≈{v.totalMiB} MiB{v.fits ? '' : ' (non entra)'}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary" onClick={() => void add()} disabled={busy || !quant}>
                scarica e aggiungi
              </button>
            </>
          )}
        </div>
      )}

      {message && <p className="note">{message}</p>}
      {busy && <p className="note">verifica in corso…</p>}
    </div>
  )
}
