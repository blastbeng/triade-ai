import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'
import { areDefaultPersonas, defaultPersonas } from '../shared/personas'
import { settingsFile } from './paths'

let cached: Settings | null = null

function merge(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    autoTune: patch.autoTune ?? base.autoTune,
    textScale: patch.textScale ?? patch.ui?.fontScale ?? base.textScale,
    ui: {
      ...base.ui,
      ...(patch.ui ?? {}),
      language: patch.ui?.language ?? base.ui.language,
      fontScale: patch.ui?.fontScale ?? patch.textScale ?? base.ui.fontScale
    },
    search: { ...base.search, ...(patch.search ?? {}) },
    asr: { ...base.asr, ...(patch.asr ?? {}) },
    models: {
      ...base.models,
      ...(patch.models ?? {}),
      custom: patch.models?.custom ?? base.models.custom
    },
    onboardingDone: patch.onboardingDone ?? base.onboardingDone,
    gpus: { ...base.gpus, ...(patch.gpus ?? {}) },
    personaCount:
      typeof patch.personaCount === 'number'
        ? Math.min(3, Math.max(1, patch.personaCount))
        : base.personaCount,
    personas:
      Array.isArray(patch.personas) && patch.personas.length >= 1 && patch.personas.length <= 3
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
  const count = Math.min(3, Math.max(1, loaded.personaCount ?? 3))
  loaded.personaCount = count
  if (!loaded.personas || loaded.personas.length < 1) {
    loaded.personas = defaultPersonas(loaded.ui?.language ?? 'en', count)
  } else if (areDefaultPersonas(loaded.personas)) {
    // se sono ancora quelle predefinite, system prompt e numero seguono la scelta
    loaded.personas = defaultPersonas(loaded.ui?.language ?? 'en', count)
  }
  if (!loaded.contextSize || loaded.contextSize < 2048) loaded.contextSize = 65536
  if (!loaded.compressionThreshold) loaded.compressionThreshold = 0.75
  cached = loaded
  return loaded
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const previous = getSettings()
  const next = merge(previous, patch)
  const clean = JSON.parse(JSON.stringify(next)) as Settings

  // un array di personalità vuoto o incompleto non deve mai sovrascrivere quelle esistenti
  if (!clean.personas || clean.personas.length !== 3) {
    clean.personas =
      previous.personas?.length === 3
        ? previous.personas
        : defaultPersonas(clean.ui?.language ?? 'en')
  }

  // cambio del numero di personalità: se sono ancora quelle predefinite si rigenerano
  // con il set adatto (1 = assistente singolo, 2-3 = dibattito)
  const count = Math.min(3, Math.max(1, clean.personaCount ?? 3))
  clean.personaCount = count
  const countChanged = count !== (previous.personaCount ?? 3)
  if (countChanged && areDefaultPersonas(clean.personas)) {
    clean.personas = defaultPersonas(clean.ui?.language ?? 'en', count)
  } else if (clean.personas.length < count) {
    const extra = defaultPersonas(clean.ui?.language ?? 'en', count)
    clean.personas = [...clean.personas, ...extra.slice(clean.personas.length)]
  }

  // se l'utente cambia lingua e le personalità sono ancora quelle predefinite,
  // i tre system prompt seguono la nuova lingua (gli id restano stabili)
  const languageChanged =
    patch.ui?.language !== undefined && patch.ui.language !== previous.ui.language
  if (languageChanged && areDefaultPersonas(clean.personas)) {
    clean.personas = defaultPersonas(clean.ui.language)
  }

  const file = settingsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(clean, null, 2), 'utf8')
  fs.renameSync(`${file}.tmp`, file)
  cached = clean
  return clean
}

