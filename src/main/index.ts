import { app, BrowserWindow, dialog, shell } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc'
import { llamaPool } from './llama/server'
import { detectGpus } from './gpu/devices'
import { engine } from './debate/engine'
import { translate } from '../shared/i18n'
import { getSettings } from './settings'
import { onShutdown, shutdownAll } from './lifecycle'
import { stopEmbedServer } from './memory/embed-client'
import { log } from './log'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    title: `TriadeAI v${app.getVersion()}`,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (process.env.TRIADE_SMOKE) {
    log.info(`[smoke] finestra creata (livello ${process.env.TRIADE_SMOKE})`)
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) =>
      log.error(`[smoke] did-fail-load ${code} ${desc}`)
    )
    mainWindow.webContents.on('render-process-gone', (_e, details) =>
      log.error(`[smoke] render-process-gone ${details.reason}`)
    )
    mainWindow.webContents.on('console-message', (_e, _lvl, message) =>
      log.info(`[smoke][renderer] ${message}`)
    )
  }
  // nessun onboarding sotto il dialogo: la finestra appare solo a fine aggiornamento
  mainWindow.on('ready-to-show', () => {
    void (async () => {
      const exiting = await maybeUpdate()
      if (!exiting) liveWindow()?.show()
    })()
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Hook per catturare uno screenshot dell'interfaccia in headless: TRIADE_SHOT=1
  if (process.env.TRIADE_SHOT) {
    mainWindow.webContents.once('did-finish-load', () => {
      void (async () => {
        const js = (code: string): Promise<unknown> => mainWindow!.webContents.executeJavaScript(code)
        try {
          if (process.env.TRIADE_SHOT_TEST === 'install') {
            const id = process.env.TRIADE_SHOT_ID ?? ''
            log.info(`[shot] install ${id}`)
            const res = await js(`window.triade.modelsInstall(${JSON.stringify(id)})`)
            log.info(`[shot] install completato: ${JSON.stringify(res).slice(0, 200)}`)
          }

          if (process.env.TRIADE_SHOT_TEST === 'onboarding') {
            const click = (label: string): Promise<unknown> =>
              js(`(() => {
                 const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().includes(${JSON.stringify(label)}));
                 if (b) { b.click(); return true } return false
               })()`)
            const state = (): Promise<unknown> =>
              js(`(() => {
                 const primary = document.querySelector('.modalfooter .primary');
                 return {
                   modal: Boolean(document.querySelector('.modal')),
                   label: primary ? primary.textContent.trim() : null,
                   disabled: primary ? Boolean(primary.disabled) : null,
                   step: document.querySelector('.modalbox.onboarding h2')?.textContent ?? null
                 }
               })()`)
            // attende che il modale sia montato
            for (let i = 0; i < 40; i++) {
              const st = (await state()) as { modal: boolean }
              if (st.modal) break
              await new Promise((r) => setTimeout(r, 250))
            }
            log.info('[ob] lingua:', JSON.stringify(await state()))
            log.info('[ob] continua:', await click('continua'))
            await new Promise((r) => setTimeout(r, 900))
            log.info('[ob] passo backend:', JSON.stringify(await state()))
            const back1 = await click('indietro')
            await new Promise((r) => setTimeout(r, 900))
            log.info('[ob] indietro dal backend:', back1, JSON.stringify(await state()))
            log.info('[ob] riavanti:', await click('continua'))
            await new Promise((r) => setTimeout(r, 900))
            log.info('[ob] di nuovo backend:', JSON.stringify(await state()))
            log.info('[ob] vai ai modelli:', await click('continua'))
            await new Promise((r) => setTimeout(r, 1500))
            log.info('[ob] passo personalità:', JSON.stringify(await state()))
            const picked = (await js(`(() => {
              const btns = [...document.querySelectorAll('.personacount .langbutton')];
              const before = btns.map((b) => b.className.includes('selected'));
              const two = btns[1];
              if (two) two.click();
              return { count: btns.length, before, labels: btns.map((b) => b.textContent.trim()) };
            })()`)) as { count: number; before: boolean[]; labels: string[] }
            await new Promise((r) => setTimeout(r, 500))
            const afterPick = (await js(`(() => {
              const btns = [...document.querySelectorAll('.personacount .langbutton')];
              return btns.map((b) => b.className.includes('selected'));
            })()`)) as boolean[]
            log.info('[ob] default preselezionato:', JSON.stringify(picked.before), '| dopo clic su 2:', JSON.stringify(afterPick))
            log.info('[ob] vai ai modelli:', await click('continua'))
            await new Promise((r) => setTimeout(r, 1500))
            log.info('[ob] passo modelli:', JSON.stringify(await state()))
            const done = await click('concludi')
            await new Promise((r) => setTimeout(r, 1500))
            const after = await state()
            const settings = await js('window.triade.getSettings()')
            log.info('[ob] clic concludi:', done, '→', JSON.stringify(after))
            log.info('[ob] onboardingDone:', (settings as { onboardingDone?: boolean }).onboardingDone)
          }

          if (process.env.TRIADE_SHOT_TEST === 'search') {
            const out = await js(
              `window.triade.searchWeb(${JSON.stringify(process.env.TRIADE_SHOT_QUERY ?? 'vulkan amd rx 7600 xt')}, 4)`
            )
            const r = out as { engine: string; hits: { title: string; url: string }[] }
            log.info(`[shot] search engine=${r.engine} hits=${r.hits.length}`)
            for (const h of r.hits.slice(0, 3)) log.info(`[shot]   - ${h.title} (${h.url})`)
          }
          if (process.env.TRIADE_SHOT_TAB) {
            await js(
              "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'impostazioni'); if (b) b.click(); return true })()"
            )
            await new Promise((r) => setTimeout(r, 1500))
            const clicked = await js(
              `(() => {
                 const tabs = [...document.querySelectorAll('button.tab')];
                 const target = tabs.find((x) => x.textContent.trim() === ${JSON.stringify(process.env.TRIADE_SHOT_TAB)});
                 if (target) target.click();
                 return tabs.map((t) => t.textContent.trim()).join(',') + ' -> ' + (target ? 'cliccata' : 'non trovata');
               })()`
            )
            log.info(`[shot] tab: ${String(clicked)}`)
          } else {
            await js(
              `window.triade.startDebate('Screenshot: come progettiamo un agente locale che usa la GPU AMD per la ricerca?', [], ${JSON.stringify(process.env.TRIADE_SHOT_PERSONA ?? '')})`
            )
          }
          if (process.env.TRIADE_SHOT_NEXT) {
            // verifica del flusso "continua": seconda domanda indirizzata a un'altra personalità
            await new Promise((r) => setTimeout(r, 4000))
            await js(
              `window.triade.submit(${JSON.stringify(process.env.TRIADE_SHOT_NEXT)}, [], ${JSON.stringify(process.env.TRIADE_SHOT_NEXT_PERSONA ?? '')})`
            )
            const owners = await js(
              `(async () => {
                 const cur = await window.triade.currentSession();
                 return (cur?.turns ?? []).filter((x) => x.agentId === 'utente').map((x) => x.toPersonaId + ':' + x.text.slice(0, 16)).join(' | ');
               })()`
            )
            log.info(`[shot] turni utente -> ${String(owners)}`)
          }
          await new Promise((r) => setTimeout(r, Number(process.env.TRIADE_SHOT_DELAY ?? 30000)))
          if (process.env.TRIADE_SHOT_SCROLL === 'top') {
            await js(
              "(() => { document.querySelectorAll('.messages').forEach((m) => { m.scrollTop = 0 }); return true })()"
            )
            await new Promise((r) => setTimeout(r, 400))
          }
          const image = await mainWindow!.webContents.capturePage()
          const fs = await import('node:fs')
          const path = await import('node:path')
          const { dataDir } = await import('./paths')
          const file = path.join(dataDir(), 'screenshot.png')
          fs.writeFileSync(file, image.toPNG())
          log.info(`[shot] salvato ${file} (${fs.statSync(file).size} byte)`)
        } catch (err) {
          log.error('[shot] fallito:', (err as Error).message)
        }
        await engine.pause()
        await llamaPool.stopAll()
  try {
    const { stopEmbedServer } = await import('./memory/embed-client')
    stopEmbedServer()
  } catch {
    /* ignore */
  }
        app.exit(0)
      })()
    })
  }

  // Hook di verifica end-to-end (CI/headless): TRIADE_SMOKE=1 npx electron .
  if (process.env.TRIADE_SMOKE) {
    mainWindow.webContents.once('did-finish-load', () => {
      void (async () => {
        try {
          const js = (code: string): Promise<unknown> => mainWindow!.webContents.executeJavaScript(code)
          const gpus = (await js('window.triade.gpuList(true)')) as {
            usable: { name: string }[]
            excluded: { name: string }[]
            selectable: boolean
          }
          log.info(`[smoke] gpu utilizzabili: ${gpus.usable.map((g) => g.name).join(' | ') || 'nessuna'}`)
          log.info(`[smoke] gpu escluse: ${gpus.excluded.map((g) => g.name).join(' | ') || 'nessuna'}`)
          log.info(`[smoke] selezione per chat attiva: ${gpus.selectable}`)
          const model = (await js('window.triade.modelStatus()')) as { id: string; modelReady: boolean }
          log.info(`[smoke] modello ${model.id} pronto: ${model.modelReady}`)
          const catalog = (await js('window.triade.modelsCatalog()')) as unknown[]
          log.info(`[smoke] catalogo: ${catalog.length} modelli`)

          const found = (await js(`window.triade.hfSearch('qwen2.5-vl')`)) as { repo: string }[]
          log.info(`[smoke] ricerca HuggingFace: ${found.length} risultati`)
          if (found[0]) {
            const v = (await js(`window.triade.hfInspect(${JSON.stringify(found[0].repo)})`)) as {
              ok: boolean
              vision: boolean
              quant: string | null
              totalMiB: number
              availableMiB: number
              reason: string
            }
            log.info(
              `[smoke] verdetto ${found[0].repo}: ok=${v.ok} vision=${v.vision} quant=${v.quant} ` +
                `${v.totalMiB}/${v.availableMiB} MiB — ${v.reason}`
            )
            const moe = (await js(
              `window.triade.hfInspect('Qwen/Qwen3-VL-30B-A3B-Instruct-GGUF')`
            )) as { ok: boolean; moe: boolean; mode: string; quant: string; contextSuggestion: number }
            log.info(
              `[smoke] MoE: ok=${moe.ok} moe=${moe.moe} modo=${moe.mode} quant=${moe.quant} ctx=${moe.contextSuggestion}`
            )
          }
          const memory = (await js('window.triade.memoryStats()')) as { entries: number }
          log.info(`[smoke] memoria: ${memory.entries} elementi`)
          const list = (await js('window.triade.listSessions()')) as { id: string }[]
          if (list.length) {
            const res = (await js(
              `window.triade.deleteSession(${JSON.stringify(list[0].id)})`
            )) as { sessions: unknown[]; memory: { entries: number } }
            log.info(
              `[smoke] eliminazione sessione: ${list.length} -> ${res.sessions.length} chat, memoria ${memory.entries} -> ${res.memory.entries}`
            )
          }
          const recent = (await js('window.triade.memoryRecent(3)')) as { id: string }[]
          if (recent.length) {
            const before = (await js('window.triade.memoryStats()')) as { entries: number }
            const removed = (await js(
              `window.triade.memoryDelete(${JSON.stringify([recent[0].id])})`
            )) as { stats: { entries: number } }
            log.info(
              `[smoke] eliminazione voce di memoria: ${before.entries} -> ${removed.stats.entries}`
            )
          }
          if (process.env.TRIADE_SMOKE === '6') {
            await js(
              `window.triade.startDebate('Smoke stop: dibattito da fermare subito.', [], '')`
            )
            await new Promise((r) => setTimeout(r, 6000))
            const stopped = (await js('window.triade.stopDebate()')) as { state: string; turns: unknown[] }
            const listAfter = (await js('window.triade.listSessions()')) as { id: string }[]
            log.info(`[smoke] dopo stop: stato=${stopped.state} turni=${stopped.turns.length} sessioni elencate=${listAfter.length}`)
            await new Promise((r) => setTimeout(r, 1500))
            const still = (await js('window.triade.currentSession()')) as { state: string; turns: unknown[] }
            log.info(`[smoke] dopo 1.5s: stato=${still.state} turni=${still.turns.length} (nessun nuovo turno atteso)`)
          }

          if (process.env.TRIADE_SMOKE === '5') {
            // prova completa: aggiunta da HuggingFace + download effettivo
            const repo = process.env.TRIADE_SMOKE_REPO ?? 'ggml-org/SmolVLM2-256M-Video-Instruct-GGUF'
            const added = (await js(
              `window.triade.modelsAddCustom(${JSON.stringify(repo)}, ${JSON.stringify(
                process.env.TRIADE_SMOKE_QUANT ?? 'F16'
              )})`
            )) as { entry: { id: string } }
            log.info(`[smoke] aggiunto modello personalizzato: ${added.entry.id}`)
            const st = (await js(
              `window.triade.modelsInstall(${JSON.stringify(added.entry.id)})`
            )) as { modelReady: boolean; mmprojReady: boolean }
            log.info(
              `[smoke] download personalizzato: modello ${st.modelReady}, mmproj ${st.mmprojReady}`
            )
            const list = (await js('window.triade.modelsCatalog()')) as {
              id: string
              installed: boolean
            }[]
            log.info(`[smoke] catalogo ora: ${list.length} modelli, ${list.filter((m) => m.installed).length} installati`)
          }

          log.info('[smoke] OK')

          if (process.env.TRIADE_SMOKE === '2') {
            log.info('[smoke] avvio dibattito reale…')
            await js(
              `window.triade.startDebate('Smoke test: in due frasi, quale modello locale e quale GPU conviene per un agente di ricerca?', [], ${JSON.stringify(process.env.TRIADE_SMOKE_PERSONA ?? '')})`
            )
            const deadline = Date.now() + 9 * 60 * 1000
            let turns = 0
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 3000))
              const cur = (await js('window.triade.currentSession()')) as {
                turns: { name: string; text: string; tokensIn: number }[]
                state: string
                memory: string
              } | null
              turns = cur?.turns?.length ?? 0
              if (turns >= 3 || cur?.state === 'concluded' || cur?.state === 'error') {
                for (const t of cur?.turns ?? []) {
                  log.info(`[smoke] turno ${t.name} (${t.tokensIn} tok prompt): ${t.text.slice(0, 140).replace(/\s+/g, ' ')}`)
                }
                log.info(`[smoke] stato finale: ${cur?.state}, turni: ${turns}`)
                break
              }
            }
            await js('window.triade.pauseDebate()')
            if (turns < 1) throw new Error('il dibattito non ha prodotto turni')
          }
        } catch (err) {
          log.error('[smoke] FALLITO:', (err as Error).message)
          process.exitCode = 1
        }
        // i llama-server figli vanno fermati prima di uscire, altrimenti restano in VRAM
        await engine.pause()
        await llamaPool.stopAll()
        app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0)
      })()
    })
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Senza una GPU dedicata il progetto non è supportato: avviso esplicito e uscita
 * immediata, invece di far girare un modello da 9B sulla CPU.
 */
