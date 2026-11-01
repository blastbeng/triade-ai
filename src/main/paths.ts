import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Cartella "portabile": dove vive l'exe, non la cartella temporanea in cui
 * electron-builder scompatta il portable.
 */
export function appRoot(): string {
  // Windows portable: la cartella reale dell'exe, non quella di scompattazione
  const portable = process.env.PORTABLE_EXECUTABLE_DIR
  if (portable) return portable
  // variante usata da alcune versioni di electron-builder portable
  const portableFile = process.env.PORTABLE_EXECUTABLE_FILE
  if (portableFile) return path.dirname(portableFile)
  // AppImage: l'exe gira da un mount temporaneo, i dati stanno accanto al file .AppImage
  const appImage = process.env.APPIMAGE
  if (appImage) return path.dirname(appImage)
  // AppImage lanciata con --appimage-extract-and-run (o runtime senza FUSE):
  // ricostruiamo il percorso del file .AppImage dal comando di avvio
  if (process.platform === 'linux') {
    try {
      const argv0 = fs.readFileSync('/proc/self/cmdline', 'utf8').split('\0')[0]
      const original = process.env.OWD ? path.resolve(process.env.OWD, argv0) : path.resolve(argv0)
      if (/\.AppImage$/i.test(original) && fs.existsSync(original)) {
        return path.dirname(original)
      }
    } catch {
      // nessun cmdline leggibile
    }
  }
  if (app.isPackaged) {
    const dir = path.dirname(app.getPath('exe'))
    // directory temporanea di scompattazione: non è una sede valida per i dati
    if (/[\\/](appimage_extracted_|\.mount_|temp[\\/]|AppData[\\/]Local[\\/]Temp)/i.test(dir) && !process.env.PORTABLE_EXECUTABLE_DIR) {
      const fallback = path.join(app.getPath('userData'), 'dati-app')
      fs.mkdirSync(fallback, { recursive: true })
      return fallback
    }
    // installazione in /usr/bin o Program Files: meglio la cartella utente
    try {
      fs.accessSync(dir, fs.constants.W_OK)
      return dir
    } catch {
      const fallback = path.join(app.getPath('userData'), 'dati-app')
      fs.mkdirSync(fallback, { recursive: true })
      return fallback
    }
  }
  return process.cwd()
}

/** Unica radice dati accanto all'eseguibile: modelli, sessioni, memoria, cache. */
export function dataDir(): string {
  const dir = path.join(appRoot(), 'dati')
  fs.mkdirSync(dir, { recursive: true })
  if (!loggedDataDir) {
    loggedDataDir = true
    console.log(`[paths] cartella dati: ${dir}`)
  }
  return dir
}

let loggedDataDir = false

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

export function runDir(): string {
  const dir = path.join(dataDir(), 'run')
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

/**
 * URL per il multimodale di llama-server: con --media-path i file vanno indicati
 * in modo relativo alla cartella media (un path assoluto verrebbe concatenato).
 */
export function mediaUrl(file: string): string {
  const rel = path.relative(cacheDir(), file).split(path.sep).join('/')
  return `file://${rel}`
}

export function findBinary(base: string): string | null {
  const names = process.platform === 'win32' ? [`${base}.exe`, base] : [base]
  for (const name of names) {
    const p = path.join(binDir(), name)
    if (fs.existsSync(p)) return p
  }
  return null
}
