import { chat, countTokens, type ContentPart, type LlmMessage } from '../llama/client'
import { recallBlock } from '../memory/integrate'
import { mediaUrl } from '../paths'
import type { Persona, Session, Settings, Turn } from '../../shared/types'

const SOLO_PROTOCOL = (name: string, maxTokens: number): string => `
MODALITÀ ASSISTENTE
- Sei ${name} e stai conversando direttamente con l'utente: non c'è nessun dibattito e nessun altro agente.
- Rispondi all'ultimo messaggio dell'utente in modo diretto e completo, nella sua lingua.
- Usa i tool (web_search, fetch_page, image_search, find_media) quando servono fatti, fonti o contenuti multimediali, e cita gli URL letti. Non inventare nulla: se non puoi verificare, dillo.
- Struttura la risposta (paragrafi brevi, elenchi, codice) e chiudi quando hai risposto: niente monologhi, niente conclusioni ripetute.
${maxTokens > 0 ? `- Massimo ~${maxTokens} token.` : '- Sviluppa quanto serve, senza riempitivi.'}
- Non usare @menzioni, [[PASSA A: ...]] né [[CONSENSO]]: non esistono altri interlocutori.`

const PROTOCOL = (
  name: string,
  others: string[],
  roster: string,
  maxTokens: number
): string => `
PROTOCOLLO DEL DIBATTITO
- Sei ${name}. Fai parte di un gruppo di ${others.length + 1} agenti che discute insieme: conosci e vedi gli interventi degli altri.
- IL GRUPPO:
${roster}
- Quando un altro agente è decisivo per il tuo punto, chiamalo per nome con @Nome e spiega in una frase PERCHÉ lo chiami (es. "@Ricercatore verifica questo dato: la mia obiezione dipende da quel numero"). Chi viene chiamato prende la parola al turno successivo: decide tu il prossimo interlocutore.
- Se vuoi cedere subito la parola, anche a metà frase, scrivi [[PASSA A: Nome]] e fermati: la generazione si interrompe lì e parla quella persona. Usalo quando vuoi essere interrotto o quando un altro ha qualcosa di più urgente da dire.
- Puoi anche interrompere un altro: quando hai la parola dillo apertamente ("interrompo qui, perché…") e riprendi il punto contestato, senza ripetere quanto già detto.
- Non chiamare tutti: al massimo una o due menzioni per intervento, solo se servono davvero.
- Ragiona e rispondi in italiano: anche il ragionamento interno va scritto in italiano.
- Parla solo per te: niente intestazioni, niente elenchi di repliche altrui.${maxTokens > 0 ? ` Massimo ~${maxTokens} token.` : ' Sviluppa il ragionamento quanto serve, senza riempitivi.'}
- Ogni intervento deve contenere un contributo sostanziale (almeno 3 frasi): mai una sola riga di cortesia.
- Aggiungi valore: se sei d'accordo dillo in una riga e passa al punto successivo.
- Se un fatto esterno è decisivo, usa i tool disponibili (web_search, fetch_page, image_search, find_media) prima di affermarlo: cita gli URL che hai letto. Non dire "non ho verificato": verifica.
- Non inventare fonti, numeri o citazioni.
- Il dibattito NON ha un limite di turni: continua finché il gruppo non lo chiude con uno dei due marcatori qui sotto. Non fermarti, non ripetere e non riassumere: ogni intervento aggiunge qualcosa.
- Quando ritieni che il gruppo abbia una conclusione condivisa e verificata, scrivi ESATTAMENTE su una riga:
  [[CONSENSO: <la risposta finale in 3 righe>]]
  e poi fermati.
- Non scrivere mai [[CONSENSO]] se restano disaccordi sostanziali.
- Se invece, dopo aver discusso a fondo e verificato i fatti, concludi che una soluzione condivisa NON è raggiungibile, scrivi ESATTAMENTE su una riga:
  [[IMPOSSIBILE: <perché non è possibile e qual è la sintesi migliore a cui siete arrivati>]]
  e poi fermati. Usalo solo per disaccordi reali (fatti, valori, priorità), mai per stanchezza o per evitare di rispondere.`