/** Controllo aggiornamenti all'avvio: dialogo bloccante, timeout breve, mai fatale. */
// una promise rifiutata non deve produrre un warning rumoroso né far cadere l'app
// Su Linux (X11/compositor) Chromium non riesce a leggere il vsync e spamma
// "GetVSyncParametersIfAvailable() failed": è un avviso innocuo, lo si disattiva.
// Con TRIADE_SOFTWARE_RENDER=1 si passa del tutto alla composizione software,
// utile su driver problematici (nessun impatto sui modelli: girano in llama-server).
if (process.platform === 'linux') {
  if (process.env.TRIADE_SOFTWARE_RENDER === '1') {
    app.disableHardwareAcceleration()
  } else {
    app.commandLine.appendSwitch('disable-gpu-vsync')
    app.commandLine.appendSwitch('disable-frame-rate-limit')
  }
}

process.on('unhandledRejection', (reason) => {
  log.error('[main] promise non gestita:', reason instanceof Error ? reason.message : reason)
})

const t = (key: string, params?: Record<string, string | number>): string =>
  translate(getSettings().ui?.language ?? 'en', key, params)

const liveWindow = (): BrowserWindow | null =>
  mainWindow && !mainWindow.isDestroyed() ? mainWindow : null

/** true = aggiornamento applicato e app in chiusura (non mostrare nulla) */
async function maybeUpdate(): Promise<boolean> {
  try {
    const { checkForUpdate, downloadUpdate, applyUpdate, updateTexts, skipVersion, progressWindow } =
      await import('./updater')
    const info = await checkForUpdate()
    if (!info) return false
    const t = updateTexts()
    const choice = dialog.showMessageBoxSync(liveWindow() ?? undefined!, {
      type: 'question',
      buttons: [t.now, t.later, t.skip],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: t.title,
      message: t.message(info.version),
      detail: info.notes || undefined
    })
    if (choice === 2) {
      skipVersion(info.version)
      return false
    }
    if (choice !== 0) return false

    // la finestra principale resta visibile: se la finestrella di progresso non
    // si apre (o il download è lento) l'utente deve comunque vedere che succede
    let pw: { update: (p: number) => void; close: () => void } | null = null
    try {
      pw = progressWindow(t.title)
    } catch (err) {
      log.warn(`[update] finestrella non disponibile: ${(err as Error).message}`)
    }
    log.info('[update] download avviato')
    let nuovo = ''
    try {
      nuovo = await downloadUpdate(info, (p) => {
        pw?.update(p)
        liveWindow()?.setProgressBar(Math.min(1, p))
        liveWindow()?.setTitle(`TriadeAI — aggiornamento ${Math.round(p * 100)}%`)
      })
      log.info('[update] download completato, applico')
    } finally {
      pw?.close()
      liveWindow()?.setProgressBar(-1)
      liveWindow()?.setTitle(`TriadeAI v${app.getVersion()}`)
    }
    applyUpdate(nuovo, info.version)
    // da qui l'app sta per chiudersi: nessun accesso alla finestra
    return true
  } catch (err) {
    liveWindow()?.setProgressBar(-1)
    log.error(`[update] fallito: ${(err as Error).message}`)
    if (!liveWindow()) {
      // senza finestra l'errore deve comunque essere visibile
      dialog.showErrorBox(t('update.errorTitle'), String((err as Error).message))
      return false
    }
    dialog.showMessageBoxSync(liveWindow()!, {
      type: 'error',
      title: t('update.errorTitle'),
      message: (err as Error).message,
      detail: t('update.errorDetail'),
      buttons: ['OK']
    })
    return false
  }
}

