# TriadeAI

Tre personalità, **un solo modello locale**, un dibattito che continua finché non arriva a una
conclusione — con ricerca web, immagini, video e audio. Applicazione Electron all-in-one per
Windows (exe portabile) e Linux (AppImage), pensata per GPU AMD via Vulkan e, se presente la build
CUDA, per GPU NVIDIA. Nessun supporto ROCm/HIP.

## Cosa fa

- **3 chat, 3 personalità, 1 modello.** Le personalità sono system prompt modificabili; il modello
  GGUF è uno e condiviso, quindi non triplica la VRAM.
- **Dibattito autonomo.** Gli agenti si rispondono a turno; si fermano al consenso
  (`[[CONSENSO: …]]`, validato da un turno-giudice) o al limite di turni.
- **Interrompi e riprendi.** Ogni turno è su disco: "pausa" annulla la generazione in corso,
  "riprendi" riparte dalla sessione esatta, anche dopo aver chiuso l'app.
- **Sessioni come ChatGPT/OpenWebUI.** Sidebar con tutte le chat: aprirne una nuova non perde le
  precedenti; selezionando una chat vecchia si continua da lì.
- **Memoria persistente + vector DB.** Ogni turno finisce in un indice vettoriale locale
  (`dati/memoria/`), e a fine sessione il modello distilla i "fatti" riutilizzabili. Le sessioni
  successive li richiamano per similarità nel system prompt. Dalla pagina "memoria condivisa" si
  eliminano le singole voci; eliminando una chat (× nella sidebar) spariscono anche **tutte** le
  voci di memoria che quella chat ha prodotto.
- **Reasoning visibile.** Il ragionamento del modello resta attivo quando il template lo supporta:
  nel turno compare un blocco "ragionamento" richiuso, espandibile. Anche i tool call sono card
  richiudibili con argomenti e risultato.
- **Stato di lavoro per chat.** Ogni colonna mostra cosa sta facendo (preparazione del prompt,
  ragionamento, scrittura, uso di un tool) con spinner e cronometro; la vista segue i token in
  arrivo e smette di seguire appena risali.
- **Chi risponde.** Una select nel composer permette di scegliere quale delle tre personalità deve
  rispondere al messaggio; le altre ricevono il turno dopo, in rotazione. La colonna di chi ha la
  parola è segnalata, e chi viene chiamato con `@Nome` mostra "chiamato da …".
- **Gruppo consapevole.** Ogni agente conosce il roster degli altri due (nome e ruolo) e può
  chiamarli con `@Nome` spiegando il motivo: la motivazione viene mostrata come chip nel turno.
- **Testo regolabile e markdown.** Dimensione del testo configurabile (85–160%), grassetto, corsivo,
  codice, titoli, liste, citazioni e link resi leggibili.
- **Vision, video, audio.** Immagini lette via mmproj (`qwen3vl_merger`), video scomposti in frame
  con ffmpeg (+ trascrizione traccia audio), audio trascritto con whisper.cpp.
- **Upload media in chat** con file picker o drag&drop.
- **Tool web:** `web_search`, `fetch_page`, `image_search`, `find_media` via tool calling nativo.
  Backend: SearXNG (default), Brave, Tavily, Google CSE con chiavi API; catena di riserva senza
  chiavi (DuckDuckGo Instant Answer, Wikipedia) quando il motore principale non risponde.
- **Contesto configurabile:** 65536 token di default, uguale per le tre chat; tetto di sicurezza per
  turno 16384 token (il vero limite resta il contesto). Al **75%** parte il
  prompt compression (sommario + finestra scorrevole). Il testo del turno non viene mai troncato a
  priori: la generazione si ferma solo se il modello entra in loop (ripetizione ossessiva) o se il
  budget di contesto si esaurisce.
- **Uno o più llama-server.** Un processo per ogni coppia modello+GPU: 3 chat sullo stesso modello =
  1 processo; modelli o GPU diverse = un processo ciascuna. All'avvio i processi rimasti da
  un'esecuzione precedente vengono chiusi (pidfile in `dati/run/`), così la VRAM è libera.
- **Scelta GPU per chat.** Le GPU vengono elencate dal backend (Vulkan/CUDA), le integrate sono
  riconosciute e escluse **senza nomi hardcoded** (tipo dichiarato dal driver Vulkan, memoria
  dedicata riportata dal sistema, euristica sulla memoria condivisa). Con una sola GPU la scelta è
  disabilitata.
- **Auto-tuning anti-OOM.** Prima di avviare `llama-server` legge l'header GGUF (numero di layer,
  head KV, dimensioni K/V, `full_attention_interval` per i modelli ibridi) e stima KV cache, pesi e
  buffer; poi sceglie contesto effettivo, tipo KV (`f16 → q8_0 → q4_0`), offload del mmproj e
  `ubatch`. Con l'auto-tuning attivo la scelta di quanti layer mettere in GPU è lasciata a
  llama.cpp (`fit`), che è l'unico a conoscere la VRAM libera in quell'istante. Le decisioni
  finiscono nel log come `[tuning]`.
- **Avvio protetto.** Senza GPU dedicata l'app mostra un avviso esplicito ed esce subito.
- **All-in-one.** Se il modello non c'è, viene scaricato in `dati/modelli/` accanto all'eseguibile,
  con `.part` e `Range` per riprendere un download interrotto. Nessun download CUDA se non c'è una
  GPU NVIDIA.

## Requisiti

