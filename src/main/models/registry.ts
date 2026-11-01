import { getSettings } from '../settings'
import type { CustomModelEntry } from '../../shared/types'

/**
 * Catalogo dei modelli supportati. Per ora l'unico modello è Ornith 1.5 9B
 * (Q4_K_M + mmproj vision); la struttura è già multi-modello: aggiungere una
 * voce qui la rende disponibile nel wizard iniziale, nel download e nella
 * scelta per singola chat.
 */
export interface CatalogModel {
  id: string
  name: string
  vendor: string
  description: string
  architecture: string
  vision: boolean
  audio: boolean
  /** Dimensione complessiva (modello + mmproj) in byte. */
  bytes: number
  recommended?: boolean
  license: string
  files: {
    model: { name: string; url: string }
    mmproj?: { name: string; url: string }
  }
}

// imatrix: i pesi stanno nel repo -i1-GGUF, il mmproj (vision) resta nel repo base
const HF_I1 = 'https://huggingface.co/mradermacher/Ornith-1.5-9B-uncensored-i1-GGUF/resolve/main'
const HF = 'https://huggingface.co/mradermacher/Ornith-1.5-9B-uncensored-GGUF/resolve/main'

export const CATALOG: CatalogModel[] = [
  {
    id: 'ornith-1.5-9b',
    name: 'Ornith 1.5 9B uncensored',
    vendor: 'junafinity / mradermacher',
    description:
      '9B abliterated, architettura qwen35, vision inclusa. Il modello di riferimento del progetto: 5.63 GB + 0.7 GB di mmproj.',
    architecture: 'qwen35',
    vision: true,
    audio: false,
    bytes: 5_629_109_408 + 700_000_000,
    recommended: true,
    license: 'vedi model card junafinity/Ornith-1.5-9B-uncensored',
    files: {
      model: {
        name: 'Ornith-1.5-9B-uncensored.i1-Q4_K_M.gguf',
        url: `${HF_I1}/Ornith-1.5-9B-uncensored.i1-Q4_K_M.gguf`
      },
      mmproj: {
        name: 'Ornith-1.5-9B-uncensored.mmproj-Q8_0.gguf',
        url: `${HF}/Ornith-1.5-9B-uncensored.mmproj-Q8_0.gguf`
      }
    }
  }
]

/** Converte una voce scelta dall'utente (HuggingFace) nel formato del catalogo. */
function fromCustom(c: CustomModelEntry): CatalogModel {
  const base = `https://huggingface.co/${c.repo}/resolve/main/`
  return {
    id: c.id,
    name: `${c.name} · ${c.quant}`,
    vendor: c.repo.split('/')[0] ?? c.repo,
    description: `Scaricato da HuggingFace (${c.repo}), quant ${c.quant}. Verificato: entra in ${c.bytes ? (c.bytes / 1024 ** 3).toFixed(1) : '?'} GB${
      c.vision ? ' e supporta le immagini' : ''
    }.`,
    architecture: 'gguf',
    vision: c.vision,
    audio: false,
    bytes: c.bytes,
    license: 'vedi model card su HuggingFace',
    files: {
      model: { name: c.modelFile, url: `${base}${encodeURI(c.modelFile)}` },
      mmproj: c.mmprojFile ? { name: c.mmprojFile, url: `${base}${encodeURI(c.mmprojFile)}` } : undefined
    }
  }
}

/** Catalogo effettivo: modelli di riferimento + quelli aggiunti dall'utente. */
export function listModels(): CatalogModel[] {
  let custom: CustomModelEntry[] = []
  try {
    custom = getSettings().models.custom ?? []
  } catch {
    custom = []
  }
  return [...CATALOG, ...custom.filter((c) => c.modelFile).map(fromCustom)]
}

export function catalogModel(id: string): CatalogModel {
  const all = listModels()
  return all.find((m) => m.id === id) ?? all[0]
}

export function defaultModelId(): string {
  return CATALOG[0].id
}
