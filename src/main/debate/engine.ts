import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { chat, type LlmMessage } from '../llama/client'
import { llamaPool } from '../llama/server'
import { getSettings } from '../settings'
import { mediaUrl } from '../paths'
import { defaultModelId } from '../models/registry'
import type { Attachment, DebateEvent, Mention, Persona, Session, Turn } from '../../shared/types'
import { buildMessages, summarize, tokenCountOf } from './context'
import { loadSession, newSession, saveSession } from './store'
import { distillSession, rememberTurn, rememberUserNote } from '../memory/integrate'
import { TOOL_SPECS, runTool } from './tools'
import { HANDOFF, chooseNextSpeaker, parseHandoff } from './schedule'

const CONSENSUS = /\[\[\s*CONSENSO\s*(?::([\s\S]*?))?\s*\]\]/i
/** cessione della parola: [[PASSA A: Nome]] */

const MAX_TOOL_ROUNDS = 2

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Le menzioni @Nome diventano "questa chat chiama quest'altra, per questo motivo". */
function extractMentions(text: string, personas: Persona[], selfId: string): Mention[] {
  const mentions: Mention[] = []
  for (const persona of personas) {
    if (persona.id === selfId) continue
    const pattern = new RegExp(`@\\s*${escapeRegExp(persona.name).replace(/\\ /g, '\\s+')}`, 'i')
    const match = pattern.exec(text)
    if (!match) continue
    const before = text.lastIndexOf('.', match.index)
    const after = text.indexOf('.', match.index + match[0].length)
    const reason = text
      .slice(before + 1, after === -1 ? Math.min(text.length, match.index + 220) : after + 1)
      .trim()
    mentions.push({ targetId: persona.id, targetName: persona.name, reason: reason.slice(0, 260) })
  }
  return mentions
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw || '{}')
    return typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export class DebateEngine extends EventEmitter {
  private session: Session | null = null
  private abort: AbortController | null = null
  private loopPromise: Promise<void> | null = null
  private clampedNoticed = false

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
  /** Chi parla adesso (helper puro, testabile). */
  private pickSpeaker(personas: Persona[]): Persona {
    const chosen = chooseNextSpeaker({
      personas,
      turns: this.session?.turns ?? [],
      nextSpeakerId: this.session?.nextSpeakerId,
      rotationOffset: this.session?.rotationOffset
    })
    if (this.session) this.session.nextSpeakerId = undefined
    return chosen
  }

  /** Imposta chi deve parlare al prossimo turno (select in chat). */
  private setNextSpeaker(personaId?: string): void {
    if (!this.session || !personaId) return
    const personas = getSettings().personas
    const idx = personas.findIndex((p) => p.id === personaId)
    if (idx < 0) return
    const agentTurns = this.session.turns.filter((t) => t.agentId !== 'utente').length
    this.session.rotationOffset = ((idx - agentTurns) % personas.length + personas.length) % personas.length
    saveSession(this.session)
    this.emitEvent({
      type: 'log',
      message: `prossimo turno assegnato a ${personas[idx].name}`
    })
  }

  async submit(text: string, attachments: Attachment[] = [], startWith?: string): Promise<Session> {
    if (this.session && this.session.turns.length > 0 && this.session.state !== 'running') {
      const session = this.session
      const personas = getSettings().personas
      const responder =
        startWith ??
        session.nextSpeakerId ??
        chooseNextSpeaker({
          personas,
          turns: session.turns,
          nextSpeakerId: session.nextSpeakerId,
          rotationOffset: session.rotationOffset
        }).id
      const turn: Turn = {
        id: randomUUID(),
        agentId: 'utente',
        name: 'Utente',
        toPersonaId: responder,
        text,
        ts: Date.now(),
        tokensIn: 0,
        tokensOut: 0,
        tools: []
      }
      session.turns.push(turn)
      session.turnIndex = session.turns.length
      session.consensus = undefined
      if (attachments.length) {
        session.attachments = [...(session.attachments ?? []), ...attachments]
        session.pendingImages = [
          ...(session.pendingImages ?? []),
          ...attachments.flatMap((a) => [
            ...(a.kind === 'image' ? [a.path] : []),
            ...(a.frames ?? [])
          ])
        ]
      }
      saveSession(session)
      rememberUserNote(session, text)
      this.setNextSpeaker(startWith)
      this.emitEvent({ type: 'session', session })
      this.setState('running')
      void this.loop()
      return session
    }
    return this.start(text, attachments, startWith)
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

  async start(topic: string, attachments: Attachment[] = [], startWith?: string): Promise<Session> {
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
    const personasForStart = getSettings().personas
    if (startWith) {
      const idx = personasForStart.findIndex((p) => p.id === startWith)
      if (idx >= 0) session.rotationOffset = idx
    }
    const firstSpeaker =
      startWith ??
      chooseNextSpeaker({
        personas: personasForStart,
        turns: session.turns,
        rotationOffset: session.rotationOffset
      }).id
    session.turns = session.turns.map((t) =>
      t.agentId === 'utente' && !t.toPersonaId ? { ...t, toPersonaId: firstSpeaker } : t
    )
    saveSession(session)
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

  /** Chiude il dibattito: nessun altro turno automatico, memoria distillata. */
  async stop(): Promise<Session | null> {
    if (!this.session) return null
    await this.halt()
    this.setState('stopped')
    this.emitEvent({ type: 'log', message: 'dibattito fermato dall\u2019utente' })
    this.distillInBackground(this.session)
    return this.session
  }

  /** Ferma la generazione e attende che il ciclo in corso esca davvero. */
  async halt(): Promise<void> {
    this.abort?.abort()
    const running = this.loopPromise
    if (running) {
      await Promise.race([running, new Promise((r) => setTimeout(r, 8000))])
    }
    this.abort = null
  }

  private loop(): void {
    if (this.loopPromise) return
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null
      this.abort = null
    })
  }

  private async runLoop(): Promise<void> {
    try {
      while (this.session && this.session.state === 'running') {
        const settings = getSettings()
        const personas = settings.personas
        const agentTurns = this.session.turns.filter((t) => t.agentId !== 'utente').length
        const turnIndex = agentTurns
        if (turnIndex >= settings.maxTurns) {
          this.emitEvent({ type: 'log', message: `limite di ${settings.maxTurns} turni raggiunto` })
          const finished = this.session
          this.setState('concluded')
          this.distillInBackground(finished)
          break
        }
        const persona = this.pickSpeaker(personas)
        const { baseUrl } = await llamaPool.ensure(this.modelFor(persona), this.deviceFor(persona))
        this.emitEvent({
          type: 'log',
          message: `${persona.name} usa ${this.modelFor(persona)} su ${this.deviceFor(persona) ?? 'GPU automatica'}`
        })

        // --- prompt compression quando si supera la soglia (75% di default) ---
        const toolOverhead = settings.toolsEnabled ? 900 : 0
        // se il modello dichiara un massimo più basso, la compressione scatta prima
        const modelIdForTurn = this.modelFor(persona)
        const effectiveCtx = Math.max(2048, llamaPool.effectiveContext(modelIdForTurn))
        if (effectiveCtx < settings.contextSize && !this.clampedNoticed) {
          this.clampedNoticed = true
          this.emitEvent({
            type: 'log',
            message: `${modelIdForTurn}: contesto limitato a ${effectiveCtx} token (massimo del modello)`
          })
        }
        let messages = buildMessages(persona, this.session, settings, personas)
        let tokens = await tokenCountOf(baseUrl, messages, toolOverhead)
        const limit = Math.floor(effectiveCtx * settings.compressionThreshold)
        // margine per la generazione dentro il contesto reale del server
        const hardLimit = effectiveCtx - 512
        if (tokens > limit || tokens > hardLimit) {
          this.emitEvent({
            type: 'compression',
            tokens,
            limit,
            message: `contesto al ${Math.round((tokens / settings.contextSize) * 100)}%: comprimo la memoria`
          })
          const memory = await summarize(baseUrl, this.session, this.session.memory)
          this.session.memory = memory
          // la trascrizione resta intera (disco + UI): al modello va solo la finestra
          this.session.contextFrom = Math.max(0, this.session.turns.length - 4)
          this.session.turnIndex = this.session.turns.length
          saveSession(this.session)
          messages = buildMessages(persona, this.session, settings, personas)
          tokens = await tokenCountOf(baseUrl, messages, toolOverhead)
          // se anche dopo il sommario il prompt è troppo grande, restringo la finestra
          let guard = 0
          while (tokens > hardLimit && guard < 40 && (this.session.contextFrom ?? 0) < this.session.turns.length - 1) {
            this.session.contextFrom = (this.session.contextFrom ?? 0) + 1
            messages = buildMessages(persona, this.session, settings, personas)
            tokens = await tokenCountOf(baseUrl, messages, toolOverhead)
            guard++
          }
          saveSession(this.session)
          this.emitEvent({ type: 'session', session: this.session })
        }

        this.abort = new AbortController()
        const controller = this.abort
        this.emitEvent({ type: 'log', message: `${persona.name} sta scrivendo (turno ${turnIndex + 1})` })

        // stato visibile nella colonna: prefill -> ragionamento -> scrittura -> tool
        let phase: 'prefill' | 'thinking' | 'writing' | 'tool' = 'prefill'
        const setPhase = (next: typeof phase, detail?: string): void => {
          if (phase === next && !detail) return
          phase = next
          this.emitEvent({ type: 'phase', agentId: persona.id, phase: next, detail })
        }
        setPhase('prefill', 'preparazione del prompt')

        let text = ''
        let reasoning = ''
        let handoffTo: string | undefined
        let handoffSeen = false
        const tools: Turn['tools'] = []
        let images: string[] = this.session.pendingImages ?? []
        this.session.pendingImages = []
        let interrupted = false

        let toolRounds = 0
        let cut: 'loop' | 'budget' | 'handoff' | undefined
        // budget per turno: il contesto disponibile fino al 75% (soglia di compressione)
        // nessun tetto per turno: il limite reale è lo spazio di contesto disponibile
        const room = Math.max(128, effectiveCtx - tokens - 384)
        const configured = settings.maxTokensPerTurn > 0 ? settings.maxTokensPerTurn : room
        const turnCap = Math.max(128, Math.min(configured, room))
        if (room < 256) cut = 'budget'
        for (let attempt = 0; attempt < 3; attempt++) {
          const budget = turnCap
          if (attempt > 0) setPhase('prefill', 'nuovo tentativo')
          let result
          try {
            result = await chat(baseUrl, {
              messages,
              temperature: settings.temperature,
              maxTokens: budget,
              tools: settings.toolsEnabled ? TOOL_SPECS : undefined,
              // dal secondo tentativo niente reasoning: serve solo la risposta finale
              noThinking: attempt > 0,
              signal: controller.signal,
              onDelta: (chunk) => this.emitEvent({ type: 'delta', agentId: persona.id, text: chunk }),
              onReasoningDelta: (chunk) => {
                reasoning += chunk
                this.emitEvent({ type: 'reasoning', agentId: persona.id, text: chunk })
              }
            })
          } catch (err) {
            const msg = (err as Error).message
            if (/exceeds the available context size/i.test(msg) && attempt < 2) {
              // il prompt reale è più grande della stima: restringo la finestra e riprovo
              this.session.contextFrom = Math.max(
                0,
                Math.min(this.session.turns.length - 1, (this.session.contextFrom ?? 0) + 2)
              )
              saveSession(this.session)
              messages = buildMessages(persona, this.session, settings, personas)
              tokens = await tokenCountOf(baseUrl, messages, toolOverhead)
              this.emitEvent({
                type: 'log',
                message: `contesto pieno: restringo la finestra (contextFrom ${this.session.contextFrom})`
              })
              continue
            }
            throw err
          }
          if (result.interrupted) {
            text += result.content
            if (!handoffSeen) interrupted = true
            break
          }
          if (result.stopReason === 'loop') {
            cut = 'loop'
            text += result.content
            break
          }

          // se la generazione si è chiusa a metà, gli argomenti possono essere JSON rotto:
          // in quel caso non li rimandiamo al server (lo farebbe fallire), chiediamo la risposta
          const callsWithArgs = result.toolCalls.map((c) => ({ call: c, args: parseArgs(c.function.arguments) }))
          const validCalls = callsWithArgs.filter(
            (c): c is { call: (typeof result.toolCalls)[number]; args: Record<string, unknown> } => c.args !== null
          )
          if (result.toolCalls.length && validCalls.length < result.toolCalls.length) {
            this.emitEvent({
              type: 'log',
              message: 'tool call troncato dal limite di token: ignorato, chiedo la risposta'
            })
            messages.push({
              role: 'user',
              content:
                'La tua chiamata al tool era incompleta (JSON rotto). Rispondi ora usando solo ciò che sai, senza tool.'
            })
            continue
          }

          if (validCalls.length && toolRounds < MAX_TOOL_ROUNDS) {
            toolRounds++
            messages = [
              ...messages,
              {
                role: 'assistant',
                content: result.content,
                tool_calls: validCalls.map((c) => ({
                  id: c.call.id,
                  type: 'function' as const,
                  function: c.call.function
                }))
              } as LlmMessage
            ]
            for (const { call, args } of validCalls) {
              setPhase('tool', call.function.name)
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
                      image_url: { url: mediaUrl(p) }
                    }))
                  ]
                : `Ora rispondi tu come ${persona.name}.`
            })
            continue
          }

          if (!result.content.trim()) {
            // il modello ha consumato il budget nel ragionamento: chiedo solo la risposta
            if (attempt < 2) {
              messages.push({
                role: 'user',
                content:
                  'Scrivi ora la risposta finale in italiano: 3-6 frasi, contenuto concreto, nessun altro ragionamento.'
              })
              continue
            }
            // nessuna risposta dopo i retry: meglio dichiararlo che mostrare il ragionamento
            text += '[il modello ha esaurito i token nel ragionamento senza produrre una risposta]'
            break
          }

          text += result.content
          break
        }

        this.emitEvent({ type: 'phase', agentId: persona.id, phase: 'idle' })

        const target = parseHandoff(text, personas, persona.id)
        if (target) {
          handoffTo = target.id
          this.session.nextSpeakerId = target.id
          cut = 'handoff'
          this.emitEvent({ type: 'log', message: `${persona.name} passa la parola a ${target.name}` })
        }

        const clean = text
          .replace(CONSENSUS, '')
          .replace(HANDOFF, '')
          .trim()
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
          interrupted,
          cut,
          handoffTo,
          mentions: extractMentions(clean, personas, persona.id)
        }
        this.session.turns.push(turn)
        this.session.turnIndex = this.session.turns.length
        if (!handoffTo && turn.mentions?.length) {
          // chi è stato chiamato per nome parla al turno successivo
          const target = turn.mentions.find((m) => m.targetId !== persona.id)
          if (target) this.session.nextSpeakerId = target.targetId
        }
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
      maxTokens: 500,
      jsonMode: true,
      noThinking: true,
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
