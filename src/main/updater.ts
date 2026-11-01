import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import { translate } from '../shared/i18n'
import { getSettings, saveSettings } from './settings'
import { dataDir, runDir } from './paths'
import { log } from './log'
import {
  decideUpdateOutcome,
  type PendingUpdate,
  type UpdateOutcome
} from './update-plan'
import { posixSupervisor, powershellSupervisor } from './update-script'

const REPO = 'blastbeng/triade-ai'
const TIMEOUT_MS = 7000

export interface UpdateInfo {
  version: string
  current: string
  notes: string
  /** asset adatto alla piattaforma corrente */
  assetName: string
  assetUrl: string
  sumsUrl: string
}

function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('.').map((n) => Number(n) || 0)
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/** Interroga GitHub per l'ultima release; timeout breve, errori silenziosi. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  // in sviluppo non si aggiorna niente: il "bersaglio" sarebbe l'eseguibile di
  // Electron, non l'app
  if (!app.isPackaged) return null
  const settings = getSettings()
  if (settings.updates?.enabled === false) return null
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'triade-ai', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      tag_name?: string
      body?: string
      assets?: { name: string; browser_download_url: string }[]
    }
    const tag = (data.tag_name ?? '').replace(/^v/, '')
    const current = app.getVersion()
    if (!tag || !isNewer(tag, current)) return null
    if (settings.updates?.skippedVersion === tag) return null

    const assets = data.assets ?? []
    const want = process.platform === 'win32' ? /-windows-x64-portable\.zip$/i : /-linux-x64-appimage\.tar\.gz$/i
    const asset = assets.find((a) => want.test(a.name))
    if (!asset) return null
    const sums = assets.find((a) => /SHA256SUMS\.txt$/i.test(a.name))
    return {
      version: tag,
      current,
      notes: (data.body ?? '').slice(0, 1200),
      assetName: asset.name,
      assetUrl: asset.browser_download_url,
      sumsUrl: sums?.browser_download_url ?? ''
    }
  } catch {
    // rete lenta o assente: nessun blocco all'avvio
    return null
  }
}

async function download(url: string, dest: string, onPct?: (p: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600000) })
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`)
  const length = Number(res.headers.get('content-length') ?? 0)
  const out = fs.createWriteStream(dest)
  let received = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      received += value.length
      out.write(Buffer.from(value))
      if (length > 0) onPct?.(received / length)
    }
  }
  await new Promise((resolve) => out.end(resolve))
}

async function expectedHash(sumsUrl: string, assetName: string): Promise<string | null> {
  if (!sumsUrl) return null
  try {
    const res = await fetch(sumsUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null
    const text = await res.text()
    const line = text.split('\n').find((l) => l.includes(assetName))
    const hash = line?.trim().split(/\s+/)[0]
    return hash && /^[a-f0-9]{64}$/i.test(hash) ? hash.toLowerCase() : null
  } catch {
    return null
  }
}

function fileHash(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Scarica, verifica e applica l'aggiornamento. Ritorna il percorso del nuovo eseguibile. */
export async function downloadUpdate(info: UpdateInfo, onPct?: (p: number) => void): Promise<string> {
  const target = updateTarget()
  if (transientCopy()) {
    throw new Error(
      'stai eseguendo una copia temporanea di TriadeAI: scarica il pacchetto aggiornato dalla pagina Releases'
    )
  }
  try {
    fs.accessSync(path.dirname(target), fs.constants.W_OK)
  } catch {
    throw new Error(
      `la cartella dell’eseguibile non è scrivibile (${path.dirname(target)}): ` +
        'sposta l’app in una cartella tua, oppure scarica il pacchetto dalla pagina Releases'
    )
  }
  const dir = path.join(dataDir(), 'aggiornamenti')
  fs.mkdirSync(dir, { recursive: true })
  const archive = path.join(dir, info.assetName)
  await download(info.assetUrl, archive, onPct)

  const hash = await expectedHash(info.sumsUrl, info.assetName)
  if (hash && fileHash(archive) !== hash) {
    fs.rmSync(archive, { force: true })
    throw new Error('checksum non corrispondente: download annullato')
  }

  const unpack = path.join(dir, 'nuovo')
  fs.rmSync(unpack, { recursive: true, force: true })
  fs.mkdirSync(unpack, { recursive: true })
  if (info.assetName.endsWith('.tar.gz')) {
    execFileSync('tar', ['-xzf', archive, '-C', unpack])
  } else if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Force -LiteralPath '${archive}' -DestinationPath '${unpack}'`
    ])
  } else {
    execFileSync('unzip', ['-o', '-q', archive, '-d', unpack])
  }

  const entries = fs.readdirSync(unpack)
  const candidate = entries.find((f) =>
    info.assetName.includes('windows')
      ? f.toLowerCase().endsWith('.exe')
      : f.toLowerCase().endsWith('.appimage')
  )
  if (!candidate) throw new Error('archivio aggiornamento senza eseguibile')
  const nuovo = path.join(unpack, candidate)
  const size = fs.statSync(nuovo).size
  if (size < 20 * 1024 * 1024) {
    throw new Error(`l’eseguibile scaricato sembra incompleto (${(size / 1024 ** 2).toFixed(1)} MiB)`)
  }
  if (process.platform !== 'win32') fs.chmodSync(nuovo, 0o755)
  return nuovo
}

/**
 * File eseguibile che va sostituito per aggiornare davvero l'app.
 *
 * Windows: il target "portable" di electron-builder è un launcher che scompatta
 * l'app in %TEMP%\<unpackDirName> e lancia QUELLA copia. `process.execPath`
 * punta quindi al file temporaneo: sostituirlo non aggiorna nulla (la prossima
 * estrazione lo riscrive) e soprattutto la nuova app partirebbe senza
 * PORTABLE_EXECUTABLE_DIR, cioè con una cartella dati diversa da `dati/` — così
 * il marker di avvio non comparirebbe mai e il watchdog farebbe rollback.
 * Il file da sostituire è quello che l'utente avvia: PORTABLE_EXECUTABLE_FILE.
 */
export function updateTarget(): string {
  if (process.platform === 'win32') {
    const portable = process.env.PORTABLE_EXECUTABLE_FILE
    if (portable) return portable
    return process.execPath
  }
  // un collegamento simbolico (es. /usr/local/bin/triade) non va sostituito:
  // si aggiorna il file a cui punta
  const appImage = process.env.APPIMAGE
  if (!appImage) return process.execPath
  try {
    return fs.realpathSync(appImage)
  } catch {
    return appImage
  }
}

/** true se stiamo girando da una copia temporanea (portable non rilevato). */
function transientCopy(): boolean {
  if (process.platform !== 'win32') return false
  if (process.env.PORTABLE_EXECUTABLE_FILE) return false
  return /[\\/]Temp[\\/]/i.test(process.execPath)
}

const updateDir = (): string => path.join(dataDir(), 'aggiornamenti')
const pendingFile = (): string => path.join(updateDir(), 'pending.json')
const esitoFile = (): string => path.join(updateDir(), 'esito.json')

/** Legge un JSON tollerando il BOM che PowerShell 5.1 aggiunge. */
function readJson<T>(file: string): T | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data), 'utf8')
}

/** Segna un aggiornamento in corso: è la base per capire, al riavvio, com'è andata. */
function markPending(version: string, target: string): void {
  // il marker di un tentativo precedente della STESSA versione non è una prova:
  // se restasse, il supervisore dichiarerebbe riuscito un aggiornamento che non
  // è mai partito (e cancellerebbe la copia di riserva)
  try {
    fs.rmSync(bootMarker(version), { force: true })
  } catch {
    /* ignore */
  }
  writeJson(pendingFile(), {
    version,
    target,
    backup: `${target}.old`,
    at: Date.now()
  } satisfies PendingUpdate)
}

/** Toglie i file di stato dell'aggiornamento e la copia di riserva. */
function clearUpdateState(backup?: string): void {
  for (const file of [pendingFile(), esitoFile()]) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* ignore */
    }
  }
  if (!backup) return
  try {
    if (fs.existsSync(backup)) fs.rmSync(backup, { force: true })
  } catch {
    /* in uso: verrà rimosso al prossimo avvio */
  }
}

/** Percorso del marker scritto dall'app all'avvio: prova che la versione è partita. */
export function bootMarker(version: string): string {
  return path.join(runDir(), `boot-${version}.ok`)
}

/**
 * Chiamata come PRIMO passo all'avvio: certifica che questa versione è viva.
 *
 * Deve restare la prima istruzione di `whenReady`: qualunque cosa venga prima
 * (controllo GPU, dialoghi modali, copia dei binari, primo download) può durare
 * minuti e far scattare un rollback che non ha motivo di esistere.
 */
export function markBooted(): void {
  try {
    fs.mkdirSync(runDir(), { recursive: true })
    fs.writeFileSync(bootMarker(app.getVersion()), String(Date.now()), 'utf8')
  } catch {
    /* ignore */
  }
  // se stiamo girando con la versione appena installata, l'aggiornamento è
  // riuscito: lo stato dell'aggiornamento non serve più e la copia di riserva
  // (il vecchio eseguibile) può essere eliminata
  try {
    const data = readJson<PendingUpdate>(pendingFile())
    if (!data?.version || data.version !== app.getVersion()) return
    clearUpdateState(data.backup)
    log.info(`[update] avvio della versione ${data.version} confermato`)
  } catch {
    /* ignore */
  }
}

/**
 * Chiamata all'avvio: dice se l'app è stata riportata indietro dopo un
 * aggiornamento fallito (e, in quel caso, quale versione non è partita).
 *
 * Decide solo su prove concrete, mai su tempi: il verdetto lo scrive il
 * supervisore (`esito.json`) oppure lo dà la versione in esecuzione.
 */
export function recoverFailedUpdate(): { version: string; rolledBack: boolean } | null {
  const pending = readJson<PendingUpdate>(pendingFile())
  if (!pending) return null
  const esito = readJson<UpdateOutcome>(esitoFile())
  const backupExists = Boolean(pending.backup) && fs.existsSync(pending.backup)

  const decision = decideUpdateOutcome({
    pending,
    esito,
    currentVersion: app.getVersion(),
    now: Date.now(),
    backupExists
  })
  if (!decision) {
    // nessun problema: o siamo la versione nuova, o il supervisore sta lavorando
    if (esito?.result === 'ok' || app.getVersion() === pending.version) {
      clearUpdateState(pending.backup)
    }
    return null
  }

  if (decision.restore) {
    const target = pending.target || updateTarget()
    try {
      if (fs.existsSync(target)) fs.rmSync(target, { force: true })
      fs.renameSync(pending.backup, target)
      if (process.platform !== 'win32') fs.chmodSync(target, 0o755)
      log.warn('[update] ripristinata la versione precedente dopo un aggiornamento interrotto')
    } catch (err) {
      log.warn(`[update] ripristino non riuscito: ${(err as Error).message}`)
    }
  }
  clearUpdateState()
  log.warn(`[update] esito ${decision.rolledBack ? 'rolledback' : 'non applicato'} (${decision.version})`)
  return { version: decision.version, rolledBack: decision.rolledBack }
}

export function applyUpdate(newExe: string, version = ''): void {
  if (process.platform === 'win32') {
    if (transientCopy()) {
      throw new Error(
        'stai eseguendo una copia temporanea di TriadeAI (scompattata da Windows): ' +
          'scarica il pacchetto aggiornato dalla pagina Releases'
      )
    }
    const target = updateTarget()
    // il file in uso non si può sostituire: lo fa uno script esterno quando
    // l'app è chiusa (portable = launcher NSIS, che poi riscompatta la nuova app)
    markPending(version, target)
    const helper = path.join(updateDir(), 'aggiorna.ps1')
    fs.mkdirSync(updateDir(), { recursive: true })
    fs.writeFileSync(
      helper,
      `${powershellSupervisor({
        target,
        newExe,
        marker: bootMarker(version),
        version,
        pid: process.pid,
        // il launcher portable: lo script deve aspettare anche lui (vedi sopra)
        parentPid: process.ppid,
        pending: pendingFile(),
        esito: esitoFile(),
        logFile: path.join(updateDir(), 'aggiorna.log')
      })}\r\n`,
      'utf8'
    )
    log.info(`[update] sostituzione di ${target} affidata a ${helper}`)
    spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        helper
      ],
      { detached: true, stdio: 'ignore', windowsHide: true }
    ).unref()
    app.exit(0)
    return
  }
  const current = updateTarget()
  if (!process.env.APPIMAGE && app.isPackaged) {
    // estratta con --appimage-extract o simile: non c'è un file AppImage da sostituire
    throw new Error(
      'stai eseguendo una copia estratta dell’AppImage: scarica il nuovo .AppImage dalla pagina Releases'
    )
  }
  // se la cartella non è scrivibile (AppImage in /opt o /usr/local/bin) il
  // supervisore fallirebbe a metà, dopo aver chiuso l'app: meglio dirlo subito
  const currentDir = path.dirname(current)
  try {
    fs.accessSync(currentDir, fs.constants.W_OK)
  } catch {
    throw new Error(
      `la cartella dell’AppImage (${currentDir}) non è scrivibile: ` +
        'sposta il file in una cartella tua (es. ~/App) e riprova, ' +
        'oppure scarica la nuova versione dalla pagina Releases'
    )
  }
  // si sostituisce IN PLACE (stesso nome): cambialo e i lanciatori/collegamenti
  // dell'utente punterebbero a un file che non esiste più
  markPending(version, current)
  // l'app deve chiudersi prima di toccare il file (ETXTBSY): lo fa un
  // supervisore che resta vivo anche se la nuova versione non dovesse partire
  const helper = path.join(updateDir(), 'aggiorna.sh')
  fs.mkdirSync(updateDir(), { recursive: true })
  fs.writeFileSync(
    helper,
    posixSupervisor({
      target: current,
      newExe,
      marker: bootMarker(version),
      version,
      pid: process.pid,
      pending: pendingFile(),
      esito: esitoFile(),
      logFile: path.join(updateDir(), 'aggiorna.log'),
      // conserva gli argomenti di avvio (es. --no-sandbox dove il sandbox SUID manca)
      args: process.argv.slice(1)
    }),
    { mode: 0o755 }
  )
  log.info(`[update] sostituzione di ${current} affidata a ${helper}`)
  spawn('sh', [helper], { detached: true, stdio: 'ignore' }).unref()
  app.exit(0)
}

/**
 * Finestrella di avanzamento dell'aggiornamento: barra vera, sempre in primo piano.
 * Non serve IPC: la pagina è inline e la percentuale viene iniettata.
 */
export function progressWindow(title: string): { update: (p: number) => void; close: () => void } {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#0b0e14;color:#e6edf3;font:13px system-ui,sans-serif}
  body{display:flex;flex-direction:column;justify-content:center;gap:10px;padding:18px;box-sizing:border-box}
  #t{font-weight:600}#bar{height:8px;background:#1b2230;border-radius:6px;overflow:hidden}
  #fill{height:100%;width:0;background:#5eead4;transition:width .25s ease}
  #p{font-size:11px;color:#8b97a8}
  </style></head><body>
  <div id="t">${title}</div>
  <div id="bar"><div id="fill"></div></div>
  <div id="p">0%</div>
  <script>function setProgress(x){document.getElementById('fill').style.width=(x*100).toFixed(1)+'%';document.getElementById('p').textContent=Math.round(x*100)+'%'}</script>
  </body></html>`
  const win = new BrowserWindow({
    width: 460,
    height: 130,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    frame: true,
    title,
    backgroundColor: '#0b0e14',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  return {
    update: (p: number) => {
      if (win.isDestroyed()) return
      const pct = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0))
      void win.webContents
        .executeJavaScript(`setProgress(${pct})`)
        .catch(() => undefined)
    },
    close: () => {
      if (!win.isDestroyed()) win.destroy()
    }
  }
}

