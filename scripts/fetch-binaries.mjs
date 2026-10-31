#!/usr/bin/env node
/**
 * Scarica i binari che l'app deve portarsi dietro:
 *  - llama-server con backend Vulkan (Windows/Linux)
 *  - ffmpeg (frame video + audio per whisper)
 *  - whisper.cpp CLI
 *  - modello whisper (ggml-base.bin)
 *
 * Uso: node scripts/fetch-binaries.mjs [--force] [win|linux]
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const LLAMA_BUILD = process.env.LLAMA_BUILD ?? 'b12023'
const ROOT = path.join(import.meta.dirname, '..')
const BIN = path.join(ROOT, 'bin')
const MODELS = path.join(ROOT, 'dati', 'modelli')
const WORK = path.join(ROOT, '.build')

const args = process.argv.slice(2)
const force = args.includes('--force')
const wantCuda = args.includes('--cuda')
const only = args.find((a) => a === 'win' || a === 'linux')

function log(msg) {
  console.log(`\x1b[36m[bin]\x1b[0m ${msg}`)
}

async function download(url, dest) {
  if (fs.existsSync(dest) && !force) {
    log(`già presente: ${path.basename(dest)}`)
    return dest
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  log(`scarico ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} su ${url}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const tmp = `${dest}.part`
  const file = fs.createWriteStream(tmp)
  let done = 0
  let lastPrint = 0
  for await (const chunk of res.body) {
    file.write(chunk)
    done += chunk.length
    if (total && Date.now() - lastPrint > 500) {
      process.stdout.write(`\r  ${((done / total) * 100).toFixed(1)}% (${(done / 1e6).toFixed(0)} MB)`)
      lastPrint = Date.now()
    }
  }
  await new Promise((r) => file.end(r))
  process.stdout.write('\r')
  fs.renameSync(tmp, dest)
  return dest
}

function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true })
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path "${zip}" -DestinationPath "${dest}"`])
  } else {
    execFileSync('unzip', ['-o', '-q', zip, '-d', dest])
  }
}

function untar(tgz, dest) {
  fs.mkdirSync(dest, { recursive: true })
  execFileSync('tar', ['-xf', tgz, '-C', dest])
}

function flatten(dir) {
  // estrae i file dai sottodirectory (llama-bXXXX/) nella radice
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (['stage', 'win', 'linux'].includes(entry.name)) continue
    const sub = path.join(dir, entry.name)
    for (const f of fs.readdirSync(sub)) {
      const from = path.join(sub, f)
      if (fs.statSync(from).isFile()) fs.renameSync(from, path.join(dir, f))
    }
    fs.rmSync(sub, { recursive: true, force: true })
  }
}

/** Trova l'URL di un asset nelle release recenti (i nomi dei file cambiano spesso). */
async function githubAsset(repo, pattern) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=6`, {
    headers: { 'User-Agent': 'triade-ai' }
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  const releases = await res.json()
  for (const rel of releases) {
    for (const asset of rel.assets ?? []) {
      if (pattern.test(asset.name)) return asset.browser_download_url
    }
  }
  throw new Error(`nessun asset che corrisponde a ${pattern} in ${repo}`)
}

function hasNvidiaGpu() {
  try {
    execFileSync('nvidia-smi', ['-L'], { stdio: 'ignore', timeout: 15000 })
    return true
  } catch {
    return false
  }
}

/** Build CUDA: solo su richiesta esplicita e solo se c'è davvero una GPU NVIDIA. */
async function llamaCuda(target) {
  if (!wantCuda) {
    log('CUDA non richiesta (--cuda): nessun download della build CUDA')
    return
  }
  if (!hasNvidiaGpu()) {
    log('nessuna GPU NVIDIA rilevata: salto la build CUDA')
    return
  }
  const dir = path.join(BIN, target, 'cuda')
  const isWin = target === 'win'
  const name = isWin
    ? `llama-${LLAMA_BUILD}-bin-win-cuda-12.4-x64.zip`
    : `llama-${LLAMA_BUILD}-bin-ubuntu-cuda-x64.tar.gz`
  const cudartName = `cudart-llama-bin-win-cuda-12.4-x64.zip`
  fs.mkdirSync(dir, { recursive: true })
  const archive = path.join(BIN, name)
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${name}`
  try {
    await download(url, archive)
  } catch (err) {
    log(`build CUDA non disponibile per ${target}: ${err.message}`)
    return
  }
  if (isWin) {
    unzip(archive, dir)
    const cudart = path.join(BIN, cudartName)
    try {
      await download(
        `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${cudartName}`,
        cudart
      )
      unzip(cudart, dir)
    } catch (err) {
      log(`cudart non scaricato: ${err.message}`)
    }
  } else {
    untar(archive, dir)
  }
  flatten(dir)
  log(`llama-server CUDA pronto in bin/${target}/cuda`)
}

