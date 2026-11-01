import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessionsDir } from '../paths'
import type { Session } from '../../shared/types'
import { visibleTurn } from '../../shared/turns'

/** Titolo provvisorio: prime parole del messaggio, tagliate a fine parola. */
export function provisionalTitle(topic: string): string {
  const flat = topic
    .replace(/ALLEGATO:[^\n]*/g, ' ')
    .replace(/Materiale fornito dall'utente:?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const sentence = flat.split(/(?<=[.!?])\s/)[0] ?? flat
  const base = sentence.length > 8 ? sentence : flat
  if (base.length <= 58) return base || 'nuova chat'
  const cut = base.slice(0, 58)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trim()}…`
}

export function newSession(topic: string): Session {
  const now = Date.now()
  return {
    id: randomUUID(),
    topic,
    title: provisionalTitle(topic),
    createdAt: now,
    updatedAt: now,
    state: 'paused',
    turnIndex: 0,
    turns: [],
    memory: ''
  }
}

export function saveSession(session: Session): void {
  session.updatedAt = Date.now()
  const file = path.join(sessionsDir(), `${session.id}.json`)
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(session, null, 2), 'utf8')
  fs.renameSync(`${file}.tmp`, file)
}

export function loadSession(id: string): Session | null {
  const file = path.join(sessionsDir(), `${id}.json`)
  if (!fs.existsSync(file)) return null
  try {
    const session = JSON.parse(fs.readFileSync(file, 'utf8')) as Session
    // un processo chiuso a metà non può essere ancora "running"
    if (session.state === 'running') session.state = 'paused'
    return session
  } catch {
    return null
  }
}

export interface SessionSummary {
  id: string
  topic: string
  title: string
  updatedAt: number
  state: Session['state']
  turns: number
}

export function listSessions(): SessionSummary[] {
  const dir = sessionsDir()
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Session
        return {
          id: s.id,
          topic: s.topic,
          title: s.title ?? provisionalTitle(s.topic),
          updatedAt: s.updatedAt,
          state: s.state,
          // i turni fatti solo di marcatori non sono interventi visibili
          turns: s.turns.filter(visibleTurn).length
        }
      } catch {
        return null
      }
    })
    .filter((x): x is SessionSummary => !!x)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function deleteSession(id: string): void {
  const file = path.join(sessionsDir(), `${id}.json`)
  if (fs.existsSync(file)) fs.rmSync(file, { force: true })
}
