import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_PERSONAS, DEFAULT_SETTINGS, type Settings } from '../shared/types'
import { settingsFile } from './paths'

let cached: Settings | null = null

function merge(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    autoTune: patch.autoTune ?? base.autoTune,
    textScale: patch.textScale ?? base.textScale,
    search: { ...base.search, ...(patch.search ?? {}) },
    asr: { ...base.asr, ...(patch.asr ?? {}) },
    models: {
      ...base.models,
      ...(patch.models ?? {}),
      custom: patch.models?.custom ?? base.models.custom
    },
    onboardingDone: patch.onboardingDone ?? base.onboardingDone,
    gpus: { ...base.gpus, ...(patch.gpus ?? {}) },
    personas:
      Array.isArray(patch.personas) && patch.personas.length === 3
        ? patch.personas
        : base.personas
  }
}

export function getSettings(): Settings {
  if (cached) return cached
  const file = settingsFile()
  let loaded: Settings = DEFAULT_SETTINGS
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>
      loaded = merge(DEFAULT_SETTINGS, raw)
    }
  } catch {
    loaded = DEFAULT_SETTINGS
  }
  // sane defaults requested by the user
  if (!loaded.personas || loaded.personas.length !== 3) loaded.personas = DEFAULT_PERSONAS
  if (!loaded.contextSize || loaded.contextSize < 2048) loaded.contextSize = 65536
  if (!loaded.compressionThreshold) loaded.compressionThreshold = 0.75
  cached = loaded
  return loaded
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = merge(getSettings(), patch)
  const clean = JSON.parse(JSON.stringify(next)) as Settings
  const file = settingsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(clean, null, 2), 'utf8')
  fs.renameSync(`${file}.tmp`, file)
  cached = clean
  return clean
}
