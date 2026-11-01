import type { Persona, Turn } from '../../shared/types'

/** `[[PASSA A: Nome]]`: un agente cede la parola a metà frase. */
export const HANDOFF = /\[\[\s*PASSA\s+A:\s*([^\]\n]{1,40})\]{0,2}/i

export interface SpeakerState {
  personas: Persona[]
  turns: Turn[]
  nextSpeakerId?: string
  rotationOffset?: number
}

/**
 * Chi parla al prossimo turno.
 * Priorità: interlocutore richiesto (menzione o cessione di parola) → rotazione,
 * evitando di ridare la parola a chi ha appena parlato.
 */
export function chooseNextSpeaker(state: SpeakerState): Persona {
  const { personas, turns } = state
  const agentTurns = turns.filter((t) => t.agentId !== 'utente')
  const last = agentTurns[agentTurns.length - 1]?.agentId

  if (state.nextSpeakerId) {
    const requested = personas.find((p) => p.id === state.nextSpeakerId)
    if (requested) {
      // se ha appena parlato e c'è un altro disponibile, si passa oltre
      const alternative = personas.find((p) => p.id !== requested.id && p.id !== last)
      if (requested.id === last && alternative && personas.length > 2) return alternative
      return requested
    }
  }

  const offset = state.rotationOffset ?? 0
  for (let step = 0; step < personas.length; step++) {
    const candidate = personas[(agentTurns.length + offset + step) % personas.length]
    if (candidate.id !== last) return candidate
  }
  return personas[(agentTurns.length + offset) % personas.length]
}

/** Trova la personalità nominata in una cessione di parola, se esiste. */
export function parseHandoff(text: string, personas: Persona[], selfId: string): Persona | null {
  const match = HANDOFF.exec(text)
  if (!match) return null
  const wanted = match[1].trim().toLowerCase()
  return (
    personas.find((p) => p.id !== selfId && p.name.toLowerCase().startsWith(wanted.slice(0, 6))) ??
    personas.find((p) => p.id !== selfId && wanted.includes(p.name.toLowerCase().slice(0, 5))) ??
    null
  )
}
