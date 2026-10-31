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
        name: 'Ornith-1.5-9B-uncensored.Q4_K_M.gguf',
        url: `${HF}/Ornith-1.5-9B-uncensored.Q4_K_M.gguf`
      },
      mmproj: {
        name: 'Ornith-1.5-9B-uncensored.mmproj-Q8_0.gguf',
        url: `${HF}/Ornith-1.5-9B-uncensored.mmproj-Q8_0.gguf`
      }
    }
  }
]

export function catalogModel(id: string): CatalogModel {
  const found = CATALOG.find((m) => m.id === id)
  return found ?? CATALOG[0]
}

export function defaultModelId(): string {
  return CATALOG[0].id
}