async function assertGpu(): Promise<boolean> {
  if (process.env.TRIADE_SKIP_GPU_CHECK === '1') return true
  // con un'API remota la GPU non serve: il controllo vale solo per llama-server locale
  try {
    const { getSettings, saveSettings } = await import('./settings')
    const { activePersonas, backendFor } = await import('../shared/personas')
    const s = getSettings()
    const needsLocal = activePersonas(s).some((p) => backendFor(s, p.id) === 'llama')
    if (!needsLocal) return true
    const { usable } = await detectGpus(true)
    if (usable.length > 0) return true
    // nessuna GPU dedicata: si offre la scelta di un backend remoto invece di uscire subito
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'TriadeAI — nessuna GPU dedicata',
      message:
        'Nessuna GPU dedicata AMD (Vulkan) o NVIDIA (Vulkan/CUDA) rilevata.\n\n' +
        'TriadeAI può comunque funzionare con un\u2019API remota (OpenAI, Anthropic o Ollama).\n\n' +
        'Vuoi usare un\u2019API remota?',
      buttons: ['Usa un\u2019API remota', 'Chiudi'],
      defaultId: 0,
      cancelId: 1
    })
    if (choice !== 0) return false
    saveSettings({ backend: 'openai' })
    return true
  } catch {
    return false
  }
  const { usable, excluded, error } = await detectGpus(true)
  if (usable.length > 0) return true
  const detail = excluded.length
    ? `Rilevate solo GPU integrate: ${excluded.map((d) => d.name).join(', ')}.`
    : error ?? 'Nessuna GPU Vulkan/CUDA rilevata.'
  dialog.showErrorBox(
    'TriadeAI — GPU non supportata',
    `${detail}\n\nTriadeAI richiede una GPU dedicata AMD (Vulkan) o NVIDIA (Vulkan/CUDA). ` +
      'Senza GPU dedicata l\u2019applicazione non può funzionare ed è stata chiusa.'
  )
  return false
}

