import type { Session } from '../../shared/types'

/**
 * A quale sessione appartiene il messaggio appena scritto dall'utente.
 *  - `new`      : chat nuova, quella in memoria va chiusa
 *  - `open`     : sessione su disco da caricare prima di continuare
 *  - `continue` : è già la sessione corrente
 */
export type SubmitTarget =
  | { kind: 'new' }
  | { kind: 'continue'; sessionId: string }
  | { kind: 'open'; sessionId: string }

/**
 * Decide il bersaglio del messaggio: comanda la chat aperta nell'interfaccia,
 * non quella che l'engine ha in memoria. Senza questa indicazione l'engine
 * continuava la sessione precedente e il suo contesto finiva nella
 * conversazione sbagliata (tre colonne identiche cambiando chat).
 */
export function submitTarget(
  current: Pick<Session, 'id' | 'turns'> | null,
  requested?: string | null
): SubmitTarget {
  // `null` = l'utente è su una chat nuova: la sessione in memoria va chiusa, non continuata
  if (requested === null) return { kind: 'new' }
  // nessuna indicazione (script, chiamanti storici): comportamento di prima
  if (requested === undefined) {
    return current && current.turns.length > 0
      ? { kind: 'continue', sessionId: current.id }
      : { kind: 'new' }
  }
  if (current?.id === requested) return { kind: 'continue', sessionId: requested }
  return { kind: 'open', sessionId: requested }
}
