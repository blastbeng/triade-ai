import { useRef, useState } from 'react'
import type { Attachment, Persona } from '../../../shared/types'
import { useT } from '../i18n'

interface Props {
  disabled: boolean
  running: boolean
  mode: 'nuova' | 'continua'
  attachments: Attachment[]
  onAttach: () => Promise<void>
  onDropFiles: (files: string[]) => Promise<void>
  onRemove: (index: number) => void
  onSend: (topic: string, personaId?: string) => Promise<void>
  personas: Persona[]
  /** modello associato a ciascuna chat, per l'etichetta della select */
  modelOf: (personaId: string) => string
}

export default function Composer({
  disabled,
  running,
  mode,
  attachments,
  onAttach,
  onDropFiles,
  onRemove,
  onSend,
  personas,
  modelOf
}: Props): JSX.Element {
  const t = useT()
  const [text, setText] = useState('')
  const [responder, setResponder] = useState<string>('auto')
  const [dragging, setDragging] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  const send = async (): Promise<void> => {
    const topic = text.trim()
    if (!topic || disabled) return
    setText('')
    await onSend(topic, responder === 'auto' ? undefined : responder)
  }

  return (
    <footer
      className={`composer ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const paths = Array.from(e.dataTransfer.files)
          .map((f) => window.triade.pathForFile(f))
          .filter(Boolean)
        if (paths.length) void onDropFiles(paths)
      }}
    >
      {attachments.length > 0 && (
        <div className="chips">
          {attachments.map((a, i) => (
            <span className={`chip ${a.kind}`} key={`${a.path}-${i}`}>
              {a.kind === 'image' ? '🖼' : a.kind === 'video' ? '🎞' : a.kind === 'audio' ? '🎙' : '📄'} {a.name}
              <button onClick={() => onRemove(i)} aria-label="rimuovi">
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="row">
        <button
          className="ghost attach"
          title={t('composer.attach')}
          onClick={() => void onAttach()}
          disabled={disabled}
        >
          +
        </button>
        {personas.length > 1 && (
        <label className="responder" title={t('composer.attach')}>
          <span>{t('composer.responder')}</span>
          <select value={responder} onChange={(e) => setResponder(e.target.value)} disabled={running}>
            <option value="auto">{t('composer.auto')}</option>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.emoji} {p.name} · {modelOf(p.id)}
              </option>
            ))}
          </select>
        </label>
        )}
        <textarea
          ref={areaRef}
          value={text}
          placeholder={
            running
              ? t('composer.placeholderRunning')
              : mode === 'continua'
                ? t('composer.placeholderContinue')
                : t('composer.placeholder')
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          rows={2}
          disabled={running}
        />
        <button className="primary send" onClick={() => void send()} disabled={disabled || !text.trim()}>
          {mode === 'continua' ? t('composer.send') : t('composer.start')}
        </button>
      </div>
      <div className="hint">
        {t('composer.hint')}
      </div>
    </footer>
  )
}
