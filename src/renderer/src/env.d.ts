/// <reference types="vite/client" />

import type { Attachment, DebateEvent, ModelStatus, ServerStatus, Session, Settings } from '../../shared/types'

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

export interface MemoryStats {
  entries: number
  byKind: Record<string, number>
  bytes: number
  lastTs: number
}

export interface MemoryItem {
  id: string
  text: string
  kind: string
  ts: number
  score?: number
}

interface Api {
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  modelsCatalog(): Promise<CatalogEntry[]>
  modelsInstall(id: string): Promise<ModelStatus>
  modelsRemove(id: string): Promise<ModelStatus[]>
  hfSearch(query: string): Promise<{ repo: string; downloads: number; tags: string[] }[]>
  hfInspect(repo: string): Promise<{
    repo: string
    name: string
    paramsB: number
    vision: boolean
    quant: string | null
    modelFile: string | null
    mmprojFile: string | null
    downloadBytes: number
    totalMiB: number
    availableMiB: number
    ramMiB: number
    deviceName: string | null
    ok: boolean
    reason: string
    moe: boolean
    mode: 'full' | 'partial' | 'none'
    arch: string
    ramNeededMiB: number
    contextSuggestion: number
    variants: {
      quant: string
      file: string
      bytes: number
      totalMiB: number
      fits: boolean
      fitsPartial: boolean
      ctxFull: number
      ctxPartial: number
    }[]
  }>
  modelsAddCustom(
    repo: string,
    quant: string
  ): Promise<{ settings: Settings; entry: { id: string }; verdict: unknown }>
  modelsSetActive(id: string): Promise<Settings>
  modelsAssign(personaId: string, modelId: string): Promise<Settings>
  modelStatus(): Promise<ModelStatus>
  downloadModel(): Promise<ModelStatus>
  gpuList(force?: boolean): Promise<{
    usable: { key: string; label: string; backend: string; name: string; vramMiB: number; freeMiB: number }[]
    excluded: { key: string; label: string; backend: string; name: string; vramMiB: number; freeMiB: number }[]
    backends: string[]
    selectable: boolean
    cudaBuild: boolean
    byPersona: { id: string; name: string; deviceKey: string }[]
    error?: string
  }>
  gpuAssign(personaId: string, deviceKey: string): Promise<Settings>
  serverStatus(): Promise<ServerStatus[]>
  startServer(): Promise<ServerStatus[]>
  stopServer(): Promise<ServerStatus[]>
  listSessions(): Promise<{ id: string; topic: string; updatedAt: number; state: string; turns: number }[]>
  loadSession(id: string): Promise<Session | null>
  currentSession(): Promise<Session | null>
  deleteSession(id: string): Promise<{
    sessions: { id: string; topic: string; updatedAt: number; state: string; turns: number }[]
    memory: MemoryStats
  }>
  startDebate(topic: string, files: string[], personaId?: string): Promise<Session>
  submit(topic: string, files: string[], personaId?: string): Promise<Session>
  pauseDebate(): Promise<Session | null>
  stopDebate(): Promise<Session | null>
  resumeDebate(id: string): Promise<Session>
  newChat(): Promise<boolean>
  pickAttachments(): Promise<Attachment[]>
  ingestFiles(files: string[]): Promise<Attachment[]>
  memoryStats(): Promise<MemoryStats>
  memoryRecent(limit?: number): Promise<MemoryItem[]>
  memorySearch(query: string): Promise<MemoryItem[]>
  memoryDelete(ids: string[]): Promise<{ stats: MemoryStats; items: MemoryItem[] }>
  memoryClear(): Promise<MemoryStats>
  appInfo(): Promise<{ version: string; platform: string; cwd: string; portable: boolean; catalog: { id: string; name: string; vision: boolean }[] }>
  pathForFile(file: File): string
  onEvent(cb: (event: DebateEvent) => void): () => void
}

declare global {
  interface Window {
    triade: Api
  }
}

export {}
