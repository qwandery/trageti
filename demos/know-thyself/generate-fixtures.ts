// Functional reference: run extraction over committed episodes via a live
// extractor, then embed every assertion content + query text via a live embedder.
//
// Usage: npx tsx demos/know-thyself/generate-fixtures.ts [--write]

import 'dotenv/config';
import { generateFixtureFiles } from '../shared/generate-fixtures.js';
import { resolveLiveEmbeddingProvider, resolveLiveExtractionProvider } from '../shared/providers.js';
import { createLlmTraceOptions } from '../shared/output.js';
import { episodes } from './data/episodes.js';
import { citationSources } from './data/sources.js';
import { QUERY_TEXTS, EMBEDDING_DIMENSION } from './data/embeddings.js';

async function main(): Promise<void> {
  const trace = createLlmTraceOptions();
  const extractor = resolveLiveExtractionProvider({ trace });
  const embedder = resolveLiveEmbeddingProvider({ embeddingDimension: EMBEDDING_DIMENSION, trace }).provider;

  await generateFixtureFiles({
    demoName: 'know-thyself',
    episodes,
    citationSources,
    queryTexts: QUERY_TEXTS,
    embeddingDimension: EMBEDDING_DIMENSION,
    extractor,
    embedder,
    writeCommitted: process.argv.includes('--write'),
    committedFixturesPath: 'demos/know-thyself/data/fixtures.ts',
    committedEmbeddingsPath: 'demos/know-thyself/data/embeddings.ts',
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
