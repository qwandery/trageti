// Pre-computed embedding vectors for the alex-place skeleton — same shape
// and provenance as know-thyself/data/embeddings.ts. Skeleton vectors are
// produced by a small deterministic hash; regenerate via generate-fixtures.ts
// against a real embedder for semantic ranking.

import { parseExtraction } from '../../shared/parse.js'
import { fixtures } from './fixtures.js'

export const EMBEDDING_DIMENSION = 768

export const QUERY_TEXTS: readonly string[] = [
  'What did Alex know about making sourdough on January 20, 2026?',
  'What does Alex know about making sourdough today?',
  'How has my understanding of sourdough proofing evolved?',
  'What does the literature say about my sourdough acidity?',
  'What would Dad think?',
  'cooking progress',
]

function hashEmbed(text: string): number[] {
  const out = new Array(EMBEDDING_DIMENSION).fill(0) as number[]
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const idx = (c * 31 + i) % EMBEDDING_DIMENSION
    out[idx] = (out[idx] ?? 0) + Math.sin(c * (i + 1)) * 0.1
  }
  let mag = 0
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) mag += (out[i] ?? 0) * (out[i] ?? 0)
  mag = Math.sqrt(mag) || 1
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) out[i] = (out[i] ?? 0) / mag
  return out
}

const _assertionEmbeddings: Record<string, number[]> = {}
for (const episodeId of Object.keys(fixtures)) {
  const raw = fixtures[episodeId]
  if (raw === undefined) continue
  const { assertions } = parseExtraction(raw)
  for (const a of assertions) {
    _assertionEmbeddings[a.id] = hashEmbed(a.content)
  }
}

const _queryEmbeddings: Record<string, number[]> = {}
for (const q of QUERY_TEXTS) {
  _queryEmbeddings[q] = hashEmbed(q)
}

export const assertionEmbeddings: Readonly<Record<string, number[]>> = _assertionEmbeddings
export const queryEmbeddings: Readonly<Record<string, number[]>> = _queryEmbeddings
