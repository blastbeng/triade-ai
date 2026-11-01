# TriadeAI

**One model, up to three personalities, a real debate — or a plain assistant chat.**

TriadeAI is a local-first desktop app (Electron + React + TypeScript) where two or three AI agents
discuss your topic with each other until they reach a validated consensus, or you stop them. With a
single personality it becomes a normal ChatGPT/OpenWebUI-style chat. Inference runs either on a
**local `llama-server` over Vulkan** (no ROCm/HIP) or through a **remote API** (OpenAI,
Anthropic, Ollama).

```
┌─ TriadeAI ─────────────────────────────────────────────────────────────┐
│  ◆ Architect      ▲ Devil's advocate     ● Researcher                  │
│  own prompt       own prompt             own prompt                    │
│  own model/GPU    own model/GPU          own model/GPU                 │
├────────────────────────────────────────────────────────────────────────┤
│  topic + attachments, choose who answers, send  →                      │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 1. What it does

### Configurable personalities (1–3)
- **1 personality** → single-column assistant chat: no debate, no rotation, no consensus, a
  dedicated assistant system prompt (`MODALITÀ ASSISTENTE`): the loop answers once and goes back to
  idle.
- **2 personalities** → Architect + Devil's Advocate debating each other.
- **3 personalities** (default) → Architect + Devil's Advocate + Researcher.
- Choose the count at first run and later in *Settings → personalities*. Ids are stable across
  languages, so per-chat model/GPU assignments survive edits. Default prompts follow the UI
  language and are replaced only while they are still untouched.

### Debating engine
- Turn rotation with no agent speaking twice in a row.
- **`@Name` mentions decide the next speaker**, and the mentioning agent must say *why* it calls
  that agent — the UI shows the chip `→ Researcher` with the sentence that motivated it, and the
  called column shows `called by Architect`.
- **Mid-sentence hand-off** with `[[PASSA A: Name]]`: generation is aborted at the marker, the text
  written so far is kept, the marker removed, and the floor passes immediately (real interruption).
- **Consensus** only when a judge call validates the proposal (`[[CONSENSO: …]]`); otherwise the
  debate continues until `maxTurns`, error, or your stop.
- **Pause / stop / resume**: pause aborts generation instantly and keeps the chat resumable; stop
  closes it (state `stopped`, facts distilled into memory); resume continues from the exact turn,
  even after restarting the app. A message sent into an existing conversation always continues it.
- **Turns are never truncated by length**: the generation budget is whatever is left up to the 75%
  context threshold; a turn stops only on obsessive repetition (loop detector) or when the budget is
  exhausted — both flagged in the UI (`stopped: repetition`, `near the context limit`).

### Model & context management
- **Default model**: `Ornith-1.5-9B-uncensored.i1-Q4_K_M.gguf` (imatrix) from
  [Ornith-1.5-9B-uncensored-i1-GGUF](https://huggingface.co/mradermacher/Ornith-1.5-9B-uncensored-i1-GGUF),
  with `mmproj-Q8_0.gguf` taken from the **base** repo
  [Ornith-1.5-9B-uncensored-GGUF](https://huggingface.co/mradermacher/Ornith-1.5-9B-uncensored-GGUF)
  — imatrix repos do not contain the vision projector
  (`qwen35` hybrid architecture, 32 layers of which 8 with full attention, 262144 native context,
  vision tower).
- **Context** default **131072** tokens, shared by all chats and editable in settings — but always
  `min(your setting, model max)` from the GGUF header, in server start, pool planning, prompt
  compression and HF compatibility estimates.
- **Prompt compression at 75%** of the *effective* context: transcript stays intact on disk and in
  the UI, only the model window is summarized (`contextFrom` advances).
- **Auto-tuning per GPU**: planner derives context, KV type (`f16 → q8_0 → q4_0`), ubatch, mmproj
  placement and offload from real VRAM and the GGUF header; layers are left to llama.cpp's `fit`
  (`-ngl auto`), which knows the free VRAM at that moment.
- **No OOM by construction**: the pool reserves VRAM per device, splits the KV cache between the
  models that will run together, shrinks contexts, or refuses to start with an explicit message.
  Orphaned `llama-server` processes are killed at startup via pid files.

### Model onboarding and downloads
- First run: language → backend → **number of personalities** → models.
- Default card is the internal **llama-server + Ornith**; nothing else is required. Any additional
  model can be searched **on HuggingFace** from the onboarding or from *Settings → models*.
- Every candidate is verified *before* being offered:
  - must have a **vision `mmproj`** (otherwise excluded: the app uses images/video);
  - for imatrix repos (`-i1-GGUF`) the projector is searched in the parent repo
    (`-GGUF`, base name, `<base>-GGUF`); files named `mmproj*` or `projector*` are accepted;
  - the **best quant that fits** is chosen (and shown per quant: *all in GPU (ctx N)* /
    *experts on CPU (ctx N)* / *does not fit*);
  - **MoE** models are supported with partial offload (experts in RAM) and a recommended context;
  - VRAM budget is **divided by the number of models that will run concurrently** (distinct models
    among active personalities + the new one), so 1 personality and 3 personalities give different
    verdicts — by design.
- Downloads resume (`.part`), verify size and never block the UI; files live in `data/models/`.
- **Downloads and GPU checks only apply to the local backend**: choosing an API skips them entirely.

### Backends
Every personality picks **its own backend and model**, so one agent can run on the local
llama-server while another talks to OpenAI (mixed setups are supported: one process is started only
for the personalities that actually use `llama`).

| Backend | How | Needs GPU | Downloads |
|---|---|---|---|
| `llama` (default) | bundled `llama-server` (Vulkan, Vulkan if fetched) | yes, dedicated | model + mmproj + whisper |
| `openai` | any OpenAI-compatible `/v1/chat/completions` (also Azure-style proxies) | no | none |
| `anthropic` | `/v1/messages` adapter (system prompt, images as base64 blocks, tools as `input_schema`, streaming deltas) | no | none |
| `ollama` | OpenAI-compatible `/v1` endpoint of Ollama | no | none |

- Configured in onboarding and in *Settings → backend* with base URL, API key, model picker
  (*load models* reads `/v1/models`, Ollama's `models[].name` included) and a **test** button that
  performs a minimal generation and reports the exact error.
- Each chat picks its own **backend** (llama/openai/anthropic/ollama) *and* model: the local catalog
  for llama, the provider's model list for the APIs. Choices are stored per personality and per
  backend, so switching back restores the previous model.
- With no dedicated GPU the app no longer exits blindly: it offers a remote API first, and only
  quits if you decline.

### Vision, video, audio, documents
- **Images** go to the model through the `mmproj` (`image_url`; the Anthropic adapter converts them
  to base64 blocks).
- **Video**: ffmpeg samples frames (sent as images) and the audio track is transcribed locally with
  **whisper.cpp** (Vulkan build) — Ornith has no audio encoder, so audio always becomes text.
- **Audio files** are transcribed; **documents** are extracted to text.
- Files are ingested once, cached in `data/cache/`, and can be attached from the composer or by drag
  and drop.

### Tools (function calling)
`web_search`, `fetch_page` (readability extraction), `image_search`, `find_media` (image/video/audio
discovery + download). Native tool calling when the server supports it, with a deterministic
marker-based fallback; truncated tool-call JSON is discarded instead of crashing the server; results
are rendered as collapsible cards.

**Web search chain**: configured provider (SearXNG / Brave / Tavily / Google CSE) → **Bing HTML**
(with `/ck/a` redirect decoding) → **Wikipedia** → **DuckDuckGo instant answers**. The engine that
answered is written into the tool result. Public SearXNG instances usually answer with a captcha —
point the setting at your own instance for serious use. *Settings → search* has a **test** button.

### Memory
- Every turn plus a distilled set of reusable facts goes into a **local vector store**
  (`data/memory/`: `meta.json` + `vectors.bin`, hashed n-gram embeddings, cosine similarity).
- Facts from past sessions are recalled by similarity when a new turn needs them.
- **Deleting a chat deletes the memory it produced** (turns *and* its distilled synthesis);
  single entries can be deleted from the memory panel.

### GPU handling
- Vulkan only (no ROCm/HIP). Detection is **fully dynamic**: the driver-reported type
  (INTEGRATED/DISCRETE), dedicated memory and shared-memory heuristics exclude iGPUs without any
  hardcoded GPU name.
- Every chat can use a different GPU when more than one usable dedicated GPU exists (e.g. a 3060 on
  Vulkan and a 7800 XT on Vulkan); with a single GPU the selector is disabled.
- One `llama-server` per **model+GPU pair**: same model everywhere = one process, different models =
  one process each.

### Sessions
- Sidebar with all chats (state, turn count, date), **title generated at session start** by the
  model (provisional title immediately, refined asynchronously), word-wrapped to two lines.
- Open any past chat to continue it, delete it (with its memory), nothing is ever lost by starting a
  new one.

### Interface
- 5 languages (English default, Italian, German, French, Spanish), switchable at first run and in
  settings; system prompts and date formats follow.
- *Settings → UI*: text size, font family, density, line height, corner radius, accent colour,
  timestamps, token counter, markdown on/off, live preview.
- Per-chat status pill with spinner and elapsed time for **prefill / thinking / writing / tool**,
  streaming reasoning block (hidden by default, expandable), tool cards, mention chips, context bar
  with absolute tokens, auto-scroll that follows the chat unless you scroll up.
- Version badge in the title bar.

---

## 2. Requirements

| | |
|---|---|
| OS | Windows 10/11 x64 (portable exe) · Linux x64 (AppImage) |
| Backend | local `llama-server` **or** any OpenAI/Anthropic/Ollama API |
| GPU (local only) | **dedicated** AMD (Vulkan) or NVIDIA (Vulkan); integrated GPUs are excluded |
| VRAM | 8 GB minimum for the 9B model at 131k with `q4_0` KV; 12–16 GB comfortable |
| Disk | ~12 GB for the local default (model 5.6 GB + mmproj 0.7 GB + whisper ~1 GB + binaries) |

## 3. Quick start

```bash
npm install
npm run fetch:bin                 # llama.cpp Vulkan + ffmpeg + whisper.cpp into bin/
npm run dev                       # dev mode; models are downloaded from the app
npm run build:linux               # dist/TriadeAI-<version>.AppImage
npm run build:win                 # dist/TriadeAI-<version>-portable.exe (wine on Linux)
npm run fetch:bin -- --cuda       # optional: adds the Vulkan build (NVIDIA)
```

## 4. Data layout — always next to the executable

Everything the app creates lives in `data/` beside the `.exe` / `.AppImage`, **not** in the working
directory and never in the temporary extraction folder:

```
data/
├─ models/      GGUF models + mmproj (and the vector store base)
├─ memory/      vector store: meta.json, vectors.bin
├─ sessions/    one JSON per chat (resumable)
├─ cache/       extracted frames, fetched pages, audio
├─ run/         llama-server pid files (orphan cleanup)
└─ settings.json
```

Resolution order: `PORTABLE_EXECUTABLE_DIR` / `PORTABLE_EXECUTABLE_FILE` (Windows portable) →
`APPIMAGE` (or `/proc/self/cmdline` for extract-and-run) → writable exe directory → user data
fallback. The resolved path is logged at startup (`[paths] cartella dati: …`).

## 5. Versioning

Every change bumps the version: `npm run release:patch|minor|major`
(`scripts/bump.mjs`). The version appears in the title bar and in the artifact names.

## 6. Development

```bash
npm run typecheck
npm test                 # vitest: update logic, scheduling, i18n, personalities
npm run build            # main + preload + renderer
npm run stage:linux      # copy bin/ into the bundle (real .so files, no symlinks)
npm run stage:win        # same for the Windows payload
```

The Windows update supervisor (`src/main/update-script.ts`) is exercised for real by
`tests/update-script.test.ts`: swap, rollback and `swap-failed` run the generated
PowerShell on a `windows-latest` runner, and are skipped elsewhere.

Test switches: `TRIADE_SMOKE=1|2|…` (headless self-checks), `TRIADE_SHOT=1` (screenshot),
`TRIADE_SHOT_TEST=search`, `TRIADE_DEBUG_SEARCH=1` (search diagnostics),
`TRIADE_SKIP_GPU_CHECK=1` (UI work on a machine without a dedicated GPU — never for real use).

Windows and Linux artifacts are produced on a Linux host (wine for the Windows packaging); the build
machine is described by `.build.env` (git-ignored, see `.build.env.example`). No IPs, hostnames or
credentials are committed.

## 7. Model

- Default: `Ornith-1.5-9B-uncensored.i1-Q4_K_M` (imatrix) + `mmproj-Q8_0` from the base repo.
- Downloads are taken in **64 MB verified blocks**, the size must match the byte and the
  SHA-256 must match the official HuggingFace one; otherwise the file is deleted and retried.
- Architecture `qwen35`, 32 layers (8 full-attention), 262144 native context, vision through
  `qwen3vl_merger`.

## 8. Known limits

- **Public SearXNG** instances usually answer with a captcha: use your own instance for reliable
  web search.
- **OpenAI/Anthropic real calls** require your keys; the *test* button reports the exact error.
  The Anthropic adapter is implemented and type-checked but not yet exercised against a live key.
- **Linux packaging** is validated (including the packaged smoke test); Windows artifacts are
  produced and staged with wine on the build host, so a final run on real Windows hardware is
  recommended.
- App icon still the Electron default.

## 9. CI and releases (branches)

| Branch | What runs | Result |
|---|---|---|
| `main` | `ci` workflow: typecheck, tests, build, package on Linux + Windows | artifacts only, **no release** |
| `release` | `release` workflow: verifies `release == main`, builds, signs, packages | **GitHub Release** `v<version>` with the Windows `.zip`, the Linux `.tar.gz` and `SHA256SUMS.txt` |

`promote` runs on every push to `main` and decides whether the change is a **big one**: it compares
the version in `package.json` with the last `v*` tag — a **minor or major bump** (or the very first
tag) counts as big. If it is, it fast-forwards the `release` branch to `main` (the branch must not
contain extra commits) which triggers the release. A patch-only push stays on `main` and publishes
nothing; to force a release anyway: *Actions → promote → Run workflow → force*.

The release branch is therefore always an exact copy of `main`: `release.yml` refuses to publish if
`git rev-parse HEAD` differs from `origin/main`.

### Activating the workflows

1. The files live in `.github/workflows/` (`ci.yml`, `promote.yml`, `release.yml`). Pushing them
   requires a token with the **`workflow`** scope (classic PAT) or *Workflows: Read and write*
   (fine-grained). Without it GitHub rejects the push with
   `refusing to allow a Personal Access Token to create or update workflow`.
2. Repo → **Settings → Actions → General → Workflow permissions** → *Read and write permissions*
   (the release job creates tags and releases with `GITHUB_TOKEN`).
3. If `release` is protected: allow the GitHub Actions bot to push to it, or leave it unprotected —
   it is only written by `promote`.
4. First run: `Actions → promote → Run workflow` with `force` = true, or bump the version with
   `npm run release:minor` and push to `main`.

## 10. License

MIT for the code. The model has its own license — see the
[junafinity/Ornith-1.5-9B-uncensored](https://huggingface.co/junafinity/Ornith-1.5-9B-uncensored)
model card.
