import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'
import { areDefaultPersonas, defaultPersonas } from '../shared/personas'
import { settingsFile } from './paths'
import { safeStorage } from 'electron'

const SECRET_PREFIX = 'enc1:'

/** I campi che non devono mai finire in chiaro su disco. */
function secretPaths(s: Settings): string[][] {
  return [
    ['remote', 'openai', 'apiKey'],
    ['remote', 'anthropic', 'apiKey'],
    ['remote', 'ollama', 'apiKey'],
    ['search', 'braveKey'],
    ['search', 'tavilyKey'],
    ['search', 'googleKey']
  ]
}

function eachSecret(s: Settings): { get: () => string; set: (v: string) => void }[] {
  return secretPaths(s).map(([a, b, c]) => ({
    get: () => {
      const obj = (s as unknown as Record<string, unknown>)[a] as Record<string, unknown>
      const inner = (c ? obj?.[b] : obj) as Record<string, unknown> | undefined
      return String((c ? inner?.[c] : obj?.[b]) ?? '')
    },
    set: (v: string) => {
      const obj = (s as unknown as Record<string, unknown>)[a] as Record<string, unknown>
      if (c) {
        const inner = obj[b] as Record<string, unknown>
        inner[c] = v
      } else {
        obj[b] = v
      }
    }
  }))
}

/** Cifra le chiavi prima di scrivere (se il sistema offre un keystore). */
function encryptSecrets(s: Settings): void {
  let available = false
  try {
    available = safeStorage.isEncryptionAvailable()
  } catch {
    available = false
  }
  if (!available) return
  for (const f of eachSecret(s)) {
    const value = f.get()
    if (!value || value.startsWith(SECRET_PREFIX)) continue
    try {
      f.set(SECRET_PREFIX + safeStorage.encryptString(value).toString('base64'))
    } catch {
      /* se non si può cifrare, si lascia com'è invece di perdere la chiave */
    }
  }
}

/** Decifra al caricamento; i valori in chiaro di vecchie installazioni restano validi. */
function decryptSecrets(s: Settings): void {
  for (const f of eachSecret(s)) {
    const value = f.get()
    if (!value.startsWith(SECRET_PREFIX)) continue
    try {
      f.set(safeStorage.decryptString(Buffer.from(value.slice(SECRET_PREFIX.length), 'base64')))
    } catch {
      f.set('')
    }
  }
}

let cached: Settings | null = null

function merge(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    autoTune: patch.autoTune ?? base.autoTune,
    // derivato da ui.fontScale: il vecchio campo resta solo per compatibilità
    textScale: patch.ui?.fontScale ?? patch.textScale ?? base.ui.fontScale,
    ui: {
      ...base.ui,
      ...(patch.ui ?? {}),
      language: patch.ui?.language ?? base.ui.language,
      fontScale: patch.ui?.fontScale ?? patch.textScale ?? base.ui.fontScale
    },
    search: { ...base.search, ...(patch.search ?? {}) },
    // deep merge: un salvataggio parziale non deve azzerare i campi fratelli
    remote: {
      openai: { ...base.remote.openai, ...(patch.remote?.openai ?? {}) },
      anthropic: { ...base.remote.anthropic, ...(patch.remote?.anthropic ?? {}) },
      ollama: { ...base.remote.ollama, ...(patch.remote?.ollama ?? {}) }
    },
    embeddings: { ...base.embeddings, ...(patch.embeddings ?? {}) },
    updates: { ...base.updates, ...(patch.updates ?? {}) },
    backendByPersona: patch.backendByPersona ?? base.backendByPersona,
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
      let raw: Partial<Settings> = {}
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>
    } catch (err) {
      // file troncato o non JSON: si conserva una copia e si riparte dai default
      try {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      console.error(`[impostazioni] file illeggibile (${(err as Error).message}): uso i default`)
      raw = {}
    }
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
  decryptSecrets(loaded)
  cached = loaded
  return loaded
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const previous = getSettings()
  const next = merge(previous, patch)
  const clean = JSON.parse(JSON.stringify(next)) as Settings
  const toWrite = JSON.parse(JSON.stringify(clean)) as Settings
  encryptSecrets(toWrite)

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

