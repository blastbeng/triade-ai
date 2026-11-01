# TriadeAI

**Three personalities, one model, one debate.** A desktop app (Electron + React + TypeScript) where
three AI agents discuss the same topic with each other until they reach a consensus or you stop
them. Everything runs locally on a **dedicated AMD GPU via Vulkan** (CUDA also supported when the
build is present). No cloud, no ROCm/HIP.

```
┌─ TriadeAI ────────────────────────────────────────────────────────────┐
│  ◆ Architect      ▲ Devil's advocate     ● Researcher                 │
│  (persona 1)      (persona 2)            (persona 3)                  │
├───────────────────────────────────────────────────────────────────────┤
│  write the topic, attach images/video/audio, choose who answers  →    │
└───────────────────────────────────────────────────────────────────────┘
```

## Features

- **Three chats, three personalities, one model.** Each column is its own agent with its own
  system prompt, model, GPU and context. Same model on all three chats = **one** `llama-server`
  process; different models = one process per model+GPU pair.
- **Real debate.** Turn rotation, `@Name` mentions (an agent picks who speaks next and says why),
  and mid-sentence hand-off (`[[PASSA A: Name]]`) which interrupts the speaker and gives the floor
  to another agent. Stop condition: validated consensus, max turns, or your **pause**/**stop**.
- **Pause, stop, resume.** Every turn is persisted: pause interrupts generation immediately, stop
  closes the debate, resume continues from the exact point — even after restarting the app.
- **Vision, video, audio, documents.** Ornith 1.5 9B reads images through its `mmproj`; video is
  sampled into frames with ffmpeg and its audio track transcribed with whisper.cpp; audio files and
  documents are transcribed/extracted locally.
- **Web tools.** `web_search`, `fetch_page`, `image_search`, `find_media` — SearXNG (own instance
  recommended), Brave, Tavily or Google CSE, plus keyless fallbacks.
- **Shared vector memory.** Facts from past sessions are distilled and stored in a local vector
  store (`data/memory/`), recalled by similarity in later chats. Deleting a chat deletes the memory
  it produced; single entries can be removed from the memory panel.
- **HuggingFace model search with verification.** Before offering a model the app checks that it
  has vision (`mmproj`) and that a quant fits your GPUs/RAM — including **MoE** models, whose
  experts can stay in system RAM. Unusable models are excluded with the reason and the recommended
  context.
- **Auto-tuning, no OOM.** Context, KV cache type, ubatch, mmproj placement and layer offload are
  derived from the real VRAM (and the model's GGUF header); llama.cpp's `fit` decides layers. The
  pool reserves VRAM per device and shrinks contexts — or refuses the start — instead of crashing.
- **Reasoning & tool calls.** Always active when the template supports it, hidden by default and
  expandable; tool calls render as collapsible cards.
- **UI settings.** Text size, font, density, line height, corners, accent colour, timestamps,
  token counters, markdown on/off — plus **5 languages** (English, Italian, German, French,
  Spanish); English by default, selectable at first run.

## Requirements

| | |
|---|---|
| OS | Windows 10/11 x64 (portable exe) or Linux x64 (AppImage) |
| GPU | **dedicated** AMD (Vulkan) or NVIDIA (Vulkan/CUDA). Integrated GPUs are excluded and the app exits with a warning if none is found |
| VRAM | 8 GB minimum for the default 9B model at 131k context with `q4_0` KV, 12–16 GB comfortable |
| Disk | ~12 GB (model 5.6 GB + mmproj 0.7 GB + whisper ~1 GB + binaries) |

## Quick start

```bash
npm install
npm run fetch:bin          # llama.cpp Vulkan + ffmpeg + whisper.cpp into bin/
npm run dev                # dev mode (download the model from the app)
npm run build:linux        # dist/TriadeAI-<version>.AppImage
npm run build:win          # dist/TriadeAI-<version>-portable.exe (uses wine on Linux)
```

`npm run fetch:bin -- --cuda` also fetches the CUDA build (only needed for NVIDIA).

Everything the app creates lives next to the executable, in `data/`:

```
data/
├─ models/            # GGUF models + mmproj (the vector store lives here too)
├─ memory/            # vector store: meta.json, vectors.bin
├─ sessions/          # one JSON per chat (resumable)
├─ cache/             # extracted frames, fetched pages, audio
├─ run/               # llama-server pid files (orphan cleanup)
└─ settings.json
```

On first start the app asks for the language, then which models to use (Ornith 1.5 9B is
preselected) and downloads them with resume inside `data/models/`.

## Versioning

Every change bumps the version (`npm run release:patch|minor|major`, script `scripts/bump.mjs`):
patch for fixes, minor for new features, major for breaking changes. The version is shown in the
title bar and used in the artifact names.

## Development

```bash
npm run typecheck
npm run build              # main + preload + renderer
npm run stage:linux       # copy bin/ into the bundle (real .so files, no symlinks)
```

Environment switches used by the tests: `TRIADE_SMOKE=1|2|…` (headless self-checks),
`TRIADE_SHOT=1` (screenshot), `TRIADE_SKIP_GPU_CHECK=1` (UI work on a machine without a dedicated
GPU — never for real use).

Builds for Windows and Linux are produced on a Linux host (wine for the NSIS/portable packaging);
the build machine is configured in `.build.env` (see `.build.env.example`, git-ignored).

## Model

- Default: [mradermacher/Ornith-1.5-9B-uncensored-GGUF](https://huggingface.co/mradermacher/Ornith-1.5-9B-uncensored-GGUF)
  `Q4_K_M` + `mmproj-Q8_0`.
- Architecture `qwen35` (hybrid attention), 32 layers (8 with full attention), 262144 native
  context, vision through `qwen3vl_merger`.
- Quant choice is automatic at runtime: `Q8_0 → Q4_K_M → Q3_K_M → Q2_K` if VRAM is tight.

## Notes and limits

- Windows SmartScreen warnings disappear only with a code-signing certificate; the build pipeline
  is ready for one (`CSC_LINK` / `CSC_KEY_PASSWORD`).
- Public SearXNG instances usually answer with a captcha: set your own instance URL in settings for
  reliable web search.
- Linux packaging is validated; Windows artifacts are produced and staged with wine on the build
  host, so a final smoke test on real Windows hardware is recommended.

## License

MIT for the code. The model has its own license — see the model card of
[junafinity/Ornith-1.5-9B-uncensored](https://huggingface.co/junafinity/Ornith-1.5-9B-uncensored).
