import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Attachment, DebateEvent, ModelStatus, ServerStatus, Session, Settings } from '../shared/types'

export interface CatalogEntry {
  id: string
  name: string
  vendor: string
  description: string
  architecture: string
  vision: boolean
  audio: boolean
  bytes: number
  license: string
  recommended?: boolean
  installed: boolean
  active: boolean
  assignedTo: string[]
  status: ModelStatus | null
}

export interface MemoryItem {
  id: string
  text: string
  kind: string
  ts: number
  score?: number
}

export interface MemoryStats {
  entries: number
  byKind: Record<string, number>
  bytes: number
  lastTs: number
}

const api = {
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:save', patch),

  modelsCatalog: (): Promise<CatalogEntry[]> => ipcRenderer.invoke('models:catalog'),
  modelsInstall: (id: string): Promise<ModelStatus> => ipcRenderer.invoke('models:install', id),
  modelsRemove: (id: string): Promise<ModelStatus[]> => ipcRenderer.invoke('models:remove', id),
  hfSearch: (query: string): Promise<{ repo: string; downloads: number; tags: string[] }[]> =>
    ipcRenderer.invoke('hf:search', query),
  hfInspect: (repo: string): Promise<Record<string, unknown>> => ipcRenderer.invoke('hf:inspect', repo),
  modelsAddCustom: (
    repo: string,
    quant: string
  ): Promise<{ settings: Settings; entry: { id: string }; verdict: Record<string, unknown> }> =>
    ipcRenderer.invoke('models:addCustom', { repo, quant }),
  modelsSetActive: (id: string): Promise<Settings> => ipcRenderer.invoke('models:setActive', id),
  modelsAssign: (personaId: string, modelId: string): Promise<Settings> =>
    ipcRenderer.invoke('models:assign', { personaId, modelId }),

  modelStatus: (): Promise<ModelStatus> => ipcRenderer.invoke('model:status'),
  downloadModel: (): Promise<ModelStatus> => ipcRenderer.invoke('model:download'),

  gpuList: (force = false): Promise<{
    usable: { key: string; label: string; backend: string; name: string; vramMiB: number; freeMiB: number }[]
    excluded: { key: string; label: string; backend: string; name: string; vramMiB: number; freeMiB: number }[]
    backends: string[]
    selectable: boolean
    cudaBuild: boolean
    byPersona: { id: string; name: string; deviceKey: string }[]
    error?: string
  }> => ipcRenderer.invoke('gpu:list', force),
  gpuAssign: (personaId: string, deviceKey: string): Promise<Settings> =>
    ipcRenderer.invoke('gpu:assign', { personaId, deviceKey }),

  serverStatus: (): Promise<ServerStatus[]> => ipcRenderer.invoke('server:status'),
  startServer: (): Promise<ServerStatus[]> => ipcRenderer.invoke('server:start'),
  stopServer: (): Promise<ServerStatus[]> => ipcRenderer.invoke('server:stop'),

  listSessions: (): Promise<{ id: string; topic: string; updatedAt: number; state: string; turns: number }[]> =>
    ipcRenderer.invoke('session:list'),
  loadSession: (id: string): Promise<Session | null> => ipcRenderer.invoke('session:load', id),
  currentSession: (): Promise<Session | null> => ipcRenderer.invoke('session:current'),
  deleteSession: (id: string): Promise<{
    sessions: { id: string; topic: string; updatedAt: number; state: string; turns: number }[]
    memory: MemoryStats
  }> => ipcRenderer.invoke('session:delete', id),

  startDebate: (topic: string, files: string[], personaId?: string): Promise<Session> =>
    ipcRenderer.invoke('debate:start', { topic, files, personaId }),
  submit: (topic: string, files: string[], personaId?: string): Promise<Session> =>
    ipcRenderer.invoke('debate:submit', { topic, files, personaId }),
  pauseDebate: (): Promise<Session | null> => ipcRenderer.invoke('debate:pause'),
  resumeDebate: (id: string): Promise<Session> => ipcRenderer.invoke('debate:resume', id),
  newChat: (): Promise<boolean> => ipcRenderer.invoke('debate:new'),

  pickAttachments: (): Promise<Attachment[]> => ipcRenderer.invoke('attachments:pick'),
  ingestFiles: (files: string[]): Promise<Attachment[]> => ipcRenderer.invoke('attachments:ingest', files),

  memoryStats: (): Promise<MemoryStats> => ipcRenderer.invoke('memory:stats'),
  memoryRecent: (limit = 40): Promise<{ id: string; text: string; kind: string; ts: number }[]> =>
    ipcRenderer.invoke('memory:recent', limit),
  memorySearch: (query: string): Promise<{ id: string; text: string; kind: string; ts: number; score: number }[]> =>
    ipcRenderer.invoke('memory:search', query),
  memoryDelete: (ids: string[]): Promise<{ stats: MemoryStats; items: MemoryItem[] }> =>
    ipcRenderer.invoke('memory:delete', ids),
  memoryClear: (): Promise<MemoryStats> => ipcRenderer.invoke('memory:clear'),

  appInfo: (): Promise<{ version: string; platform: string; cwd: string; portable: boolean; catalog: { id: string; name: string; vision: boolean }[] }> =>
    ipcRenderer.invoke('app:info'),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  onEvent: (cb: (event: DebateEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: DebateEvent): void => cb(payload)
    ipcRenderer.on('debate:event', handler)
    return () => ipcRenderer.removeListener('debate:event', handler)
  }
}

contextBridge.exposeInMainWorld('triade', api)

export type TriadeApi = typeof api
