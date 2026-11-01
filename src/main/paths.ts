import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { log } from './log'

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
    log.info(`[paths] cartella dati: ${dir}`)
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

/** Cartella binari inclusa nel pacchetto (dentro l'app, non modificabile). */
function packagedBinDir(): string {
  const platformDir = process.platform === 'win32' ? 'win' : 'linux'
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const root = path.join(appRoot(), 'bin')
  const platform = path.join(root, platformDir)
  if (fs.existsSync(path.join(platform, exe))) return platform
  const packaged = path.join(process.resourcesPath ?? '', 'bin')
  if (fs.existsSync(path.join(packaged, exe))) return packaged
  if (fs.existsSync(path.join(root, exe))) return root
  if (fs.existsSync(platform)) return platform
  if (fs.existsSync(root)) return root
  return path.join(app.getAppPath(), 'bin')
}

function copyTree(from: string, to: string): void {
  const walk = (dir: string, out: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, e.name)
      const dst = path.join(out, e.name)
      if (e.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true })
        walk(src, dst)
      } else {
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(src, dst)
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(dst, 0o755)
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  walk(from, to)
}

/**
 * Tutto ciò che serve deve stare in `dati/bin`: i binari inclusi nel pacchetto
 * vengono copiati lì al primo avvio (con le loro sottocartelle, es. `whisper/`),
 * così il runtime non dipende mai dalla cartella temporanea di scompattazione.
 */
export function ensureBinaries(): string {
  const target = path.join(dataDir(), 'bin')
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const source = packagedBinDir()
  const stampFile = path.join(target, '.stamp')

  // identità dei binari inclusi nel pacchetto: se cambia, si ricopia.
  // `dati/` sopravvive agli aggiornamenti, quindi senza questo controllo una
  // release con un llama.cpp nuovo continuerebbe a usare i binari vecchi.
  let stamp = ''
  try {
    const st = fs.statSync(path.join(source, exe))
    stamp = `${st.size}-${Math.round(st.mtimeMs)}`
  } catch {
    stamp = ''
  }

  const present = fs.existsSync(path.join(target, exe))
  let current = ''
  try {
    current = fs.readFileSync(stampFile, 'utf8').trim()
  } catch {
    current = ''
  }

  if (present && (!stamp || current === stamp)) return target
  if (!fs.existsSync(source)) return target

  try {
    fs.mkdirSync(target, { recursive: true })
    copyTree(source, target)
    if (stamp) fs.writeFileSync(stampFile, stamp, 'utf8')
    log.info(`[paths] binari ${present ? 'aggiornati' : 'copiati'} in ${target}`)
  } catch (err) {
    log.error(`[paths] copia binari fallita: ${(err as Error).message}`)
  }
  return target
}

export function binDir(): string {
  // 1) `dati/bin` (tutto dentro la cartella dati, come da requisito)
  const own = path.join(dataDir(), 'bin')
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  if (fs.existsSync(path.join(own, exeName))) return own
  // 2) binari inclusi nel pacchetto (prima della prima copia)
  return packagedBinDir()
}

function legacyBinDir(): string {
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

/** Porta TCP libera scelta dal sistema (mai porte occupate). */
export async function freePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export function findBinary(base: string): string | null {
  const names = process.platform === 'win32' ? [`${base}.exe`, base] : [base]
  for (const name of names) {
    const p = path.join(binDir(), name)
    if (fs.existsSync(p)) return p
  }
  return null
}
