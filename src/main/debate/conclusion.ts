/** `[[CONSENSO: …]]`: il gruppo ha una risposta condivisa (verificata dal giudice). */
export const CONSENSUS_MARKER = /\[\[\s*CONSENSO\s*(?::([\s\S]*?))?\s*\]\]/i

/** `[[IMPOSSIBILE: …]]`: il gruppo ha accertato che non esiste una soluzione condivisa. */
export const IMPOSSIBLE_MARKER = /\[\[\s*IMPOSSIBILE\s*(?::([\s\S]*?))?\s*\]\]/i

export type ClosingKind = 'consenso' | 'impossibile'

export interface Closing {
  kind: ClosingKind
  /** testo scritto dall'agente dentro il marcatore (può essere vuoto) */
  answer: string
}

/**
 * Riconosce il marcatore con cui un agente chiude il dibattito.
 * L'impossibilità ha la precedenza: è la dichiarazione più esplicita.
 */
export function parseClosing(text: string): Closing | null {
  const impossible = IMPOSSIBLE_MARKER.exec(text)
  if (impossible) return { kind: 'impossibile', answer: (impossible[1] ?? '').trim() }
  const consensus = CONSENSUS_MARKER.exec(text)
  if (consensus) return { kind: 'consenso', answer: (consensus[1] ?? '').trim() }
  return null
}

/** I marcatori sono istruzioni per l'app: non vanno mostrati nelle bolle. */
export function stripClosingMarkers(text: string): string {
  return text.replace(IMPOSSIBLE_MARKER, '').replace(CONSENSUS_MARKER, '').trim()
}

/**
 * Un agente non può dichiarare l'impossibilità al primo turno: prima di
 * chiudere il dibattito il gruppo deve aver discusso davvero.
 */
export const MIN_TURNS_BEFORE_IMPOSSIBLE = 3

export function impossibleTooEarly(agentTurns: number): boolean {
  return agentTurns < MIN_TURNS_BEFORE_IMPOSSIBLE
}
