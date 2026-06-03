// know-thyself - trageti ingests its own development history and answers
// questions about its own evolution. Runs offline in fixture mode by default;
// set explicit demo provider env vars for live mode.

import 'dotenv/config';
import type { Assertion } from 'trageti';
import {
  createDemoTimeline,
  createDemoLogger,
  printBanner,
  printResolvedProviderSummary,
  printQueryPlan,
  printRetrievalResult,
  printSnapshot,
  printNarrative,
  printAssembledAnswer,
  createLlmTraceOptions,
} from '../shared/output.js';
import { generateAssembledAnswer } from '../shared/synthesis.js';
import { buildCustomRetrievalQuery, warmupDemoProviders } from '../shared/cli.js';
import type { ExtractionResult } from '../shared/ingest.js';
import { expectedFixtureAssertionIds, ingestEpisodes, prepareDemoStore } from '../shared/runtime.js';
import {
  NAMESPACE,
  createDeterministicFixtures,
  createDeterministicSummarizer,
  createCachedLiveSummarizer,
  createFixtureProviders,
  dataVersion,
  defaultQueryTexts,
  deriveHistoryData,
  type HistoryProgress,
  parseKnowThyselfCliOptions,
  resolveProvidersAndDataMode,
  resolveRepoPath,
  runHash,
  runtimeDatabasePath,
  sanitizeRepositoryExtractionResult,
} from './history.js';
import { buildInitialSnapshot, buildRetrieveQueries } from './queries.js';
import { generateNarrative } from './narrative.js';

async function main(): Promise<void> {
  const cli = parseKnowThyselfCliOptions();
  const trace = createLlmTraceOptions();
  const queryTexts = cli.query ? [...defaultQueryTexts(), cli.query] : [...defaultQueryTexts()];
  const providers = resolveProvidersAndDataMode(cli, trace);
  const initialLogger = createDemoLogger();
  printBanner(`know-thyself - mode: ${providers.modeLabel}`);
  if (cli.warmup) await warmupDemoProviders({ providers, logger: initialLogger });
  initialLogger.step('Preparing repository history source data');
  initialLogger.detail(`Repository: ${resolveRepoPath(cli.repo)}`);
  initialLogger.detail(`Keyframe refs: ${cli.keyframes.map((ref) => ref.slice(0, 12)).join(', ')}`);
  initialLogger.detail(
    providers.extractor.provenance.kind === 'fixture'
      ? 'Source summaries: deterministic fixture summaries'
      : `Source summaries: live extraction via ${providers.extractor.label}; cached summaries are reused when available`,
  );
  const data = await deriveHistoryData({
    repoPath: cli.repo,
    keyframeRefs: cli.keyframes,
    summarizer:
      providers.extractor.provenance.kind === 'fixture'
        ? createDeterministicSummarizer()
        : createCachedLiveSummarizer({
            extractor: providers.extractor,
            repoPath: resolveRepoPath(cli.repo),
          }),
    mode: providers.extractor.provenance.kind === 'fixture' ? 'fixture' : 'live',
    progress: progressLogger(initialLogger),
  });
  const fixtureData =
    providers.extractor.provenance.kind === 'fixture' ? createDeterministicFixtures(data, queryTexts) : undefined;

  const resolvedProviders =
    fixtureData !== undefined
      ? createFixtureProviders({
          fixtures: fixtureData.fixtures,
          assertionEmbeddings: fixtureData.assertionEmbeddings,
          queryEmbeddings: fixtureData.queryEmbeddings,
          queryTexts,
        })
      : providers;

  const timeline = createDemoTimeline(data.episodes);

  const hash = runHash({
    repoPath: data.repoPath,
    keyframes: data.keyframes,
    providers: resolvedProviders,
    queryTexts,
  });
  const database = runtimeDatabasePath(hash);
  const logger = initialLogger;
  printResolvedProviderSummary({
    providers: resolvedProviders,
    namespace: NAMESPACE,
    database,
    rateLimitSeconds: cli.rateLimitSeconds,
  });
  logger.detail(`Repository: ${data.repoPath}`);
  logger.detail(`Keyframes: ${data.keyframes.map((k) => k.hash.slice(0, 12)).join(', ')}`);
  const store = await prepareDemoStore({
    database,
    demoName: 'know-thyself',
    dataVersion: dataVersion({
      repoPath: data.repoPath,
      keyframes: data.keyframes,
      episodes: data.episodes,
      citationSources: data.citationSources,
      queryTexts,
    }),
    namespace: NAMESPACE,
    providers: resolvedProviders,
    logger,
  });

  const ingestOptions = {
    store,
    namespace: NAMESPACE,
    episodes: data.episodes,
    citationSources: data.citationSources,
    providers: resolvedProviders,
    sanitizeExtractionResult: (result: ExtractionResult, context: { existingAssertions: readonly Assertion[] }) =>
      sanitizeRepositoryExtractionResult(result, context.existingAssertions),
    logger,
    trace,
  };
  await ingestEpisodes(
    fixtureData !== undefined
      ? { ...ingestOptions, expectedFixtureAssertionIds: expectedFixtureAssertionIds(fixtureData.fixtures) }
      : ingestOptions,
  );

  if (cli.query) {
    logger.step('Running custom user query');
    const query = buildCustomRetrievalQuery({
      namespace: NAMESPACE,
      queryText: cli.query,
      temporalAnchor: data.latestPosition,
    });
    const annotation = '"User query" (custom)';
    printQueryPlan(annotation, query, timeline);
    const result = await store.retrieve(query);
    printRetrievalResult(annotation, query, result, timeline, {
      headerPrinted: true,
      order: 'temporal',
      relevance: { maxResults: 10 },
    });
    printAssembledAnswer(
      await generateAssembledAnswer({ store, extractor: resolvedProviders.extractor, annotation, query }),
    );

    logger.step('Closing TemporalStore');
    await store.close();
    logger.success('Demo complete');
    return;
  }

  logger.step('Running retrieval queries');
  const retrieveQueries = buildRetrieveQueries(data.latestPosition);
  for (const { annotation, query } of retrieveQueries) {
    printQueryPlan(annotation, query, timeline);
    const result = await store.retrieve(query);
    printRetrievalResult(annotation, query, result, timeline, {
      headerPrinted: true,
      order: 'temporal',
      relevance: { maxResults: 10 },
    });
    printAssembledAnswer(
      await generateAssembledAnswer({ store, extractor: resolvedProviders.extractor, annotation, query }),
    );
  }

  logger.step('Running temporal snapshot query');
  const snapshotAtInitial = buildInitialSnapshot(data.initialPosition);
  const snapshot = await store.getTemporalSnapshot(snapshotAtInitial.options);
  printSnapshot(`Query ${snapshotAtInitial.annotation}`, snapshot, { timeline });

  logger.step('Assembling context and generating narrative');
  const narrative = await generateNarrative(store, resolvedProviders.extractor, data.latestPosition);
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

function progressLogger(logger: ReturnType<typeof createDemoLogger>): HistoryProgress {
  return {
    start(event) {
      logger.detail(`Resolved ${String(event.keyframeCount)} keyframe commit(s) from ${event.repoPath}`);
    },
    keyframeStart(event) {
      logger.detail(
        `Building ${event.sourceRef} from keyframe ${String(event.position)} (${event.mode}; ${event.label})`,
      );
    },
    keyframeDone(event) {
      logger.detail(`  ${event.cached ? 'Reused cached summary for' : 'Completed source bundle'} ${event.sourceRef}`);
    },
  };
}
