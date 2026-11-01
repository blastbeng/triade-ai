import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import { translate } from '../shared/i18n'
import { getSettings, saveSettings } from './settings'
import { dataDir, runDir } from './paths'

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
  const target = process.env.APPIMAGE ?? process.execPath
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
 * Applica l'aggiornamento e riavvia l'app.
 * Linux: sostituisce l'AppImage (tiene un .old come riserva) e rilancia.
 * Windows: uno script .cmd attende la chiusura del processo, copia il nuovo exe
 *          al posto del vecchio e lo riavvia.
 */
const pendingFile = (): string => path.join(dataDir(), 'aggiornamenti', 'pending.json')

/** Segna un aggiornamento in corso: se al riavvio la versione non è quella nuova, si torna indietro. */
function markPending(version: string, backup: string, target = '', finalPath = ''): void {
  fs.mkdirSync(path.dirname(pendingFile()), { recursive: true })
  fs.writeFileSync(
    pendingFile(),
    JSON.stringify({ version, backup, target, finalPath, at: Date.now() }),
    'utf8'
  )
}

/** Percorso del marker scritto dall'app all'avvio: prova che la nuova versione è partita. */
export function bootMarker(version: string): string {
  return path.join(runDir(), `boot-${version}.ok`)
}

/** Chiamata all'avvio: certifica che questa versione è viva. */
export function markBooted(): void {
  try {
    fs.mkdirSync(runDir(), { recursive: true })
    fs.writeFileSync(bootMarker(app.getVersion()), String(Date.now()), 'utf8')
  } catch {
    /* ignore */
  }
}

/**
 * Chiamata all'avvio: se esiste un aggiornamento segnato e stiamo girando con la
 * versione vecchia, significa che il nuovo eseguibile non è partito → ripristino.
 */
export function recoverFailedUpdate(): string | null {
  const file = pendingFile()
  if (!fs.existsSync(file)) return null
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string; backup: string }
    if (app.getVersion() === data.version) {
      fs.rmSync(file, { force: true })
      return null
    }
    const target = process.env.APPIMAGE ?? process.execPath
    // se il nuovo file ha un nome diverso, va rimosso prima di ripristinare
    const finalPath = (data as { finalPath?: string }).finalPath
    if (finalPath && finalPath !== target && fs.existsSync(finalPath)) {
      try {
        fs.rmSync(finalPath, { force: true })
      } catch {
        /* ignore */
      }
    }
    if (data.backup && fs.existsSync(data.backup)) {
      fs.copyFileSync(data.backup, target)
      if (process.platform !== 'win32') fs.chmodSync(target, 0o755)
    }
    fs.rmSync(file, { force: true })
    return data.version
  } catch {
    fs.rmSync(file, { force: true })
    return null
  }
}

export function applyUpdate(newExe: string, version = ''): void {
  if (process.platform === 'win32') {
    const target = process.execPath
    markPending(version, `${target}.old`)
    const helper = path.join(path.dirname(newExe), 'aggiorna.cmd')
    // Su Windows rinominare un eseguibile IN USO è permesso, copiarlo no:
    // per questo si usa move (rename atomico) con retry, non copy.
    const finalPath = path.join(path.dirname(target), path.basename(newExe))
    const marker = bootMarker(version)
    const script = [
      '@echo off',
      'setlocal',
      `set LOG=%~dp0aggiorna.log`,
      `echo [%DATE% %TIME%] sostituzione verso ${path.basename(newExe)} >> "%LOG%" 2>&1`,
      'ping 127.0.0.1 -n 4 >nul',
      `move /Y "${target}" "${target}.old" >> "%LOG%" 2>&1`,
      'for /L %%i in (1,1,15) do (',
      `  move /Y "${newExe}" "${finalPath}" >> "%LOG%" 2>&1`,
      `  if exist "${finalPath}" goto started`,
      '  ping 127.0.0.1 -n 2 >nul',
      ')',
      ':started',
      `if not exist "${finalPath}" move /Y "${target}.old" "${target}" >> "%LOG%" 2>&1`,
      `if not exist "${finalPath}" goto done`,
      `start "" "${finalPath}"`,
      `echo [%DATE% %TIME%] avviata ${path.basename(newExe)}, attendo il marker >> "%LOG%" 2>&1`,
      'ping 127.0.0.1 -n 21 >nul',
      `if exist "${marker}" goto ok`,
      `echo [%DATE% %TIME%] marker assente: rollback >> "%LOG%" 2>&1`,
      `move /Y "${finalPath}" "${finalPath}.failed" >> "%LOG%" 2>&1`,
      `move /Y "${target}.old" "${target}" >> "%LOG%" 2>&1`,
      `start "" "${target}"`,
      'goto done',
      ':ok',
      `echo [%DATE% %TIME%] aggiornamento completato >> "%LOG%" 2>&1`,
      `del /Q "${target}.old" >nul 2>&1`,
      ':done',
      'del /Q "%~f0"'
    ].join('\r\n')
    fs.writeFileSync(helper, `${script}\r\n`)
    spawn('cmd.exe', ['/c', `"${helper}"`], { detached: true, stdio: 'ignore' }).unref()
    app.exit(0)
    return
  }
  const current = process.env.APPIMAGE ?? process.execPath
  if (!process.env.APPIMAGE && app.isPackaged) {
    // estratta con --appimage-extract o simile: non c'è un file AppImage da sostituire
    throw new Error(
      'stai eseguendo una copia estratta dell’AppImage: scarica il nuovo .AppImage dalla pagina Releases'
    )
  }
  const backup = `${current}.old`
  const finalPath = path.join(path.dirname(current), path.basename(newExe))
  markPending(version, backup, current, finalPath)
  try {
    // copiare sopra un eseguibile in esecuzione dà ETXTBSY: si sposta il vecchio
    // e si mette il nuovo al suo posto (rename atomico, stesso filesystem).
    fs.rmSync(backup, { force: true })
    if (fs.existsSync(current)) fs.renameSync(current, backup)
    try {
      fs.renameSync(newExe, finalPath)
    } catch {
      fs.copyFileSync(newExe, finalPath)
      fs.rmSync(newExe, { force: true })
    }
    fs.chmodSync(finalPath, 0o755)
  } catch (err) {
    // ripristino immediato se qualcosa è andato storto a metà
    try {
      if (!fs.existsSync(finalPath) && fs.existsSync(backup)) fs.renameSync(backup, current)
    } catch {
      /* ignore */
    }
    throw new Error(`sostituzione dell'eseguibile fallita: ${(err as Error).message}`)
  }
  // conserva gli argomenti di avvio (es. --no-sandbox dove il sandbox SUID manca)
  app.relaunch({ execPath: finalPath, args: process.argv.slice(1) })
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
        const isArchive = /\.(zip|tar\.gz|AppImage)$/i.test(name)
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
    const exe = process.env.APPIMAGE ?? process.execPath
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
