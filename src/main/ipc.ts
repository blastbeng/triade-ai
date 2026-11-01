import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { getSettings, saveSettings } from './settings'
import { activePersonas } from '../shared/personas'
import type { Backend } from '../shared/types'
import { catalogStatus, installModel, removeModel, statusFor } from './llama/downloader'
import { llamaPool } from './llama/server'
import { engine } from './debate/engine'
import { deleteSession, listSessions, loadSession } from './debate/store'
import { ingest } from './media/attachments'
import { memory } from './memory/store'
import { bestDevice, detectGpus, hasCudaBuild } from './gpu/devices'
import { CATALOG, catalogModel, defaultModelId, listModels } from './models/registry'
import { inspectRepo, searchGgufModels, systemRamMiB } from './hf/hf'
import type { Attachment, DebateEvent, Settings } from '../shared/types'

function broadcast(event: DebateEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('debate:event', event)
}

export function registerIpc(): void {
  engine.on('event', broadcast)

  ipcMain.handle('settings:get', () => getSettings())

  ipcMain.handle('settings:save', async (_e, patch: Partial<Settings>) => {
    const before = getSettings()
    const next = saveSettings(patch)
    const serverAffecting =
      before.contextSize !== next.contextSize ||
      before.gpuLayers !== next.gpuLayers ||
      before.flashAttention !== next.flashAttention ||
      before.kvCacheType !== next.kvCacheType ||
      JSON.stringify(before.models) !== JSON.stringify(next.models) ||
      JSON.stringify(before.gpus) !== JSON.stringify(next.gpus)
    if (serverAffecting && llamaPool.status().some((s) => s.running)) await llamaPool.restartAll()
    return next
  })

  ipcMain.handle('models:catalog', async () => {
    const statuses = await catalogStatus()
    const s = getSettings()
    return listModels().map((m) => {
      const st = statuses.find((x) => x.id === m.id)
      return {
        ...m,
        installed: st ? st.modelReady && st.mmprojReady : false,
        status: st ?? null,
        active: s.models.active === m.id,
        assignedTo: s.personas.filter((p) => (s.models.byPersona[p.id] ?? s.models.active) === m.id).map((p) => p.name)
      }
    })
  })

  ipcMain.handle('models:install', async (_e, id: string) => {
    try {
      const st = await installModel(id, (status) => {
        if (process.env.TRIADE_DEBUG_DOWNLOAD) {
          console.log(
            `[dl] ${status.id} ${status.phase} ${Math.round((status.progress ?? 0) * 100)}%`
          )
        }
        broadcast({ type: 'model', status })
      })
      const s = getSettings()
      if (!s.models.installed.includes(id)) {
        saveSettings({ models: { ...s.models, installed: [...s.models.installed, id], active: s.models.active || id } })
      }
      return st
    } catch (err) {
      broadcast({ type: 'error', message: (err as Error).message })
      throw err
    }
  })

  ipcMain.handle('models:remove', async (_e, id: string) => {
    await removeModel(id)
    const s = getSettings()
    const custom = (s.models.custom ?? []).filter((c) => c.id !== id)
    const byPersona = { ...s.models.byPersona }
    for (const [personaId, modelId] of Object.entries(byPersona)) {
      if (modelId === id) delete byPersona[personaId]
    }
    saveSettings({
      models: {
        ...s.models,
        installed: s.models.installed.filter((x) => x !== id),
        custom,
        byPersona,
        active: s.models.active === id ? defaultModelId() : s.models.active
      }
    })
    return catalogStatus()
  })

  /** Ricerca su HuggingFace: solo repo GGUF, poi verifica fattibilità sul PC dell'utente. */
  ipcMain.handle('hf:search', async (_e, query: string) => {
    const rows = await searchGgufModels(String(query ?? '').trim(), 24)
    return rows.map((r) => ({
      repo: r.modelId ?? r.id ?? '',
      downloads: r.downloads ?? 0,
      tags: (r.tags ?? []).filter((t) => ['gguf', 'image-text-to-text', 'vision'].includes(t))
    }))
  })

  ipcMain.handle('hf:inspect', async (_e, repo: string) => {
    const s = getSettings()
    const { usable } = await detectGpus()
    const device = bestDevice(usable)
    const local = activePersonas(s).filter(
      (p) => (s.backendByPersona?.[p.id] ?? s.backend) === 'llama'
    )
    const distinct = new Set(local.map((p) => s.models.byPersona[p.id] ?? s.models.active)).size
    const verdict = await inspectRepo(repo, {
      device,
      contextSize: s.contextSize,
      concurrentModels: Math.max(1, distinct + 1)
    })
    return {
      ...verdict,
      ramMiB: systemRamMiB(),
      deviceName: device?.name ?? null
    }
  })

  /** Aggiunge un modello scelto dalla ricerca: rivalidato qui, mai fidandosi della UI. */
  ipcMain.handle(
    'models:addCustom',
    async (_e, payload: { repo: string; quant: string }) => {
      const s = getSettings()
      const { usable } = await detectGpus()
      const device = bestDevice(usable)
      const distinct = new Set(
        s.personas.map((p) => s.models.byPersona[p.id] ?? s.models.active)
      ).size
      const verdict = await inspectRepo(payload.repo, {
        device,
        contextSize: s.contextSize,
        concurrentModels: Math.max(1, distinct + 1)
      })
      if (!verdict.ok || !verdict.modelFile) {
        throw new Error(`modello non utilizzabile su questa macchina: ${verdict.reason}`)
      }
      const variant = verdict.variants.find((v) => v.quant === payload.quant) ?? null
      const quant = variant?.quant ?? verdict.quant ?? 'GGUF'
      const file = variant?.file ?? verdict.modelFile
      const id = `${payload.repo}::${quant}`.toLowerCase()
      const entry = {
        id,
        name: verdict.name,
        repo: payload.repo,
        quant,
        modelFile: file,
        mmprojFile: verdict.mmprojFile ?? undefined,
        bytes: (variant?.bytes ?? verdict.downloadBytes) + verdict.mmprojBytes,
        vision: verdict.vision
      }
      const custom = [...(s.models.custom ?? []).filter((c) => c.id !== id), entry]
      const next = saveSettings({ models: { ...s.models, custom } })
      return { settings: next, entry, verdict }
    }
  )

  ipcMain.handle('models:setActive', (_e, id: string) => {
    const s = getSettings()
    return saveSettings({ models: { ...s.models, active: id } })
  })

  ipcMain.handle('models:assign', (_e, payload: { personaId: string; modelId: string }) => {
    const s = getSettings()
    return saveSettings({
      models: { ...s.models, byPersona: { ...s.models.byPersona, [payload.personaId]: payload.modelId } }
    })
  })

  ipcMain.handle('model:status', () => statusFor(getSettings().models.active ?? defaultModelId()))
  ipcMain.handle('model:download', async () => installModel(getSettings().models.active ?? defaultModelId()))

  ipcMain.handle('server:status', () => llamaPool.status())
  ipcMain.handle('server:start', async () => {
    for (const t of llamaPool.requiredTargets()) await llamaPool.ensure(t.modelId, t.deviceKey)
    return llamaPool.status()
  })

  ipcMain.handle('gpu:list', async (_e, force: boolean) => {
    const detected = await detectGpus(Boolean(force))
    const s = getSettings()
    return {
      ...detected,
      cudaBuild: hasCudaBuild(),
      // con una sola GPU utilizzabile la scelta per chat è disattivata
      selectable: detected.usable.length > 1,
      byPersona: s.personas.map((p) => ({
        id: p.id,
        name: p.name,
        deviceKey:
          s.gpus.byPersona[p.id] ?? bestDevice(detected.usable)?.key ?? 'auto'
      }))
    }
  })

  ipcMain.handle('gpu:assign', (_e, payload: { personaId: string; deviceKey: string }) => {
    const s = getSettings()
    return saveSettings({
      gpus: { ...s.gpus, byPersona: { ...s.gpus.byPersona, [payload.personaId]: payload.deviceKey } }
    })
  })
  ipcMain.handle('server:stop', async () => {
    await llamaPool.stopAll()
    return llamaPool.status()
  })

  ipcMain.handle('session:list', () => listSessions())
  ipcMain.handle('session:load', (_e, id: string) => loadSession(id))
  ipcMain.handle('session:current', () => engine.current)
  ipcMain.handle('session:delete', async (_e, id: string) => {
    deleteSession(id)
    memory.removeSession(id)
    // se era la chat aperta, l'engine non deve più tenerla viva
    if (engine.current?.id === id) await engine.reset()
    return { sessions: listSessions(), memory: memory.stats() }
  })

  ipcMain.handle(
    'debate:start',
    async (_e, payload: { topic: string; files: string[]; personaId?: string }) => {
      const attachments: Attachment[] = []
      for (const file of payload.files ?? []) {
        attachments.push(await ingest(file, (m) => broadcast({ type: 'log', message: m })))
      }
      return engine.start(payload.topic, attachments, payload.personaId)
    }
  )
  ipcMain.handle(
    'debate:submit',
    async (_e, payload: { topic: string; files: string[]; personaId?: string }) => {
      const attachments: Attachment[] = []
      for (const file of payload.files ?? []) {
        attachments.push(await ingest(file, (m) => broadcast({ type: 'log', message: m })))
      }
      return engine.submit(payload.topic, attachments, payload.personaId)
    }
  )
  ipcMain.handle('debate:pause', async () => {
    await engine.pause()
    return engine.current
  })
  ipcMain.handle('debate:stop', async () => {
    const session = await engine.stop()
    return session
  })
  ipcMain.handle('debate:resume', (_e, id: string) => engine.resume(id))
  ipcMain.handle('debate:new', async () => {
    await engine.reset()
    return true
  })

  ipcMain.handle('attachments:pick', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = win
      ? await dialog.showOpenDialog(win, {
          title: 'Allega immagini, video, audio o documenti',
          properties: ['openFile', 'multiSelections']
        })
      : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (res.canceled) return []
    const out: Attachment[] = []
    for (const file of res.filePaths) {
      out.push(await ingest(file, (m) => broadcast({ type: 'log', message: m })))
    }
    return out
  })

  ipcMain.handle('attachments:ingest', async (_e, files: string[]) => {
    const out: Attachment[] = []
    for (const file of files ?? []) {
      out.push(await ingest(file, (m) => broadcast({ type: 'log', message: m })))
    }
    return out
  })

  ipcMain.handle('memory:stats', () => memory.stats())
  ipcMain.handle('memory:recent', (_e, limit: number) => memory.recent(limit ?? 40))
  // elenco modelli disponibili su un backend remoto (OpenAI/Anthropic/Ollama)
  ipcMain.handle(
    'remote:models',
    async (_e, payload: { backend: Backend; baseUrl?: string; apiKey?: string }) => {
      const s = getSettings()
      const cfg = payload.backend === 'llama' ? null : s.remote[payload.backend]
      const baseUrl = (payload.baseUrl ?? cfg?.baseUrl ?? '').replace(/\/$/, '')
      const apiKey = payload.apiKey ?? cfg?.apiKey ?? ''
      if (!baseUrl) throw new Error('base URL mancante')
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (payload.backend === 'anthropic') {
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = '2023-06-01'
      } else if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`
      }
      // Ollama: API nativa /api/tags; gli altri: /v1/models
      const url =
        payload.backend === 'ollama'
          ? /\/api$/.test(baseUrl)
            ? `${baseUrl}/tags`
            : `${baseUrl}/api/tags`
          : /\/v1$/.test(baseUrl)
            ? `${baseUrl}/models`
            : `${baseUrl}/v1/models`
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
      const text = await res.text()
      if (!res.ok) {
        // Anthropic non espone /v1/models: si propone l'elenco noto
        if (payload.backend === 'anthropic') {
          return [
            'claude-sonnet-4-5',
            'claude-opus-4-1',
            'claude-3-7-sonnet-latest',
            'claude-3-5-haiku-latest'
          ]
        }
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      }
      let data: { data?: { id: string }[]; models?: { name: string }[] } = {}
      try {
        data = JSON.parse(text) as typeof data
      } catch {
        throw new Error('risposta non JSON dal provider: controlla base URL e chiave')
      }
      const ids = (data.data ?? []).map((m) => m.id)
      const names = (data.models ?? []).map((m) => m.name ?? '')
      const all = [...ids, ...names].filter(Boolean)
      return [...new Set(all)].sort()
    }
  )

  // verifica credenziali/raggiungibilità senza generare testo costoso
  ipcMain.handle(
    'remote:test',
    async (_e, payload: { backend: Backend; baseUrl: string; apiKey: string; model: string }) => {
      const meta = await import('./remote')
      return meta.testBackend(payload)
    }
  )

  ipcMain.handle('models:integrity', async () => {
    const { integrityReport } = await import('./llama/downloader')
    return integrityReport()
  })

  ipcMain.handle('models:repair', async (_e, id: string) => {
    const { repairModel } = await import('./llama/downloader')
    const ok = await repairModel(id, (status) =>
      broadcast({
        type: 'log',
        message: `riparazione ${id}: ${Math.round((status.progress ?? 0) * 100)}% (${status.phase})`
      })
    )
    return ok
  })

  ipcMain.handle('embeddings:probe', async () => {
    const { probeEmbeddings } = await import('./memory/embed-client')
    return probeEmbeddings()
  })

  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('search:web', async (_e, payload: { query: string; max?: number }) => {
    const { webSearchDetailed } = await import('./search')
    return webSearchDetailed(payload.query, payload.max ?? 5)
  })

  ipcMain.handle('memory:search', (_e, query: string) => memory.search(query, 12))
  ipcMain.handle('memory:delete', (_e, ids: string[]) => {
    memory.removeEntries(Array.isArray(ids) ? ids : [String(ids)])
    return { stats: memory.stats(), items: memory.recent(60) }
  })

  ipcMain.handle('memory:clear', () => {
    memory.clear()
    return memory.stats()
  })

  ipcMain.handle('app:info', () => ({
    version: process.env.npm_package_version ?? '0.1.0',
    platform: process.platform,
    cwd: process.cwd(),
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
    catalog: CATALOG.map((m) => ({ id: m.id, name: m.name, vision: m.vision }))
  }))
}

void catalogModel
