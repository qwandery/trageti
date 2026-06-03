// Pre-computed embedding vectors for alex-place. Fixture vectors are produced
// by a small deterministic hash; regenerate via generate-fixtures.ts against a
// real embedder for semantic ranking.

import { parseExtraction } from '../../shared/parse.js';
import { fixtures } from './fixtures.js';

export const EMBEDDING_DIMENSION = 768;

export const QUERY_TEXTS: readonly string[] = [
  'What did Alex know about making sourdough on December 20, 2025?',
  'What does Alex know about making sourdough today?',
  'How has my understanding of sourdough proofing evolved?',
  "How has Alex's ramen broth knowledge changed?",
  'What did Alex learn from dinner feedback?',
  'What does Alex know about knife skills and safe cutting?',
  'What has Alex learned about gluten-free sourdough?',
  'What questions or contradictions are still unresolved?',
  'What has Mrs. Park taught Alex?',
  'What does the literature say about sourdough acidity and fermentation schedule?',
  'What would Dad think?',
  'cooking progress',
];

function hashEmbed(text: string): number[] {
  const out = new Array(EMBEDDING_DIMENSION).fill(0) as number[];
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    addFeature(out, tokens[i] ?? '', 1);
    if (i + 1 < tokens.length) addFeature(out, `${tokens[i]} ${tokens[i + 1]}`, 0.5);
  }
  let mag = 0;
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) mag += (out[i] ?? 0) * (out[i] ?? 0);
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) out[i] = (out[i] ?? 0) / mag;
  return out;
}

function addFeature(out: number[], feature: string, weight: number): void {
  let hash = 2166136261;
  for (let i = 0; i < feature.length; i++) {
    hash ^= feature.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const idx = Math.abs(hash) % EMBEDDING_DIMENSION;
  out[idx] = (out[idx] ?? 0) + weight;
}

const _assertionEmbeddings: Record<string, number[]> = {};
for (const episodeId of Object.keys(fixtures)) {
  const raw = fixtures[episodeId];
  if (raw === undefined) continue;
  const { assertions } = parseExtraction(raw);
  for (const a of assertions) {
    _assertionEmbeddings[a.id] = hashEmbed(a.content);
  }
}

const _queryEmbeddings: Record<string, number[]> = {};
for (const q of QUERY_TEXTS) {
  _queryEmbeddings[q] = hashEmbed(q);
}

export const assertionEmbeddings: Readonly<Record<string, number[]>> = _assertionEmbeddings;
export const queryEmbeddings: Readonly<Record<string, number[]>> = _queryEmbeddings;