export function systemPrompt(
  persona: Persona,
  session: Session,
  settings: Settings,
  personas: Persona[]
): string {
  const others = personas.filter((p) => p.id !== persona.id).map((p) => `${p.name}`)
  const roster = personas
    .map((p) => `  - ${p.name}${p.id === persona.id ? ' (sei tu)' : ''}: ${p.prompt.split('.')[0].slice(0, 110)}.`)
    .join('\n')
  const lastTurns = session.turns.slice(-2).map((t) => t.text).join(' ')
  const recall = recallBlock(`${session.topic} ${lastTurns}`, session.id, 6, 1400)
  const solo = personas.length <= 1
  return [
    persona.prompt,
    solo
      ? SOLO_PROTOCOL(persona.name, settings.maxTokensPerTurn)
      : PROTOCOL(persona.name, others, roster, settings.maxTokensPerTurn),
    solo ? `CONVERSAZIONE:\n${session.topic}` : `ARGOMENTO DEL DIBATTITO:\n${session.topic}`,
    session.memory ? `MEMORIA CONDIVISA (sintesi dei turni precedenti):\n${session.memory}` : '',
    recall,
    session.turns.length
      ? `Sei al turno ${session.turns.length + 1}. Il dibattito si chiude solo con [[CONSENSO: …]] o [[IMPOSSIBILE: …]]: nessun tetto di turni.`
      : 'Sei il primo a intervenire: apri il dibattito ponendo il problema in termini operativi.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

function turnAsMessages(personaId: string, personaName: string, turn: Turn): LlmMessage {
  const body = turn.text.trim()
  if (turn.agentId === personaId) {
    return { role: 'assistant', content: body }
  }
  return { role: 'user', content: `[${personaName}]: ${body}` }
}

function imageParts(paths: string[]): ContentPart[] {
  return paths.map((p) => ({ type: 'image_url', image_url: { url: mediaUrl(p) } }))
}

/** Costruisce i messaggi del turno: system + storia (propria = assistant, altrui = user). */
export function buildMessages(
  persona: Persona,
  session: Session,
  settings: Settings,
  personas: Persona[],
  windowTurns = 30
): LlmMessage[] {
  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt(persona, session, settings, personas) }
  ]
  // solo la finestra attiva va al modello; i turni compressi restano su disco e in UI.
  // I turni senza testo (solo [[PASSA A: …]] o [[CONSENSO: …]]) non dicono nulla:
  // mandare messaggi vuoti al server è rumore, e alcuni backend li rifiutano
  const recent = session.turns
    .slice(session.contextFrom ?? 0)
    .filter((t) => t.text.trim().length > 0)
    .slice(-windowTurns)
  for (const turn of recent) {
    messages.push(turnAsMessages(persona.id, turn.name, turn))
  }
  const pendingImages = (session as Session & { pendingImages?: string[] }).pendingImages ?? []
  const cues = [
    `Tocca a te, ${persona.name}. Intervieni ora su "${session.topic}".`,
    pendingImages.length
      ? 'Le immagini allegate sono state appena recuperate: guardale prima di rispondere.'
      : ''
  ].filter(Boolean)
  const last = messages[messages.length - 1]
  if (pendingImages.length) {
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: cues.join(' ') }, ...imageParts(pendingImages)]
    })
  } else {
    messages.push({ role: 'user', content: cues.join(' ') })
  }
  void last
  return messages
}

/** Stima il peso del prompt in token; le immagini contano ~1200 token ciascuna. */
export function estimateTokensText(messages: LlmMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') parts.push(`${m.role}: ${m.content}`)
    else {
      for (const p of m.content) {
        if (p.type === 'text') parts.push(`${m.role}: ${p.text}`)
        else parts.push(`${m.role}: [immagine]`)
      }
    }
  }
  return parts.join('\n')
}

export function approximateTokens(text: string, images = 0): number {
  return Math.ceil(text.length / 3.6) + images * 1200
}

/** Sommario compatto dei turni: è il "prompt compression" al 75% del contesto. */
export async function summarize(
  baseUrl: string,
  session: Session,
  previousMemory: string,
  signal?: AbortSignal
): Promise<string> {
  const transcript = session.turns
    .slice(session.contextFrom ?? 0)
    .filter((t) => t.text.trim().length > 0)
    .slice(-24)
    .map((t) => `[${t.name}] ${t.text}`)
    .join('\n\n')
    .slice(-14000)
  const messages: LlmMessage[] = [
    {
      role: 'system',
      content:
        'Comprimi una discussione in una memoria operativa. Mantieni: obiettivo, posizioni dei partecipanti, fatti accertati con URL, decisioni prese, punti ancora aperti. Non aggiungere opinioni. Massimo 350 parole, italiano.'
    },
    {
      role: 'user',
      content: [
        previousMemory ? `MEMORIA PRECEDENTE:\n${previousMemory}` : '',
        `NUOVI TURNI:\n${transcript}`
      ]
        .filter(Boolean)
        .join('\n\n')
    }
  ]
  const res = await chat(baseUrl, {
    messages,
    temperature: 0.2,
    maxTokens: 700,
    noThinking: true,
    signal
  })
  return res.content.trim()
}

export async function tokenCountOf(
  baseUrl: string,
  messages: LlmMessage[],
  extraTokens = 0
): Promise<number> {
  const images = messages.reduce(
    (n, m) => n + (Array.isArray(m.content) ? m.content.filter((p) => p.type !== 'text').length : 0),
    0
  )
  const flat = estimateTokensText(messages)
  const base = images > 0 ? approximateTokens(flat, images) : await countTokens(baseUrl, flat)
  // gli schemi dei tool e il template di chat occupano contesto: vanno contati
  return base + extraTokens
}
