/**
 * Decisione su come è andato un aggiornamento, senza dipendenze da Electron:
 * si basa solo su ciò che è stato scritto su disco.
 *
 * Il rollback che l'utente vedeva ("la versione X non è riuscita ad avviarsi")
 * veniva deciso da un timer: se la nuova versione tardava a scrivere il marker
 * (primo avvio = copia dei binari, controllo GPU con dialogo modale) veniva
 * dichiarata fallita pur essendo viva. Qui il verdetto può arrivare solo da:
 *  - la versione in esecuzione (siamo la nuova → riuscito);
 *  - l'esito scritto dal supervisore (`esito.json`);
 *  - un aggiornamento rimasto a metà (nessun esito, troppo tempo dopo lo swap).
 */

export type UpdateResult = 'ok' | 'rolledback' | 'failed' | 'swap-failed'

export interface PendingUpdate {
  version: string
  target: string
  backup: string
  at: number
}

export interface UpdateOutcome {
  result?: UpdateResult
  version?: string
  reason?: string
}

export interface UpdateDecision {
  version: string
  /** true = la versione nuova non si è avviata ed è stata ripristinata la vecchia */
  rolledBack: boolean
  /** true = il vecchio eseguibile va rimesso al suo posto adesso */
  restore: boolean
}

/** Quanto si lascia lavorare il supervisore prima di considerare l'update interrotto. */
export const SUPERVISOR_GRACE_MS = 3 * 60_000

export function decideUpdateOutcome(input: {
  pending: PendingUpdate | null
  esito: UpdateOutcome | null
  currentVersion: string
  now: number
  backupExists: boolean
}): UpdateDecision | null {
  const { pending, esito, currentVersion, now, backupExists } = input
  if (!pending) return null

  // 1) stiamo girando con la versione nuova: aggiornamento riuscito
  if (pending.version && currentVersion === pending.version) return null

  // 2) il supervisore ha già deciso
  if (esito?.result === 'ok') return null
  if (esito?.result === 'rolledback') {
    return { version: pending.version, rolledBack: true, restore: false }
  }
  if (esito?.result) {
    // la sostituzione non è nemmeno avvenuta: l'app in esecuzione è intatta
    return { version: pending.version, rolledBack: false, restore: false }
  }

  // 3) nessun esito: il supervisore può essere ancora al lavoro
  if (now - (pending.at ?? 0) < SUPERVISOR_GRACE_MS) return null

  // 4) aggiornamento interrotto (spegnimento, kill): si torna alla versione vecchia
  return { version: pending.version, rolledBack: backupExists, restore: backupExists }
}
