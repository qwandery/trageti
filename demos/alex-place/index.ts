// alex-place - Alex's cooking journal as a temporal RAG corpus. Runs offline
// in fixture mode by default; set explicit demo provider env vars for live mode.

import 'dotenv/config';
import { TemporalStore, type RetrievedAssertion } from 'trageti';
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
  assertCustomQuerySupported,
  buildCustomRetrievalQuery,
  envWithDemoRateLimit,
  parseDemoCliOptions,
} from '../shared/cli.js';
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
import { retrieveQueries, literatureSemanticQuery, dadSemanticQuery } from './queries.js';
import { generateNarrative } from './narrative.js';

async function main(): Promise<void> {
  const cli = parseDemoCliOptions();
  const trace = createLlmTraceOptions();
  const providers = resolveDemoProviders({
    fixtures,
    assertionEmbeddings,
    queryEmbeddings,
    queryTexts: QUERY_TEXTS,
    embeddingDimension: EMBEDDING_DIMENSION,
    env: envWithDemoRateLimit(process.env, cli.rateLimitSeconds),
    trace,
  });
  if (cli.query) assertCustomQuerySupported(providers.embedder);
  printBanner(`alex-place - mode: ${providers.modeLabel}`);
  const timeline = createDemoTimeline(episodes);

  const database = runtimeDbPath('alex-place');
  const logger = createDemoLogger();
  printProviderSummary({
    modeLabel: providers.modeLabel,
    namespace: NAMESPACE,
    database,
    extractionLabel: providers.extractor.label,
    embeddingLabel: providers.embedder.label,
    embeddingDimension: EMBEDDING_DIMENSION,
    rateLimitSeconds: cli.rateLimitSeconds,
  });
  ensureDemoMetadata({
    database,
    demoName: 'alex-place',
    dataVersion: demoDataVersion('alex-place', episodes, fixtures, assertionEmbeddings, queryEmbeddings, QUERY_TEXTS),
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
    trace,
  };
  await ingestEpisodes(
    providers.extractor.provenance.kind === 'fixture'
      ? { ...ingestOptions, expectedFixtureAssertionIds: expectedFixtureAssertionIds(fixtures) }
      : ingestOptions,
  );

  if (cli.query) {
    logger.step('Running custom user query');
    const query = buildCustomRetrievalQuery({
      namespace: NAMESPACE,
      queryText: cli.query,
      temporalAnchor: 20,
    });
    const annotation = '"User query" (custom)';
    printQueryPlan(annotation, query, timeline);
    const result = await store.retrieve(query);
    printRetrievalResult(annotation, query, result, timeline, {
      headerPrinted: true,
      order: 'temporal',
      relevance: { maxResults: 14 },
    });
    printAssembledAnswer(await generateAssembledAnswer({ store, extractor: providers.extractor, annotation, query }));

    logger.step('Closing TemporalStore');
    await store.close();
    logger.success('Demo complete');
    return;
  }

  logger.step('Running retrieval queries');
  for (const { annotation, query } of retrieveQueries) {
    printQueryPlan(annotation, query, timeline);
    const result = await store.retrieve(query);
    printRetrievalResult(annotation, query, result, timeline, {
      headerPrinted: true,
      order: 'temporal',
      relevance: { maxResults: 14 },
    });
    printAssembledAnswer(await generateAssembledAnswer({ store, extractor: providers.extractor, annotation, query }));
  }

  logger.step('Running graph-expanded literature query');
  printQueryPlan(literatureSemanticQuery.annotation, literatureSemanticQuery.query, timeline);
  const literatureResult = await store.retrieve(literatureSemanticQuery.query);
  printRetrievalResult(literatureSemanticQuery.annotation, literatureSemanticQuery.query, literatureResult, timeline, {
    headerPrinted: true,
    order: 'temporal',
    relevance: { maxResults: 10 },
  });
  printAssembledAnswer(
    await generateAssembledAnswer({
      store,
      extractor: providers.extractor,
      annotation: literatureSemanticQuery.annotation,
      query: literatureSemanticQuery.query,
    }),
  );

  logger.step('Running entity history query');
  printQueryPlan(dadSemanticQuery.annotation, dadSemanticQuery.query, timeline);
  const dadSemanticResult = await store.retrieve(dadSemanticQuery.query);
  printRetrievalResult(dadSemanticQuery.annotation, dadSemanticQuery.query, dadSemanticResult, timeline, {
    headerPrinted: true,
    order: 'temporal',
    relevance: { maxResults: 8 },
  });
  printAssembledAnswer(
    await generateAssembledAnswer({
      store,
      extractor: providers.extractor,
      annotation: dadSemanticQuery.annotation,
      query: dadSemanticQuery.query,
    }),
  );

  const dadEntityId = firstEntityId(dadSemanticResult.results, 'alex-father');
  if (dadEntityId) {
    const dadHistory = await store.getEntityHistory(NAMESPACE, dadEntityId);
    printSnapshot(`Query "What would Dad think?" (entity history for retrieved entity "${dadEntityId}")`, dadHistory, {
      timeline,
      emptyMessage: `No entity-history assertions were returned for entityId "${dadEntityId}", even though semantic retrieval surfaced it.`,
    });
  } else {
    printSnapshot('Query "What would Dad think?" (entity history)', [], {
      timeline,
      emptyMessage:
        'Semantic retrieval did not surface a stored entity ID for this subject, so there is no entity-history lookup to run.',
    });
  }

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

function firstEntityId(results: readonly RetrievedAssertion[], preferredEntityId?: string): string | null {
  if (preferredEntityId && results.some((result) => result.entityId === preferredEntityId)) return preferredEntityId;
  if (preferredEntityId) return null;
  for (const result of results) {
    if (result.entityId) return result.entityId;
  }
  return null;
}
