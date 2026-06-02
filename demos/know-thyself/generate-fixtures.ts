// Functional reference: derive repo history episodes, run live extraction over
// them, and embed assertion/query text. Writes review files under demos/.local.
//
// Usage: npx tsx demos/know-thyself/generate-fixtures.ts [--repo PATH] [--keyframes a,b,c]

import 'dotenv/config';
import { generateFixtureFiles } from '../shared/generate-fixtures.js';
import { createLlmTraceOptions } from '../shared/output.js';
import { resolveLiveEmbeddingProvider, resolveLiveExtractionProvider } from '../shared/providers.js';
import {
  EMBEDDING_DIMENSION,
  createLiveSummarizer,
  defaultQueryTexts,
  deriveHistoryData,
  parseKnowThyselfCliOptions,
} from './history.js';

async function main(): Promise<void> {
  const cli = parseKnowThyselfCliOptions();
  const trace = createLlmTraceOptions();
  const extractor = resolveLiveExtractionProvider({ trace });
  const embedder = resolveLiveEmbeddingProvider({ embeddingDimension: EMBEDDING_DIMENSION, trace }).provider;
  const data = await deriveHistoryData({
    repoPath: cli.repo,
    keyframeRefs: cli.keyframes,
    summarizer: createLiveSummarizer(extractor),
  });

  await generateFixtureFiles({
    demoName: 'know-thyself',
    episodes: data.episodes,
    citationSources: data.citationSources,
    queryTexts: cli.query ? [...defaultQueryTexts(), cli.query] : defaultQueryTexts(),
    embeddingDimension: EMBEDDING_DIMENSION,
    extractor,
    embedder,
    writeCommitted: false,
    committedFixturesPath: 'unused-know-thyself-fixtures.ts',
    committedEmbeddingsPath: 'unused-know-thyself-embeddings.ts',
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
