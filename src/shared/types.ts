export type Role = 'system' | 'user' | 'assistant'

export interface Persona {
  id: string
  name: string
  emoji: string
  color: string
  prompt: string
}

export type SearchProvider = 'searxng' | 'brave' | 'tavily' | 'googlecse'

export interface SearchSettings {
  provider: SearchProvider
  searxngUrl: string
  braveKey: string
  tavilyKey: string
  googleKey: string
  googleCx: string
  maxResults: number
}

export interface CustomModelEntry {
  id: string
  name: string
  repo: string
  quant: string
  modelFile: string
  mmprojFile?: string
  bytes: number
  vision: boolean
}

export interface Settings {
  /** Dimensione contesto (token) condivisa dalle 3 chat. */
  contextSize: number
  /** Frazione del contesto oltre la quale scatta il prompt compression (0.75 = 75%). */
  compressionThreshold: number
  gpuLayers: number
  /** adatta -c, -ngl, KV, batch e offload del mmproj alla VRAM reale */
  autoTune: boolean
  flashAttention: boolean
  kvCacheType: 'f16' | 'q8_0'
  maxTokensPerTurn: number
  maxTurns: number
  temperature: number
  /** scala del testo dell'interfaccia (1 = 14px) */
  textScale: number
  toolsEnabled: boolean
  search: SearchSettings
  personas: Persona[]
  asr: { enabled: boolean; modelFile: string; language: string }
  /** Modelli: catalogo selezionato, modello attivo e modello per ciascuna chat. */
  models: {
    installed: string[]
    active: string
    byPersona: Record<string, string>
    /** modelli scelti dalla ricerca HuggingFace, verificati prima dell'aggiunta */
    custom: CustomModelEntry[]
  }
  /** false al primo avvio: mostra la scelta del modello. */
  onboardingDone: boolean
  /** GPU scelta per ciascuna chat (chiave tipo "vulkan:1"); vuoto = automatica. */
  gpus: { byPersona: Record<string, string> }
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ToolRun {
  name: string
  args: Record<string, unknown>
  result: string
  ok: boolean
}

export interface Mention {
  /** id della personalità chiamata in causa */
  targetId: string
  targetName: string
  /** frase con cui la chiama: il "perché" */
  reason: string
}

export interface Turn {
  id: string
  agentId: string
  name: string
  /** altre chat chiamate in causa in questo intervento, con il motivo */
  mentions?: Mention[]
  text: string
  /** ragionamento del modello, nascosto nella UI salvo espansione */
  reasoning?: string
  ts: number
  tokensIn: number
  tokensOut: number
  tools: ToolRun[]
  interrupted?: boolean
  /** perché la generazione si è fermata: ripetizione o limite di contesto */
  cut?: 'loop' | 'budget'
}

export type SessionState = 'running' | 'paused' | 'concluded' | 'error'

export interface Consensus {
  answer: string
  proposedBy: string
  validatedBy: string
}

export interface Session {
  id: string
  topic: string
  createdAt: number
  updatedAt: number
  state: SessionState
  turnIndex: number
  turns: Turn[]
  /** Memoria condivisa: sommario compresso della conversazione. */
  memory: string
  /** Indice del primo turno incluso nel prompt: la trascrizione completa non si perde mai. */
  contextFrom?: number
  /** Sfasamento della rotazione: chi parla al prossimo turno (scelta dell'utente). */
  rotationOffset?: number
  consensus?: Consensus
  lastError?: string
  /** Immagini da mostrare al prossimo turno (ricerca immagini / frame video). */
  pendingImages?: string[]
  /** Allegati iniziali forniti dall'utente. */
  attachments?: Attachment[]
}

export interface Attachment {
  path: string
  kind: 'image' | 'video' | 'audio' | 'file'
  name: string
  mime: string
  /** Trascrizione (audio/video) o testo estratto. */
  text?: string
  /** Frame estratti dal video. */
  frames?: string[]
}

export interface ModelStatus {
  id: string
  name: string
  modelPath: string
  mmprojPath: string
  modelReady: boolean
  mmprojReady: boolean
  modelBytes: number
  mmprojBytes: number
  expectedBytes: number
  downloading: boolean
  progress: number
  phase: string
  error?: string
}

export interface ServerStatus {
  modelId: string
  running: boolean
  starting: boolean
  port: number | null
  device: string
  log: string
}

export interface DebateEvent {
  type:
    | 'state'
    | 'delta'
    | 'turn'
    | 'tool'
    | 'compression'
    | 'consensus'
    | 'error'
    | 'log'
    | 'session'
    | 'model'
    | 'reasoning'
    | 'phase'
  [key: string]: unknown
}

export const DEFAULT_PERSONAS: Persona[] = [
  {
    id: 'architetto',
    name: 'Architetto',
    emoji: '◆',
    color: '#5eead4',
    prompt:
      'Sei l’Architetto. Ragioni per strutture: scompone il problema in parti, propone un piano concreto e verificabile, sceglie tra alternative con criteri espliciti. Sei sintetico, mai vago: ogni affermazione deve poter essere controllata. Quando gli altri sbagliano, correggi indicando il punto esatto della loro argomentazione.'
  },
  {
    id: 'avvocato',
    name: 'Avvocato del diavolo',
    emoji: '▲',
    color: '#fca5a5',
    prompt:
      'Sei l’Avvocato del diavolo. Il tuo compito è attaccare l’idea corrente: cerca falle logiche, casi limite, costi nascosti, rischi di sicurezza e assunzioni non verificate. Non sei cinico, sei utile: ogni critica deve indicare un’alternativa migliore o un test che la falsifichi. Se un’idea regge alle tue obiezioni, ammettilo esplicitamente.'
  },
  {
    id: 'ricercatore',
    name: 'Ricercatore',
    emoji: '●',
    color: '#93c5fd',
    prompt:
      'Sei il Ricercatore. Porti prove: quando una discussione dipende da fatti esterni usi i tool (web_search, fetch_page, image_search, find_media) e citi le fonti con URL. Non inventi dati: se non hai trovato nulla, lo dichiari. Riassumi i fatti rilevanti in elenco, senza interpretazioni non richieste.'
  }
]

export const DEFAULT_SETTINGS: Settings = {
  contextSize: 131072,
  compressionThreshold: 0.75,
  gpuLayers: 999,
  autoTune: true,
  flashAttention: true,
  kvCacheType: 'q8_0',
  maxTokensPerTurn: 0,
  maxTurns: 40,
  temperature: 0.85,
  textScale: 1,
  toolsEnabled: true,
  search: {
    provider: 'searxng',
    searxngUrl: 'https://searx.be',
    braveKey: '',
    tavilyKey: '',
    googleKey: '',
    googleCx: '',
    maxResults: 5
  },
  personas: DEFAULT_PERSONAS,
  asr: { enabled: true, modelFile: 'ggml-base.bin', language: 'it' },
  models: { installed: [], active: 'ornith-1.5-9b', byPersona: {}, custom: [] },
  onboardingDone: false,
  gpus: { byPersona: {} }
}
