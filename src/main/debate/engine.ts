import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { chat, type LlmMessage } from '../llama/client'
import { llamaPool } from '../llama/server'
import { getSettings } from '../settings'
import { defaultModelId } from '../models/registry'
import type { Attachment, DebateEvent, Persona, Session, Turn } from '../../shared/types'
import { buildMessages, summarize, tokenCountOf } from './context'
import { loadSession, newSession, saveSession } from './store'
import { distillSession, rememberTurn, rememberUserNote } from '../memory/integrate'
import { TOOL_SPECS, runTool } from './tools'

const CONSENSUS = /\[\[\s*CONSENSO\s*(?::([\s\S]*?))?\s*\]\]/i
const MAX_TOOL_ROUNDS = 2

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}')
    return typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export class DebateEngine extends EventEmitter {
  private session: Session | null = null
  private abort: AbortController | null = null
  private looping = false

  get current(): Session | null {
    return this.session
  }

  private emitEvent(event: DebateEvent): void {
    this.emit('event', event)
  }

  private setState(state: Session['state']): void {
    if (!this.session) return
    this.session.state = state
    saveSession(this.session)
    this.emitEvent({ type: 'state', state })
  }

  /** Modello assegnato alla singola chat (default: modello attivo globale). */
  private modelFor(persona: Persona): string {
    const s = getSettings()
    return s.models.byPersona[persona.id] ?? s.models.active ?? defaultModelId()
  }

  /** GPU assegnata alla singola chat; undefined = automatica (o unica disponibile). */
  private deviceFor(persona: Persona): string | undefined {
    const key = getSettings().gpus.byPersona[persona.id]
    return key && key !== 'auto' ? key : undefined
  }

  /** Nuova chat: la precedente resta su disco e nella memoria vettoriale. */
  async reset(): Promise<void> {
    await this.halt()
    if (this.session) {
      const done = this.session
      saveSession(done)
      this.distillInBackground(done)
    }
    this.session = null
    this.emitEvent({ type: 'session', session: null })
  }

  /**
   * Come in ChatGPT: se c'è una chat caricata si continua quella (messaggio utente
   * in coda), altrimenti se ne apre una nuova.
   */
  async submit(text: string, attachments: Attachment[] = []): Promise<Session> {
    if (this.session && this.session.turns.length > 0 && this.session.state !== 'running') {
      const session = this.session
      const turn: Turn = {
        id: randomUUID(),
        agentId: 'utente',
        name: 'Utente',
        text,
        ts: Date.now(),
        tokensIn: 0,
        tokensOut: 0,
        tools: []
      }
      session.turns.push(turn)
      session.turnIndex = session.turns.length
      session.consensus = undefined
      saveSession(session)
      rememberUserNote(session, text)
      this.emitEvent({ type: 'session', session })
      this.setState('running')
      void this.loop()
      return session
    }
    return this.start(text, attachments)
  }

  private distillInBackground(session: Session): void {
    void (async () => {
      try {
        const persona = getSettings().personas[0]
        const { baseUrl } = await llamaPool.ensure(this.modelFor(persona), this.deviceFor(persona))
        const added = await distillSession(baseUrl, session)
        if (added > 0) this.emitEvent({ type: 'log', message: `memoria: ${added} elementi appresi` })
      } catch (err) {
        this.emitEvent({ type: 'log', message: `memoria non aggiornata: ${(err as Error).message}` })
      }
    })()
  }

  async start(topic: string, attachments: Attachment[] = []): Promise<Session> {
    await this.halt()
    const session = newSession(topic)
    session.attachments = attachments
    session.pendingImages = attachments.flatMap((a) => [
      ...(a.kind === 'image' ? [a.path] : []),
      ...(a.frames ?? [])
    ])
    const context = attachments
      .map((a) => {
        const head = `ALLEGATO: ${a.name} (${a.kind})`
        return a.text ? `${head}\n${a.text.slice(0, 6000)}` : head
      })
      .join('\n\n')
    if (context) session.topic = `${topic}\n\nMateriale fornito dall'utente:\n${context}`
    this.session = session
    saveSession(session)
    this.emitEvent({ type: 'session', session })
    this.setState('running')
    void this.loop()
    return session
  }

  async resume(id: string): Promise<Session> {
    if (this.session?.id === id && this.session.state === 'running') return this.session
    await this.halt()
    const loaded = loadSession(id)
    if (!loaded) throw new Error('sessione non trovata')
    this.session = loaded
    loaded.lastError = undefined
    this.emitEvent({ type: 'session', session: loaded })
    this.setState('running')
    void this.loop()
    return loaded
  }

  /** Interruzione immediata, sessione ripristinabile. */
  async pause(): Promise<void> {
    this.abort?.abort()
    if (this.session && this.session.state === 'running') this.setState('paused')
  }

  async halt(): Promise<void> {
    this.abort?.abort()
    await new Promise((r) => setTimeout(r, 150))
    this.abort = null
  }

  private async loop(): Promise<void> {
    if (this.looping) return
    this.looping = true
    try {
      while (this.session && this.session.state === 'running') {
        const settings = getSettings()
        const personas = settings.personas
        const turnIndex = this.session.turnIndex
        if (turnIndex >= settings.maxTurns) {
          this.emitEvent({ type: 'log', message: `limite di ${settings.maxTurns} turni raggiunto` })
          const finished = this.session
          this.setState('concluded')
          this.distillInBackground(finished)
          break
        }
        const persona = personas[turnIndex % personas.length]
        const { baseUrl } = await llamaPool.ensure(this.modelFor(persona), this.deviceFor(persona))
        this.emitEvent({
          type: 'log',
          message: `${persona.name} usa ${this.modelFor(persona)} su ${this.deviceFor(persona) ?? 'GPU automatica'}`
        })

        // --- prompt compression quando si supera la soglia (75% di default) ---
        let messages = buildMessages(persona, this.session, settings, personas)
        let tokens = await tokenCountOf(baseUrl, messages)
        const limit = Math.floor(settings.contextSize * settings.compressionThreshold)
        if (tokens > limit) {
          this.emitEvent({
            type: 'compression',
            tokens,
            limit,
            message: `contesto al ${Math.round((tokens / settings.contextSize) * 100)}%: comprimo la memoria`
          })
          const memory = await summarize(baseUrl, this.session, this.session.memory)
          this.session.memory = memory
          const keep = Math.max(4, Math.min(10, this.session.turns.length - 6))
          if (this.session.turns.length > keep) {
            this.session.turns = this.session.turns.slice(-keep)
            this.session.turnIndex = this.session.turns.length
          }
          saveSession(this.session)
          messages = buildMessages(persona, this.session, settings, personas)
          tokens = await tokenCountOf(baseUrl, messages)
          this.emitEvent({ type: 'session', session: this.session })
        }

        this.abort = new AbortController()
        const controller = this.abort
        this.emitEvent({ type: 'log', message: `${persona.name} sta scrivendo (turno ${turnIndex + 1})` })

        let text = ''
        let reasoning = ''
        const tools: Turn['tools'] = []
        let images: string[] = this.session.pendingImages ?? []
        this.session.pendingImages = []
        let interrupted = false

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          const result = await chat(baseUrl, {
            messages,
            temperature: settings.temperature,
            maxTokens: settings.maxTokensPerTurn,
            tools: settings.toolsEnabled ? TOOL_SPECS : undefined,
            signal: controller.signal,
            onDelta: (chunk) => this.emitEvent({ type: 'delta', agentId: persona.id, text: chunk }),
            onReasoningDelta: (chunk) => {
              reasoning += chunk
              this.emitEvent({ type: 'reasoning', agentId: persona.id, text: chunk })
            }
          })
          if (result.interrupted) {
            interrupted = true
            text += result.content
            break
          }
          if (!result.toolCalls.length) {
            if (!result.content.trim() && reasoning.trim() && round === 0) {
              // il modello ha speso tutto il budget nel ragionamento: chiedo solo la risposta
              messages.push({
                role: 'user',
                content: 'Ora scrivi solo la risposta finale, senza altro ragionamento.'
              })
              continue
            }
            text += result.content
            break
          }
          messages = [
            ...messages,
            {
              role: 'assistant',
              content: result.content,
              tool_calls: result.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: c.function
              }))
            } as LlmMessage
          ]
          for (const call of result.toolCalls) {
            const args = parseArgs(call.function.arguments)
            let outcome: { text: string; images?: string[] } = { text: 'errore' }
            let ok = true
            try {
              outcome = await runTool(call.function.name, args, (m) =>
                this.emitEvent({ type: 'log', message: m })
              )
            } catch (err) {
              ok = false
              outcome = { text: `errore tool: ${(err as Error).message}` }
            }
            if (outcome.images?.length) images = [...images, ...outcome.images]
            tools.push({ name: call.function.name, args, result: outcome.text, ok })
            this.emitEvent({
              type: 'tool',
              agentId: persona.id,
              name: call.function.name,
              args,
              result: outcome.text
            })
            messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.text })
          }
          messages.push({
            role: 'user',
            content: images.length
              ? [
                  {
                    type: 'text',
                    text: `Risultati dei tool qui sopra. Guarda le immagini allegate e rispondi come ${persona.name}.`
                  },
                  ...images.map((p) => ({
                    type: 'image_url' as const,
                    image_url: { url: `file://${p}` }
                  }))
                ]
              : `Ora rispondi tu come ${persona.name}.`
          })
        }

        const clean = text.replace(CONSENSUS, '').trim()
        const marker = CONSENSUS.exec(text)
        const turn: Turn = {
          id: randomUUID(),
          agentId: persona.id,
          name: persona.name,
          text: clean || (interrupted ? '[interrotto]' : '[nessun contenuto]'),
          reasoning: reasoning.trim() || undefined,
          ts: Date.now(),
          tokensIn: tokens,
          tokensOut: Math.ceil(clean.length / 3.6),
          tools,
          interrupted
        }
        this.session.turns.push(turn)
        this.session.turnIndex = this.session.turns.length
        saveSession(this.session)
        rememberTurn(this.session, turn)
        this.emitEvent({ type: 'turn', turn })
        this.emitEvent({ type: 'session', session: this.session })

        if (interrupted) {
          this.setState('paused')
          this.distillInBackground(this.session)
          break
        }

        if (marker) {
          const proposed = (marker[1] ?? clean).trim()
          const validated = await this.validateConsensus(baseUrl, persona, proposed, controller.signal)
          if (validated.ok) {
            this.session.consensus = {
              answer: validated.answer || proposed,
              proposedBy: persona.name,
              validatedBy: validated.by
            }
            saveSession(this.session)
            this.emitEvent({ type: 'consensus', consensus: this.session.consensus })
            const finished = this.session
            this.setState('concluded')
            this.distillInBackground(finished)
            break
          }
          this.emitEvent({ type: 'log', message: `consenso respinto dal giudice: ${validated.reason}` })
        }
      }
    } catch (err) {
      const message = (err as Error).message
      if (this.session) {
        this.session.lastError = message
        this.setState('error')
      }
      this.emitEvent({ type: 'error', message })
    } finally {
      this.looping = false
      this.abort = null
    }
  }

  /** Il consenso dichiarato da un agente viene verificato da un turno dedicato. */
  private async validateConsensus(
    baseUrl: string,
    proposer: Persona,
    answer: string,
    signal: AbortSignal
  ): Promise<{ ok: boolean; answer?: string; by: string; reason: string }> {
    const settings = getSettings()
    const personas = settings.personas
    const judge = personas.find((p) => p.id !== proposer.id) ?? proposer
    const transcript = (this.session?.turns ?? [])
      .slice(-12)
      .map((t) => `[${t.name}] ${t.text}`)
      .join('\n\n')
      .slice(-9000)
    const res = await chat(baseUrl, {
      messages: [
        {
          role: 'system',
          content:
            'Sei un giudice. Decidi se una proposta di consenso chiude davvero il dibattito. Rispondi SOLO con JSON: {"consenso": true|false, "risposta": "...", "motivo": "..."}. consenso=true solo se la proposta risolve la questione e non lascia disaccordi sostanziali.'
        },
        {
          role: 'user',
          content: `DIBATTITO:\n${transcript}\n\nPROPOSTA DI ${proposer.name}:\n${answer}`
        }
      ],
      temperature: 0,
      maxTokens: 420,
      jsonMode: true,
      signal
    })
    try {
      const json = JSON.parse(res.content.replace(/^[^{]*/, '').replace(/[^}]*$/, ''))
      return {
        ok: Boolean(json.consenso),
        answer: typeof json.risposta === 'string' ? json.risposta : answer,
        by: judge.name,
        reason: String(json.motivo ?? '')
      }
    } catch {
      return { ok: false, by: judge.name, reason: 'risposta del giudice non interpretabile' }
    }
  }
}

export const engine = new DebateEngine()
