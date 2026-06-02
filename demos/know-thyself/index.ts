// know-thyself - trageti ingests its own development history and answers
// questions about its own evolution. Runs offline in fixture mode by default;
// set explicit demo provider env vars for live mode.

import 'dotenv/config';
import { TemporalStore } from 'trageti';
import {
  createDemoTimeline,
  createDemoLogger,
  printBanner,
  printProviderSummary,
  printQueryPlan,
  printRetrievalResult,
  printSnapshot,
  printNarrative,
  printAssembledAnswer,
  createLlmTraceOptions,
} from '../shared/output.js';
import { resolveDemoProviders } from '../shared/providers.js';
import { generateAssembledAnswer } from '../shared/synthesis.js';
import {
  demoDataVersion,
  ensureDemoMetadata,
  expectedFixtureAssertionIds,
  ingestEpisodes,
  runtimeDbPath,
} from '../shared/runtime.js';
import { NAMESPACE, episodes } from './data/episodes.js';
import { fixtures } from './data/fixtures.js';
import { citationSources } from './data/sources.js';
import { EMBEDDING_DIMENSION, QUERY_TEXTS, assertionEmbeddings, queryEmbeddings } from './data/embeddings.js';
import { retrieveQueries, snapshotAtV01 } from './queries.js';
import { generateNarrative } from './narrative.js';

async function main(): Promise<void> {
  const trace = createLlmTraceOptions();
  const providers = resolveDemoProviders({
    fixtures,
    assertionEmbeddings,
    queryEmbeddings,
    queryTexts: QUERY_TEXTS,
    embeddingDimension: EMBEDDING_DIMENSION,
    trace,
  });
  printBanner(`know-thyself - mode: ${providers.modeLabel}`);
  const timeline = createDemoTimeline(episodes);

  const database = runtimeDbPath('know-thyself');
  const logger = createDemoLogger();
  printProviderSummary({
    modeLabel: providers.modeLabel,
    namespace: NAMESPACE,
    database,
    extractionLabel: providers.extractor.label,
    embeddingLabel: providers.embedder.label,
    embeddingDimension: EMBEDDING_DIMENSION,
  });
  ensureDemoMetadata({
    database,
    demoName: 'know-thyself',
    dataVersion: demoDataVersion('know-thyself', episodes, fixtures, assertionEmbeddings, queryEmbeddings, QUERY_TEXTS),
    providers,
    logger,
  });

  logger.step('Opening TemporalStore');
  const store = await TemporalStore.create({
    database,
    namespace: NAMESPACE,
    embeddingDimension: EMBEDDING_DIMENSION,
    embeddingProvider: providers.embedder.provider,
  });
  logger.success('TemporalStore is ready');

  const ingestOptions = {
    store,
    namespace: NAMESPACE,
    episodes,
    citationSources,
    providers,
    logger,
  };
  await ingestEpisodes(
    providers.extractor.provenance.kind === 'fixture'
      ? { ...ingestOptions, expectedFixtureAssertionIds: expectedFixtureAssertionIds(fixtures) }
      : ingestOptions,
  );

  logger.step('Running retrieval queries');
  for (const { annotation, query } of retrieveQueries) {
    printQueryPlan(annotation, query, timeline);
    const result = await store.retrieve(query);
    printRetrievalResult(annotation, query, result, timeline, {
      headerPrinted: true,
      order: 'temporal',
      relevance: { maxResults: 10 },
    });
    printAssembledAnswer(await generateAssembledAnswer({ store, extractor: providers.extractor, annotation, query }));
  }

  logger.step('Running temporal snapshot query');
  const snapshot = await store.getTemporalSnapshot(snapshotAtV01.options);
  printSnapshot(`Query ${snapshotAtV01.annotation}`, snapshot, { timeline });

  logger.step('Assembling context and generating narrative');
  const narrative = await generateNarrative(store, providers.extractor);
  printNarrative(narrative);

  logger.step('Closing TemporalStore');
  await store.close();
  logger.success('Demo complete');
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
