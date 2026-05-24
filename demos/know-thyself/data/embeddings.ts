// Pre-computed embedding vectors for the skeleton smoke test.
//
// Spec contract: assertionEmbeddings maps assertion ID to a number[]; we also
// export queryEmbeddings keyed by query text because RawVectorProvider is
// text-keyed and needs query texts pre-registered too. See plan §"Spec
// Conformance Notes — embeddings.ts shape."
//
// Skeleton vectors are NOT semantically meaningful — they come from a small
// deterministic hash and exist only to drive the pipeline offline. Regenerate
// via `npx tsx demos/know-thyself/generate-fixtures.ts` against a real
// embedder for meaningful semantic ranking.

import { parseExtraction } from '../../shared/parse.js'
import { fixtures } from './fixtures.js'

export const EMBEDDING_DIMENSION = 768

// Hand-mirrored from queries.ts. Runtime guard in index.ts throws if any
// query text is missing from queryEmbeddings, catching drift.
export const QUERY_TEXTS: readonly string[] = [
  'What is the current scoring formula?',
  'How did the temporal model evolve?',
  'How does the library handle data integrity?',
]

function hashEmbed(text: string): number[] {
  const out = new Array(EMBEDDING_DIMENSION).fill(0) as number[]
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const idx = (c * 31 + i) % EMBEDDING_DIMENSION
    out[idx] = (out[idx] ?? 0) + Math.sin(c * (i + 1)) * 0.1
  }
  // L2-normalize so cosine distance is well-behaved.
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
