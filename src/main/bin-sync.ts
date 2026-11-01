import fs from 'node:fs'
import path from 'node:path'

/**
 * Confronto fra i binari inclusi nel pacchetto e quelli in `dati/bin`.
 *
 * Perché non un timbro con mtime: `copyFileSync` non conserva il mtime, quindi
 * un timbro calcolato sulla sorgente non combacia mai con la copia e l'app
 * ricopierebbe ~200 MB a ogni avvio. Qui si confrontano **percorsi e
 * dimensioni**: basta a scoprire l'unico caso che rompe l'avvio su Windows
 * (0xC0000139), cioè una DLL sostituita da quella di un'altra build o un file
 * estraneo lasciato da una release precedente.
 *
 * Modulo puro (niente Electron): così è verificabile dai test.
 */

/** File di un'altra build (whisper.cpp, CUDA) che non devono stare nella radice di llama.cpp. */
const FOREIGN_BUILD =
  /^(whisper|whisper-cli|main|parakeet|SDL2)(\.(exe|dll))?$|^ggml-cuda|^ggml-cpu\.dll$/i

/** Mappa percorso relativo (con `/`) → dimensione in byte di tutti i file, sottocartelle comprese. */
export function scanBinaries(dir: string): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (rel: string): void => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const next = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(next)
        continue
      }
      // file di stato (`.stamp`, `.llama-files.json`) non fanno parte dei binari
      if (e.name.startsWith('.')) continue
      try {
        out.set(next, fs.statSync(path.join(dir, next)).size)
      } catch {
        /* sparito durante la scansione */
      }
    }
  }
  walk('')
  return out
}

export interface SyncPlan {
  /** true se `dati/bin` non corrisponde al pacchetto e va riallineato */
  needed: boolean
  /** file del pacchetto che mancano in `dati/bin` */
  missing: string[]
  /** file presenti in entrambi ma con dimensione diversa (DLL sovrascritta) */
  changed: string[]
  /** file in `dati/bin` che non sono nel pacchetto (residui, altre build) */
  extra: string[]
}

export function planBinarySync(
  source: Map<string, number>,
  target: Map<string, number>
): SyncPlan {
  const missing: string[] = []
  const changed: string[] = []
  const extra: string[] = []
  for (const [name, size] of source) {
    const have = target.get(name)
    if (have === undefined) missing.push(name)
    else if (have !== size) changed.push(name)
  }
  for (const name of target.keys()) if (!source.has(name)) extra.push(name)
  return {
    needed: missing.length > 0 || changed.length > 0 || extra.length > 0,
    missing: missing.sort(),
    changed: changed.sort(),
    extra: extra.sort()
  }
}

/** Nomi che appartengono a un'altra build finiti nella radice di llama.cpp. */
export function foreignBinaries(names: Iterable<string>): string[] {
  return [...names].filter((n) => FOREIGN_BUILD.test(n)).sort()
}

/** Righe leggibili (max `limit` voci) per il log dell'app. */
export function describeSync(plan: SyncPlan, limit = 6): string {
  const parts: string[] = []
  const list = (label: string, names: string[]): void => {
    if (!names.length) return
    const shown = names.slice(0, limit).join(', ')
    parts.push(`${label}: ${shown}${names.length > limit ? ` (+${names.length - limit})` : ''}`)
  }
  list('mancanti', plan.missing)
  list('sovrascritti', plan.changed)
  list('estranei', plan.extra)
  return parts.join(' · ')
}