/**
 * Rimuove backup e residui di aggiornamenti falliti (`<exe>.failed`).
 * Il `.old` dell'ultimo aggiornamento resta: serve al rollback manuale.
 */
export function cleanupUpdateLeftovers(maxAgeDays = 1): number {
  let removed = 0
  // archivio estratto e pacchetti scaricati: non devono restare per sempre
  try {
    const dir = path.join(dataDir(), 'aggiornamenti')
    const now = Date.now()
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      try {
        const st = fs.statSync(file)
        const old = now - st.mtimeMs > maxAgeDays * 24 * 60 * 60 * 1000
        const isUnpack = name === 'nuovo'
        const isArchive =
          /\.(zip|tar\.gz|AppImage)$/i.test(name) || /^aggiorna\.(ps1|cmd|sh|log)$/i.test(name)
        if (old && (isUnpack || isArchive)) {
          fs.rmSync(file, { recursive: true, force: true })
          removed++
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const exe = updateTarget()
    const dir = path.dirname(exe)
    const base = path.basename(exe)
    const now = Date.now()
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(base) || !name.endsWith('.failed')) continue
      const file = path.join(dir, name)
      try {
        if (now - fs.statSync(file).mtimeMs > maxAgeDays * 24 * 60 * 60 * 1000) {
          fs.rmSync(file, { force: true })
          removed++
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return removed
}

/** Testo localizzato per il dialogo di aggiornamento. */
export function updateTexts(): {
  title: string
  message: (v: string) => string
  now: string
  later: string
  skip: string
} {
  const locale = getSettings().ui?.language ?? 'en'
  return {
    title: translate(locale, 'update.title'),
    message: (v: string) => translate(locale, 'update.message', { version: v }),
    now: translate(locale, 'update.now'),
    later: translate(locale, 'update.later'),
    skip: translate(locale, 'update.skip')
  }
}

/** Salva la versione che l'utente non vuole più vedere. */
export function skipVersion(version: string): void {
  saveSettings({ updates: { ...(getSettings().updates ?? { enabled: true }), skippedVersion: version } })
}