| Cosa | Dettaglio |
|---|---|
| GPU | AMD RDNA2/RDNA3 con Vulkan (RX 7600 XT: 16 GB comodi per 5.6 GB + mmproj) |
| Driver | Adrenalin aggiornati (runtime Vulkan di sistema) |
| Disco | ~7 GB modello + mmproj, ~1 GB whisper + binari |
| OS | Windows 10/11 x64, Linux x64 |

## Modello

| File | Dimensione | Ruolo |
|---|---|---|
| `Ornith-1.5-9B-uncensored.Q4_K_M.gguf` | 5.63 GB | LLM (`general.architecture = qwen35`, ibrido con attenzione 1:4) |
| `Ornith-1.5-9B-uncensored.mmproj-Q8_0.gguf` | 0.7 GB | vision (`clip.projector_type = qwen3vl_merger`) |
| `ggml-base.bin` | 142 MB | ASR whisper.cpp |

## Struttura su disco (accanto all'eseguibile)

```
dati/
  modelli/        GGUF scaricati
  sessioni/       una sessione JSON per chat
  memoria/        vector DB (meta.json + vettori.f32)
  cache/          allegati, frame video, media scaricati
  log/            log di llama-server
  impostazioni.json
bin/              llama-server (Vulkan/CUDA), ffmpeg, whisper (nella build: resources/bin)
```

## Sviluppo

```bash
npm install
npm run fetch:bin            # llama.cpp Vulkan + ffmpeg + whisper + modello whisper
npm run fetch:bin -- win     # binari Windows
npm run fetch:bin -- win --cuda   # build CUDA, solo se c'è una GPU NVIDIA
npm run dev
npm run typecheck
```

### Verifiche automatiche

```bash
TRIADE_SMOKE=1 npx electron out/main/index.js   # finestra + IPC + GPU + modello
TRIADE_SMOKE=2 npx electron out/main/index.js   # dibattito reale, 3 turni
TRIADE_SKIP_GPU_CHECK=1 ...                      # override solo per sviluppo senza GPU
```

## Build

```bash
npm run dist:linux    # dist/TriadeAI-0.1.0.AppImage
npm run dist:win      # dist/TriadeAI-0.1.0-portable.exe (da Linux serve wine)
```

### Build sulla macchina remota (SSH)

Le credenziali **non stanno nel repository**: copia `.build.env.example` in `.build.env`
(ignorato da git) e valorizza `BUILD_HOST` e `BUILD_DIR`, oppure esportali nell'ambiente.

```bash
npm run dist:linux:remote
npm run dist:win:remote
```

Lo script sincronizza il progetto, installa le dipendenze, scarica i binari e riporta gli artefatti
in `dist/`.

### Firma del codice e avviso SmartScreen

Windows mostra l'avviso "Windows ha protetto il PC" per qualsiasi eseguibile non firmato con un
certificato riconosciuto: è un giudizio di SmartScreen, non una proprietà del file, e non si
disattiva lato app. Le strade reali:

1. **Azure Trusted Signing** (~10 €/mese, richiede anzianità dell'organizzazione) — riconosciuto
   subito, firma in CI senza token hardware.
2. **Certificato EV** (~300-500 €/anno, token USB/HSM) — reputazione immediata.
3. **Certificato OV** (~150 €/anno) — la reputazione si costruisce con i download.

Un certificato autofirmato **non** risolve. La pipeline è pronta:

```bash
export CSC_LINK=/percorso/certificato.pfx    # oppure base64
export CSC_KEY_PASSWORD=...
npm run dist:win
```

Per Azure Trusted Signing si aggiunge `win.azureSignOptions` in `electron-builder.yml`.

## Uso

1. Primo avvio: scelta del modello (multi-selezione; per ora solo Ornith) e download.
2. Scrivi l'argomento, allega eventualmente media, premi **avvia**.
3. Le tre colonne si riempiono a turno; `pausa` ferma subito, `riprendi` continua.
4. Impostazioni → generale: contesto, soglia di compressione (75%), tetto token per turno, limite
   turni, temperatura, dimensione del testo, strati GPU, flash attention, KV cache, auto-tuning.
5. Impostazioni → ricerca: provider e chiavi. → gpu: GPU per chat. → personalità: i tre prompt e il
   modello di ciascuna chat. → modelli: download, modello attivo, eliminazione file.

Nota: molte istanze SearXNG pubbliche rispondono con captcha/rate limit. Per una ricerca affidabile
conviene puntare `URL SearXNG` a un'istanza propria; in assenza di risultati l'app usa comunque la
catena di riserva senza chiavi.

## Note tecniche

- **Porta dinamica.** Ogni `llama-server` ascolta su una porta libera chiesta al sistema; se il bind
  perde una corsa, l'avvio riprova su un'altra porta (fino a 5 tentativi).
- **KV e contesto.** Il conteggio dei token usa `/tokenize` del server; la compressione scatta a
  `contesto × 75%`.
- **Stop della generazione.** Solo per ripetizione ossessiva (blocco ripetuto ≥3 volte) o esaurimento
  del budget di contesto; il testo prodotto non viene mai tagliato arbitrariamente.
- **Consenso.** Il marcatore viene rimosso dal testo mostrato e validato a temperatura 0 in JSON.
- **Download modello.** `HEAD` per la dimensione reale, ripresa con `Range`, verifica di completezza,
  rinominazione atomica.

## Licenza

MIT per il codice. Il modello ha licenza propria (vedi la model card di
`junafinity/Ornith-1.5-9B-uncensored`).
