import { Fragment, type ReactNode } from 'react'

/** Markdown minimale: grassetto, corsivo, codice, titoli, liste, citazioni, link. */
function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s)]+)/g
  let last = 0
  let match: RegExpExecArray | null
  let i = 0
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyBase}-${i++}`
    if (token.startsWith('**')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('[')) {
      const m = /\[([^\]]+)\]\(([^)]+)\)/.exec(token)
      nodes.push(
        <a key={key} href={m?.[2]} target="_blank" rel="noreferrer">
          {m?.[1] ?? token}
        </a>
      )
    } else if (/^https?:/.test(token)) {
      nodes.push(
        <a key={key} href={token} target="_blank" rel="noreferrer">
          {token.length > 60 ? `${token.slice(0, 57)}…` : token}
        </a>
      )
    } else nodes.push(<em key={key}>{token.slice(1, -1)}</em>)
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export default function Markdown({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let list: string[] = []
  let code: string[] | null = null

  const flushList = (): void => {
    if (!list.length) return
    const items = [...list]
    blocks.push(
      <ul key={`ul-${blocks.length}`}>
        {items.map((item, idx) => (
          <li key={idx}>{inline(item, `li-${blocks.length}-${idx}`)}</li>
        ))}
      </ul>
    )
    list = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('```')) {
      if (code === null) {
        code = []
      } else {
        blocks.push(
          <pre key={`code-${blocks.length}`}>
            <code>{code.join('\n')}</code>
          </pre>
        )
        code = null
      }
      continue
    }
    if (code !== null) {
      code.push(line)
      continue
    }
    if (!line.trim()) {
      flushList()
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushList()
      const level = Math.min(4, heading[1].length)
      const Tag = (`h${level}` as unknown) as keyof JSX.IntrinsicElements
      blocks.push(<Tag key={`h-${blocks.length}`}>{inline(heading[2], `h-${blocks.length}`)}</Tag>)
      continue
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    if (bullet) {
      list.push(bullet[1])
      continue
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (numbered) {
      list.push(numbered[1])
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      flushList()
      blocks.push(
        <blockquote key={`q-${blocks.length}`}>{inline(line.replace(/^\s*>\s?/, ''), `q-${blocks.length}`)}</blockquote>
      )
      continue
    }
    flushList()
    blocks.push(<p key={`p-${blocks.length}`}>{inline(line, `p-${blocks.length}`)}</p>)
  }
  flushList()
  if (code !== null) {
    blocks.push(
      <pre key={`code-${blocks.length}`}>
        <code>{code.join('\n')}</code>
      </pre>
    )
  }
  return <div className="md">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>
}
