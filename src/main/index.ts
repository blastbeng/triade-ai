import { app, BrowserWindow, dialog, shell } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc'
import { llamaPool } from './llama/server'
import { detectGpus } from './gpu/devices'
import { engine } from './debate/engine'

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
    title: 'TriadeAI',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (process.env.TRIADE_SMOKE) {
    console.log(`[smoke] finestra creata (livello ${process.env.TRIADE_SMOKE})`)
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) =>
      console.error(`[smoke] did-fail-load ${code} ${desc}`)
    )
    mainWindow.webContents.on('render-process-gone', (_e, details) =>
      console.error(`[smoke] render-process-gone ${details.reason}`)
    )
    mainWindow.webContents.on('console-message', (_e, _lvl, message) =>
      console.log(`[smoke][renderer] ${message}`)
    )
  }
  mainWindow.on('ready-to-show', () => mainWindow?.show())
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
          await js(
            "window.triade.startDebate('Screenshot: come progettiamo un agente locale che usa la GPU AMD per la ricerca?', [])"
          )
          await new Promise((r) => setTimeout(r, Number(process.env.TRIADE_SHOT_DELAY ?? 30000)))
          const image = await mainWindow!.webContents.capturePage()
          const fs = await import('node:fs')
          const path = await import('node:path')
          const { dataDir } = await import('./paths')
          const file = path.join(dataDir(), 'screenshot.png')
          fs.writeFileSync(file, image.toPNG())
          console.log(`[shot] salvato ${file} (${fs.statSync(file).size} byte)`)
        } catch (err) {
          console.error('[shot] fallito:', (err as Error).message)
        }
        await engine.pause()
        await llamaPool.stopAll()
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
          console.log(`[smoke] gpu utilizzabili: ${gpus.usable.map((g) => g.name).join(' | ') || 'nessuna'}`)
          console.log(`[smoke] gpu escluse: ${gpus.excluded.map((g) => g.name).join(' | ') || 'nessuna'}`)
          console.log(`[smoke] selezione per chat attiva: ${gpus.selectable}`)
          const model = (await js('window.triade.modelStatus()')) as { id: string; modelReady: boolean }
          console.log(`[smoke] modello ${model.id} pronto: ${model.modelReady}`)
          const catalog = (await js('window.triade.modelsCatalog()')) as unknown[]
          console.log(`[smoke] catalogo: ${catalog.length} modelli`)
          const memory = (await js('window.triade.memoryStats()')) as { entries: number }
          console.log(`[smoke] memoria: ${memory.entries} elementi`)
          console.log('[smoke] OK')

          if (process.env.TRIADE_SMOKE === '2') {
            console.log('[smoke] avvio dibattito reale…')
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
                  console.log(`[smoke] turno ${t.name} (${t.tokensIn} tok prompt): ${t.text.slice(0, 140).replace(/\s+/g, ' ')}`)
                }
                console.log(`[smoke] stato finale: ${cur?.state}, turni: ${turns}`)
                break
              }
            }
            await js('window.triade.pauseDebate()')
            if (turns < 1) throw new Error('il dibattito non ha prodotto turni')
          }
        } catch (err) {
          console.error('[smoke] FALLITO:', (err as Error).message)
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
async function assertGpu(): Promise<boolean> {
  if (process.env.TRIADE_SKIP_GPU_CHECK === '1') return true
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
  registerIpc()
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
    try {
      await engine.pause()
      await llamaPool.stopAll()
    } finally {
      app.quit()
    }
  })()
})
