import { BrowserWindow, dialog, ipcMain } from 'electron'
import { getSettings, saveSettings } from './settings'
import { catalogStatus, installModel, removeModel, statusFor } from './llama/downloader'
import { llamaPool } from './llama/server'
import { engine } from './debate/engine'
import { deleteSession, listSessions, loadSession } from './debate/store'
import { ingest } from './media/attachments'
import { memory } from './memory/store'
import { detectGpus, hasCudaBuild } from './gpu/devices'
import { CATALOG, catalogModel, defaultModelId } from './models/registry'
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
    return CATALOG.map((m) => {
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
      const st = await installModel(id, (status) => broadcast({ type: 'model', status }))
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
    saveSettings({
      models: { ...s.models, installed: s.models.installed.filter((x) => x !== id) }
    })
    return catalogStatus()
  })

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
        deviceKey: s.gpus.byPersona[p.id] ?? (detected.usable.length === 1 ? detected.usable[0].key : 'auto')
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
  ipcMain.handle('session:delete', (_e, id: string) => {
    deleteSession(id)
    memory.removeSession(id)
    return listSessions()
  })

  ipcMain.handle('debate:start', async (_e, payload: { topic: string; files: string[] }) => {
    const attachments: Attachment[] = []
    for (const file of payload.files ?? []) {
      attachments.push(await ingest(file, (m) => broadcast({ type: 'log', message: m })))
    }
    return engine.start(payload.topic, attachments)
  })
  ipcMain.handle('debate:submit', async (_e, payload: { topic: string; files: string[] }) => {
    const attachments: Attachment[] = []
    for (const file of payload.files ?? []) {
      attachments.push(await ingest(file, (m) => broadcast({ type: 'log', message: m })))
    }
    return engine.submit(payload.topic, attachments)
  })
  ipcMain.handle('debate:pause', async () => {
    await engine.pause()
    return engine.current
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
  ipcMain.handle('memory:search', (_e, query: string) => memory.search(query, 12))
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
