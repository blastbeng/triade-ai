import { useState } from 'react'
import type { Backend, RemoteBackendConfig, RemoteSettings } from '../../../shared/types'
import { useT } from '../i18n'

interface Props {
  backend: Backend
  remote: RemoteSettings
  onChange: (backend: Backend, remote: RemoteSettings) => void
}

const OPTIONS: { id: Backend; label: string }[] = [
  { id: 'llama', label: 'llama-server (locale, Vulkan/CUDA)' },
  { id: 'openai', label: 'OpenAI API' },
  { id: 'anthropic', label: 'Anthropic API (Claude)' },
  { id: 'ollama', label: 'Ollama (locale o remoto)' }
]

export default function BackendPanel({ backend, remote, onChange }: Props): JSX.Element {
  const t = useT()
  const [models, setModels] = useState<string[]>([])
  const [probe, setProbe] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const cfg = backend === 'llama' ? null : remote[backend]

  const setCfg = (patch: Partial<RemoteBackendConfig>): void => {
    if (!cfg) return
    onChange(backend, { ...remote, [backend]: { ...cfg, ...patch } } as RemoteSettings)
  }

  const loadModels = async (): Promise<void> => {
    if (!cfg) return
    setBusy(true)
    setProbe(null)
    try {
      const list = await window.triade.remoteModels(backend, cfg.baseUrl, cfg.apiKey)
      setModels(list)
      if (!cfg.model && list.length) setCfg({ model: list[0] })
      setProbe(t('backend.modelsFound', { n: list.length }))
    } catch (err) {
      setProbe(`${t('common.error')}: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const test = async (): Promise<void> => {
    if (!cfg) return
    setBusy(true)
    setProbe(null)
    try {
      const res = await window.triade.remoteTest({
        backend,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model
      })
      setProbe(res.ok ? `ok · ${res.detail}` : `${t('common.error')}: ${res.detail}`)
    } catch (err) {
      setProbe(`${t('common.error')}: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="backendpanel">
      <label>
        {t('backend.title')}
        <select
          value={backend}
          onChange={(e) => onChange(e.target.value as Backend, remote)}
        >
          {OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {backend === 'llama' ? (
        <p className="note">{t('backend.llamaNote')}</p>
      ) : (
        <>
          <label>
            {t('backend.baseUrl')}
            <input
              value={cfg?.baseUrl ?? ''}
              onChange={(e) => setCfg({ baseUrl: e.target.value })}
              placeholder={
                backend === 'openai'
                  ? 'https://api.openai.com/v1'
                  : backend === 'anthropic'
                    ? 'https://api.anthropic.com/v1'
                    : 'http://127.0.0.1:11434/v1'
              }
            />
          </label>
          <label>
            {t('backend.apiKey')}
            <input
              type="password"
              value={cfg?.apiKey ?? ''}
              onChange={(e) => setCfg({ apiKey: e.target.value })}
              placeholder={backend === 'ollama' ? t('backend.optional') : 'sk-…'}
            />
          </label>
          <label>
            {t('backend.model')}
            <div className="inline">
              <select value={cfg?.model ?? ''} onChange={(e) => setCfg({ model: e.target.value })}>
                <option value="">{t('backend.chooseModel')}</option>
                {[...new Set([...(cfg?.model ? [cfg.model] : []), ...models])].map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <button className="ghost" onClick={() => void loadModels()} disabled={busy}>
                {t('backend.loadModels')}
              </button>
              <button className="ghost" onClick={() => void test()} disabled={busy}>
                {t('backend.test')}
              </button>
            </div>
          </label>
          <p className="note">{t('backend.note')}</p>
          {probe && <p className="note">{probe}</p>}
        </>
      )}
    </div>
  )
}