app.whenReady().then(async () => {
  if (!(await assertGpu())) {
    app.exit(1)
    return
  }
  await llamaPool.cleanupOrphans()
  void (async () => {
    try {
      const { memory } = await import('./memory/store')
      await memory.prepare()
    } catch (err) {
      log.error('[memoria] preparazione embedding fallita:', (err as Error).message)
    }
  })()
  registerIpc()
  try {
    const { recoverFailedUpdate } = await import('./updater')
    const { cleanupUpdateLeftovers, markBooted } = await import('./updater')
    cleanupUpdateLeftovers()
    const rolledBack = recoverFailedUpdate()
    // certifica che questa versione è viva: è la prova che il watchdog Windows attende
    markBooted()
    if (rolledBack) {
      dialog.showErrorBox(
        t('update.rollbackTitle'),
        t('update.rollbackMessage', { version: rolledBack })
      )
    }
  } catch {
    /* il controllo non deve impedire l'avvio */
  }

  void import('./housekeep').then(({ evictCache }) => {
    const freed = evictCache()
    if (freed > 0) log.info(`[cache] liberati ${(freed / 1024 ** 2).toFixed(1)} MiB`)
  })

  // tutti i binari vivono in dati/bin (copiati dal pacchetto al primo avvio)
  try {
    const { ensureBinaries } = await import('./paths')
    ensureBinaries()
  } catch {
    /* la copia non deve impedire l'avvio */
  }

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let shuttingDown = false

app.on('before-quit', (event) => {
  if (shuttingDown) return
  event.preventDefault()
  shuttingDown = true
  void (async () => {
    // ordine inverso di registrazione: prima il motore, poi i server
    onShutdown(() => stopEmbedServer())
    onShutdown(() => llamaPool.stopAll())
    onShutdown(() => engine.pause())
    try {
      // la pulizia non deve poter bloccare l'uscita (era la causa dei processi appesi)
      await Promise.race([shutdownAll(), new Promise((r) => setTimeout(r, 5000))])
    } catch {
      /* ignore */
    } finally {
      // su Windows i processi figli trattengono la VRAM: chiusura forzata garantita
      try {
        llamaPool.forceKillAll()
      } catch {
        /* ignore */
      }
      app.exit(0)
    }
  })()
})
