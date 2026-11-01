import { describe, expect, it } from 'vitest'
import {
  SUPERVISOR_GRACE_MS,
  decideUpdateOutcome,
  type PendingUpdate
} from '../src/main/update-plan'

const at = 1_700_000_000_000
const pending: PendingUpdate = {
  version: '0.21.0',
  target: 'C:\\TriadeAI.exe',
  backup: 'C:\\TriadeAI.exe.old',
  at
}

const decide = (
  over: Partial<{
    pending: PendingUpdate | null
    esito: { result?: 'ok' | 'rolledback' | 'failed' | 'swap-failed' } | null
    currentVersion: string
    now: number
    backupExists: boolean
  }> = {}
): ReturnType<typeof decideUpdateOutcome> =>
  decideUpdateOutcome({
    pending,
    esito: null,
    currentVersion: '0.20.5',
    now: at + SUPERVISOR_GRACE_MS + 1,
    backupExists: true,
    ...over
  })

describe('decideUpdateOutcome', () => {
  it('senza aggiornamento in sospeso non dice nulla', () => {
    expect(decide({ pending: null })).toBeNull()
  })

  it('se gira la versione nuova è riuscito', () => {
    expect(decide({ currentVersion: '0.21.0' })).toBeNull()
    expect(decide({ currentVersion: '0.21.0', esito: { result: 'rolledback' } })).toBeNull()
  })

  it('con esito ok non mostra nulla e non ripristina', () => {
    expect(decide({ esito: { result: 'ok' } })).toBeNull()
  })

  it('esito rolledback: lo dice e non tocca i file (ci ha già pensato il supervisore)', () => {
    expect(decide({ esito: { result: 'rolledback' } })).toEqual({
      version: '0.21.0',
      rolledBack: true,
      restore: false
    })
  })

  it('sostituzione mai avvenuta: non è un rollback, nessun ripristino', () => {
    expect(decide({ esito: { result: 'swap-failed' }, backupExists: false })).toEqual({
      version: '0.21.0',
      rolledBack: false,
      restore: false
    })
  })

  it('nessun esito e supervisore ancora al lavoro: non decide', () => {
    expect(decide({ now: at + 30_000 })).toBeNull()
    // un avvio lento (copia binari, dialogo GPU) non deve mai essere un fallimento
    expect(decide({ now: at + SUPERVISOR_GRACE_MS - 1 })).toBeNull()
  })

  it('aggiornamento interrotto con copia di riserva: ripristina e avvisa', () => {
    expect(decide({ backupExists: true })).toEqual({
      version: '0.21.0',
      rolledBack: true,
      restore: true
    })
  })

  it('aggiornamento interrotto senza copia di riserva: nulla è stato toccato', () => {
    expect(decide({ backupExists: false })).toEqual({
      version: '0.21.0',
      rolledBack: false,
      restore: false
    })
  })
})