async function llama(target) {
  const dir = path.join(BIN, target)
  const isWin = target === 'win'
  const name = isWin ? `llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip` : `llama-${LLAMA_BUILD}-bin-ubuntu-vulkan-x64.tar.gz`
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${name}`
  const archive = path.join(BIN, name)
  await download(url, archive)
  if (isWin) unzip(archive, dir)
  else untar(archive, dir)
  flatten(dir)
  log(`llama-server pronto in bin/${target}`)
}

async function ffmpeg(target) {
  const dir = path.join(BIN, target)
  fs.mkdirSync(dir, { recursive: true })
  if (target === 'win') {
    const url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
    const zip = path.join(BIN, 'ffmpeg-win.zip')
    await download(url, zip)
    const tmp = path.join(BIN, 'ffmpeg-tmp')
    unzip(zip, tmp)
    for (const entry of fs.readdirSync(tmp)) {
      const inner = path.join(tmp, entry, 'bin')
      if (fs.existsSync(inner)) {
        for (const f of ['ffmpeg.exe', 'ffprobe.exe']) {
          if (fs.existsSync(path.join(inner, f))) fs.copyFileSync(path.join(inner, f), path.join(dir, f))
        }
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  } else {
    const url = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz'
    const archive = path.join(BIN, 'ffmpeg-linux.tar.xz')
    await download(url, archive)
    const tmp = path.join(BIN, 'ffmpeg-tmp')
    untar(archive, tmp)
    const sub = fs.readdirSync(tmp).find((d) => d.startsWith('ffmpeg-'))
    for (const f of ['ffmpeg', 'ffprobe']) {
      fs.copyFileSync(path.join(tmp, sub, f), path.join(dir, f))
      fs.chmodSync(path.join(dir, f), 0o755)
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  log(`ffmpeg pronto in bin/${target}`)
}

async function whisper(target) {
  const dir = path.join(BIN, target)
  fs.mkdirSync(dir, { recursive: true })
  const dirW = path.join(dir, 'whisper')
  fs.mkdirSync(dirW, { recursive: true })
  if (target === 'win') {
    const url = await githubAsset('ggml-org/whisper.cpp', /^whisper-bin-(win-)?x64.*\.zip$/i)
    const zip = path.join(BIN, 'whisper-win.zip')
    await download(url, zip)
    const tmp = path.join(BIN, 'whisper-tmp')
    unzip(zip, tmp)
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/^(whisper-cli|whisper|main)(\.exe)?$|^(ggml.*|whisper.*)\.(dll|so)$|^.*\.dll$/i.test(e.name)) {
          fs.copyFileSync(p, path.join(dirW, e.name))
        }
      }
    }
    walk(tmp)
    fs.rmSync(tmp, { recursive: true, force: true })
  } else {
    // whisper.cpp non pubblica binari Linux: compila fuori da bin/ (le sue libggml
    // non devono mai finire accanto a quelle di llama.cpp: stesse SONAME, versioni diverse)
    const src = path.join(WORK, 'whisper.cpp')
    fs.mkdirSync(WORK, { recursive: true })
    if (!fs.existsSync(src)) {
      execFileSync('git', ['clone', '--depth', '1', 'https://github.com/ggml-org/whisper.cpp', src])
    }
    const build = path.join(src, 'build')
    execFileSync('cmake', ['-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DGGML_VULKAN=1'], { cwd: src })
    execFileSync('cmake', ['--build', build, '-j', String(os.cpus().length), '--target', 'whisper-cli'], { cwd: src })
    fs.copyFileSync(path.join(build, 'bin', 'whisper-cli'), path.join(dirW, 'whisper-cli'))
    fs.chmodSync(path.join(dirW, 'whisper-cli'), 0o755)
    for (const f of fs.readdirSync(path.join(build, 'bin'))) {
      if (f.endsWith('.so') || /\.so\.\d+$/.test(f)) {
        fs.copyFileSync(path.join(build, 'bin', f), path.join(dirW, f))
        fs.chmodSync(path.join(dirW, f), 0o755)
      }
    }
  }
  log(`whisper pronto in bin/${target}`)
}

async function whisperModel() {
  const dest = path.join(MODELS, 'ggml-base.bin')
  await download('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin', dest)
  log('modello whisper pronto in models/ggml-base.bin')
}

const targets = only ? [only] : ['win', 'linux']
await whisperModel()
for (const t of targets) {
  log(`--- ${t} ---`)
  await llama(t)
  await llamaCuda(t)
  await ffmpeg(t)
  await whisper(t)
}
log('fatto')
