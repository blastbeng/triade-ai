/**
 * Embedding locale leggero: vettori hashed di token + trigrammi di carattere,
 * pesati TF-IDF e normalizzati. Nessun modello da caricare, nessuna dipendenza
 * nativa: la ricerca semantica resta deterministica e offline.
 */
export const DIM = 768

const STOPWORDS = new Set(
  (
    'il lo la i gli le un uno una di a da in con su per tra fra del della dei delle degli al alla ' +
    'ai alle agli dal dalla dai dalle nel nella nei nelle sul sulla sui sulle e ed o od ma se che ' +
    'chi cui non piu più molto come dove quando perche perché anche cosi così questo questa questi ' +
    'queste quello quella quelli quelle si no ne ci vi mi ti lo sia sono essere stato stata fatto ' +
    'the and for with that this from are was were will can you your our their his her its not but'
  ).split(/\s+/)
)

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenize(text: string): string[] {
  return normalize(text)
    .split(' ')
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function accumulate(vec: Float32Array, key: string, weight: number): void {
  const idx = fnv1a(key) % DIM
  vec[idx] += weight
  // segno dal secondo hash: riduce le collisioni sistematiche
  if (fnv1a(`#${key}`) % 2 === 0) vec[idx] *= -1
}

/** Vettore TF (sublineare) + trigrammi di carattere per robustezza morfologica. */
export function embed(text: string): Float32Array {
  const vec = new Float32Array(DIM)
  const tokens = tokenize(text)
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  for (const [token, count] of tf) {
    accumulate(vec, token, 1 + Math.log(count))
    if (token.length >= 6) {
      for (let i = 0; i + 3 <= token.length; i += 2) {
        accumulate(vec, `3:${token.slice(i, i + 3)}`, 0.35)
      }
    }
  }
  let norm = 0
  for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < DIM; i++) vec[i] /= norm
  return vec
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < DIM; i++) dot += a[i] * b[i]
  return dot
}
