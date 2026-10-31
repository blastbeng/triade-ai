# TriadeAI

Tre personalità, **un solo modello locale**, un dibattito che continua finché non arriva a una
conclusione — con ricerca web, immagini, video e audio. Applicazione Electron all-in-one per
Windows e Linux, pensata per girare **solo su GPU AMD via Vulkan** (testata su RX 7600 XT).

![stato](https://img.shields.io/badge/stato-alpha-orange)

## Cosa fa

- **3 chat, 3 personalità, 1 modello.** Le personalità sono system prompt modificabili dalle
  impostazioni; il modello GGUF è uno e condiviso, quindi non triplica la VRAM.
- **Dibattito autonomo.** Dopo il primo input gli agenti si rispondono a turno. Si fermano quando
  dichiarano un consenso (`[[CONSENSO: …]]`) e un turno-giudice lo valida, oppure quando si
  raggiunge il limite di turni.
- **Interrompi e riprendi.** Ogni turno è salvato su disco: "pausa" annulla la generazione in corso,
  "riprendi" riparte dalla sessione esatta, anche dopo aver chiuso l'app.
- **Vision, video, audio.** Immagini lette direttamente dal modello (mmproj `qwen3vl_merger`),
  video scomposti in frame con ffmpeg, audio e tracce audio dei video trascritti con whisper.cpp.
- **Tool web.** `web_search`, `fetch_page`, `image_search`, `find_media` con backend **SearXNG**
  (default) oppure Brave / Tavily / Google CSE configurati con chiave API nelle impostazioni.
- **Contesto configurabile.** `65536` token di default, uguale per le tre chat. Al **75%**
  (soglia regolabile) parte il **prompt compression**: la conversazione viene riassunta in una
  memoria condivisa e i turni vecchi escono dalla finestra, mentre la trascrizione completa resta
  su disco.
- **All-in-one.** Un unico eseguibile che avvia `llama-server` (Vulkan) come processo interno: se il
  modello non c'è, lo scarica nella cartella `models/` accanto all'eseguibile, con ripresa del
  download da dove si era interrotto.

## Requisiti

| Cosa | Dettaglio |
|---|---|
| GPU | AMD RDNA2/RDNA3 con Vulkan (RX 7600 XT: 16 GB, comodi per 5.6 GB di modello + mmproj) |
| Driver | Adrenalin aggiornati (runtime Vulkan di sistema) |
| Disco | ~7 GB per modello + mmproj, ~1 GB per whisper + binari |
| OS | Windows 10/11 x64, Linux x64 |

## Modello

| File | Dimensione | Ruolo |
|---|---|---|
| `Ornith-1.5-9B-uncensored.Q4_K_M.gguf` | 5.63 GB | LLM (`general.architecture = qwen35`) |
| `Ornith-1.5-9B-uncensored.mmproj-Q8_0.gguf` | 0.7 GB | vision (`clip.projector_type = qwen3vl_merger`) |
| `ggml-base.bin` | 142 MB | ASR whisper.cpp |

Vengono scaricati da Hugging Face al primo avvio in `models/` (accanto all'exe), con file `.part`
e `Range` per riprendere un download interrotto.

## Struttura

```
src/main/            processo principale: orchestrazione
  llama/server.ts    spawn di llama-server Vulkan, porta libera dinamica, health check
  llama/client.ts    streaming SSE, tokenize, tool call
  llama/downloader.ts download modello/mmproj con resume
  debate/engine.ts   macchina a stati del dibattito, consenso, pausa/ripresa
  debate/context.ts  costruzione prompt + compressione al 75%
  debate/tools.ts    web_search, fetch_page, image_search, find_media
  media/             ffmpeg (frame/audio), whisper.cpp, ingest allegati
  search/            SearXNG, Brave, Tavily, Google CSE
src/renderer/        UI React: 3 colonne, composer, impostazioni, log
scripts/             fetch dei binari, staging, build remota
```

## Sviluppo

```bash
npm install
npm run fetch:bin          # llama.cpp Vulkan + ffmpeg + whisper + modello whisper
npm run dev                # Electron con HMR
npm run typecheck
```

`npm run fetch:bin` scarica i binari per la piattaforma corrente in `bin/<piattaforma>/`.
La build impacchetta `bin/stage/` dentro le risorse dell'app.

## Build

```bash
npm run dist:linux    # AppImage -> dist/TriadeAI-0.1.0.AppImage
npm run dist:win      # portable exe -> dist/TriadeAI-0.1.0-portable.exe
```

La build Windows da Linux richiede `wine` (electron-builder lo usa per NSIS/rcedit).

### Build sulla macchina potente (SSH)

```bash
npm run dist:linux:remote      # bash scripts/build-remote.sh linux
npm run dist:win:remote        # bash scripts/build-remote.sh win
```

Le credenziali **non stanno nel repository**: copia `.build.env.example` in `.build.env`
(ignorato da git) e valorizza `BUILD_HOST` e `BUILD_DIR`, oppure esportali nell'ambiente.
Lo script sincronizza il progetto, installa le dipendenze, scarica i binari e riporta gli
artefatti in `dist/`.

### Firma del codice e avviso SmartScreen

Windows mostra l'avviso blu "Windows ha protetto il PC" per **qualsiasi** eseguibile non firmato
con un certificato riconosciuto: non è una proprietà del file, è un giudizio di SmartScreen, e non
si può disattivare lato app. Le uniche strade reali:

1. **Azure Trusted Signing** (~10 €/mese, richiede una cronologia di 3 anni dell'organizzazione) —
   riconosciuto subito da SmartScreen, firma in CI senza token hardware.
2. **Certificato EV code signing** (DigiCert/Sectigo, ~300-500 €/anno, token USB o HSM cloud) —
   reputazione immediata.
3. **Certificato OV** (~150 €/anno) — la reputazione si costruisce con i download: l'avviso sparisce
   dopo un certo volume, non subito.

Un certificato autofirmato **non** risolve: Windows lo considera non attendibile come qualunque exe
senza firma. La pipeline è già pronta: basta esportare

```bash
export CSC_LINK=/percorso/certificato.pfx      # oppure base64
export CSC_KEY_PASSWORD=...
npm run dist:win                                # electron-builder firma con timestamp RFC3161
```

e per Azure Trusted Signing si aggiunge il blocco `win.azureSignOptions` in `electron-builder.yml`
con endpoint e account del servizio.

## Uso

1. Avvia l'eseguibile: la prima volta scarica modello e mmproj (barra di avanzamento nelle
   impostazioni → modello).
2. Scrivi l'argomento, eventualmente allega immagini/video/audio, premi **avvia**.
3. Le tre colonne si riempiono a turno; `pausa` ferma subito la generazione, `riprendi` continua.
4. Impostazioni → generale: contesto, soglia di compressione, token per turno, limite turni,
   temperatura, strati GPU, flash attention, tipo di KV cache.
5. Impostazioni → ricerca: provider e chiavi API. Impostazioni → personalità: i tre system prompt.

I dati stanno in `dati/` accanto all'eseguibile: `impostazioni.json`, `sessioni/*.json`,
`cache/` per allegati e media scaricati.

## Note tecniche

- **Porta dinamica.** `llama-server` ascolta su una porta libera chiesta al sistema (bind su `:0`),
  mai un numero fisso; se il bind perde una corsa, l'avvio riprova su un'altra porta.
- **Un solo processo.** Le tre personalità condividono lo stesso server e la stessa KV cache:
  `-np 1`, `-c <contesto>`, `-ctk/-ctv q8_0` per risparmiare VRAM.
- **Contesto e compressione.** Il conteggio dei token usa `/tokenize` del server (niente stime a
  caso); quando il prompt supera `contesto × soglia`, viene prodotto un sommario e i turni più
  vecchi vengono rimossi dalla finestra.
- **Consenso.** Il marcatore `[[CONSENSO: …]]` viene rimosso dal testo mostrato e validato da un
  turno separato a temperatura 0 che risponde in JSON.

## Licenza

MIT per il codice. Il modello ha licenza propria (vedi la model card di `junafinity/Ornith-1.5-9B-uncensored`).
