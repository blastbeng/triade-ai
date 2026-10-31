import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessionsDir } from '../paths'
import type { Session } from '../../shared/types'

export function newSession(topic: string): Session {
  const now = Date.now()
  return {
    id: randomUUID(),
    topic,
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
        return { id: s.id, topic: s.topic, updatedAt: s.updatedAt, state: s.state, turns: s.turns.length }
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
