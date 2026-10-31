import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Cartella "portabile": dove vive l'exe, non la cartella temporanea in cui
 * electron-builder scompatta il portable.
 */
export function appRoot(): string {
  const portable = process.env.PORTABLE_EXECUTABLE_DIR
  if (portable) return portable
  if (app.isPackaged) return path.dirname(app.getPath('exe'))
  return process.cwd()
}

/** Unica radice dati accanto all'eseguibile: modelli, sessioni, memoria, cache. */
export function dataDir(): string {
  const dir = path.join(appRoot(), 'dati')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function modelsDir(): string {
  const dir = path.join(dataDir(), 'modelli')
  fs.mkdirSync(dir, { recursive: true })
  migrateLegacyModels(dir)
  return dir
}

/** Versioni precedenti salvavano i GGUF in ./models: li spostiamo senza riscaricarli. */
function migrateLegacyModels(target: string): void {
  const legacy = path.join(appRoot(), 'models')
  if (!fs.existsSync(legacy)) return
  try {
    for (const name of fs.readdirSync(legacy)) {
      const from = path.join(legacy, name)
      const to = path.join(target, name)
      if (!fs.statSync(from).isFile() || fs.existsSync(to)) continue
      try {
        fs.renameSync(from, to)
      } catch {
        fs.copyFileSync(from, to)
      }
    }
  } catch {
    /* niente da migrare */
  }
}

export function binDir(): string {
  const platformDir = process.platform === 'win32' ? 'win' : 'linux'
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const root = path.join(appRoot(), 'bin')
  const platform = path.join(root, platformDir)

  // sviluppo: binari scaricati in bin/<piattaforma>/
  if (fs.existsSync(path.join(platform, exe))) return platform
  // build impacchettata: extraResources copia bin/stage in <resources>/bin
  const packaged = path.join(process.resourcesPath ?? '', 'bin')
  if (fs.existsSync(path.join(packaged, exe))) return packaged
  if (fs.existsSync(path.join(root, exe))) return root
  if (fs.existsSync(platform)) return platform
  if (fs.existsSync(root)) return root
  return path.join(app.getAppPath(), 'bin')
}

export function sessionsDir(): string {
  const dir = path.join(dataDir(), 'sessioni')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function memoryDir(): string {
  const dir = path.join(dataDir(), 'memoria')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function cacheDir(): string {
  const dir = path.join(dataDir(), 'cache')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function settingsFile(): string {
  return path.join(dataDir(), 'impostazioni.json')
}

export function findBinary(base: string): string | null {
  const names = process.platform === 'win32' ? [`${base}.exe`, base] : [base]
  for (const name of names) {
    const p = path.join(binDir(), name)
    if (fs.existsSync(p)) return p
  }
  return null
}
