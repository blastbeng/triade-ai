import { useRef, useState } from 'react'
import type { Attachment } from '../../../shared/types'

interface Props {
  disabled: boolean
  running: boolean
  mode: 'nuova' | 'continua'
  attachments: Attachment[]
  onAttach: () => Promise<void>
  onDropFiles: (files: string[]) => Promise<void>
  onRemove: (index: number) => void
  onSend: (topic: string) => Promise<void>
}

export default function Composer({
  disabled,
  running,
  mode,
  attachments,
  onAttach,
  onDropFiles,
  onRemove,
  onSend
}: Props): JSX.Element {
  const [text, setText] = useState('')
  const [dragging, setDragging] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  const send = async (): Promise<void> => {
    const topic = text.trim()
    if (!topic || disabled) return
    setText('')
    await onSend(topic)
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
        <button className="ghost attach" onClick={() => void onAttach()} disabled={disabled}>
          +
        </button>
        <textarea
          ref={areaRef}
          value={text}
          placeholder={
            running
              ? 'Dibattito in corso: metti in pausa per scrivere un nuovo argomento.'
              : mode === 'continua'
                ? 'Aggiungi un’istruzione alla chat caricata: la discussione riparte da qui…'
                : 'Scrivi l’argomento del dibattito, allega immagini/video/audio, poi invia…'
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
          {mode === 'continua' ? 'invia' : 'avvia'}
        </button>
      </div>
      <div className="hint">
        Invio = avvia · Shift+Invio = nuova riga · i tre agenti discutono da soli fino al consenso o allo stop
      </div>
    </footer>
  )
}
