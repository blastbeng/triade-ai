import type { Turn } from './types'

/** segnaposto scritto dalle versioni precedenti per i turni fatti solo di marcatori */
export const EMPTY_TURN = '[nessun contenuto]'

/**
 * Un intervento senza testo — solo `[[PASSA A: …]]` o `[[CONSENSO: …]]` — non ha
 * niente da mostrare: la bolla va omessa, non riempita con un segnaposto.
 * Vale anche per le chat salvate quando il segnaposto veniva scritto.
 */
export function visibleTurn(turn: Pick<Turn, 'text' | 'reasoning'>): boolean {
  const text = (turn.text ?? '').trim()
  if (turn.reasoning) return true
  return text !== '' && text !== EMPTY_TURN
}

/**
 * Il tetto di turni è raggiunto? `maxTurns = 0` (default) significa illimitato:
 * il dibattito prosegue finché il gruppo non lo chiude.
 */
export function turnLimitReached(maxTurns: number | undefined, agentTurns: number): boolean {
  const limit = Math.trunc(Number(maxTurns)) || 0
  return limit > 0 && agentTurns >= limit
}
