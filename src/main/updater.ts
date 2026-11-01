import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { translate } from '../shared/i18n'
import { getSettings, saveSettings } from './settings'
import { dataDir } from './paths'

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
  if (process.platform !== 'win32') fs.chmodSync(nuovo, 0o755)
  return nuovo
}

/**
 * Applica l'aggiornamento e riavvia l'app.
 * Linux: sostituisce l'AppImage (tiene un .old come riserva) e rilancia.
 * Windows: uno script .cmd attende la chiusura del processo, copia il nuovo exe
 *          al posto del vecchio e lo riavvia.
 */
export function applyUpdate(newExe: string): void {
  if (process.platform === 'win32') {
    const target = process.execPath
    const helper = path.join(path.dirname(newExe), 'aggiorna.cmd')
    const script = [
      '@echo off',
      'ping 127.0.0.1 -n 4 >nul',
      `copy /Y "${newExe}" "${target}" >nul`,
      `start "" "${target}"`,
      'del /Q "%~f0"'
    ].join('\r\n')
    fs.writeFileSync(helper, `${script}\r\n`)
    spawn('cmd.exe', ['/c', helper], { detached: true, stdio: 'ignore' }).unref()
    app.exit(0)
    return
  }
  const current = process.env.APPIMAGE ?? process.execPath
  const backup = `${current}.old`
  try {
    if (fs.existsSync(current)) fs.copyFileSync(current, backup)
    fs.copyFileSync(newExe, current)
    fs.chmodSync(current, 0o755)
  } catch (err) {
    throw new Error(`sostituzione dell'eseguibile fallita: ${(err as Error).message}`)
  }
  app.relaunch({ execPath: current, args: [] })
  app.exit(0)
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
