// know-thyself - trageti ingests its own development history and answers
// questions about its own evolution. Runs offline in fixture mode by default;
// set explicit demo provider env vars for live mode.

import 'dotenv/config';
import { TemporalStore, type Assertion } from 'trageti';
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
import {
  resolveLiveEmbeddingProvider,
  resolveLiveExtractionProvider,
  type ResolvedDemoProviders,
} from '../shared/providers.js';
import { generateAssembledAnswer } from '../shared/synthesis.js';
import { buildCustomRetrievalQuery, envWithDemoRateLimit, warmupDemoProviders } from '../shared/cli.js';
import type { ExtractionResult } from '../shared/ingest.js';
import { ensureDemoMetadata, expectedFixtureAssertionIds, ingestEpisodes } from '../shared/runtime.js';
import {
  EMBEDDING_DIMENSION,
  NAMESPACE,
  createDeterministicFixtures,
  createDeterministicSummarizer,
  createCachedLiveSummarizer,
  createFixtureProviders,
  dataVersion,
  defaultQueryTexts,
  deriveHistoryData,
  type HistoryProgress,
  isDefaultFixtureEligible,
  parseKnowThyselfCliOptions,
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
  const providers = resolveProvidersAndDataMode(cli, queryTexts, trace);
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
  printProviderSummary({
    modeLabel: resolvedProviders.modeLabel,
    namespace: NAMESPACE,
    database,
    extractionLabel: resolvedProviders.extractor.label,
    embeddingLabel: resolvedProviders.embedder.label,
    embeddingDimension: EMBEDDING_DIMENSION,
    rateLimitSeconds: cli.rateLimitSeconds,
  });
  logger.detail(`Repository: ${data.repoPath}`);
  logger.detail(`Keyframes: ${data.keyframes.map((k) => k.hash.slice(0, 12)).join(', ')}`);
  ensureDemoMetadata({
    database,
    demoName: 'know-thyself',
    dataVersion: dataVersion({
      repoPath: data.repoPath,
      keyframes: data.keyframes,
      episodes: data.episodes,
      citationSources: data.citationSources,
      queryTexts,
    }),
    providers: resolvedProviders,
    logger,
  });

  logger.step('Opening TemporalStore');
  const store = await TemporalStore.create({
    database,
    namespace: NAMESPACE,
    embeddingDimension: EMBEDDING_DIMENSION,
    embeddingProvider: resolvedProviders.embedder.provider,
  });
  logger.success('TemporalStore is ready');

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

function resolveProvidersAndDataMode(
  cli: ReturnType<typeof parseKnowThyselfCliOptions>,
  queryTexts: readonly string[],
  trace: ReturnType<typeof createLlmTraceOptions>,
): ResolvedDemoProviders {
  const env = envWithDemoRateLimit(process.env, cli.rateLimitSeconds);
  if (isDefaultFixtureEligible(cli) && !hasLiveProviderHints(env)) {
    return {
      modeLabel: 'fixture / derived raw-vector',
      isLive: false,
      // Temporary placeholder; replaced after deterministic fixture generation.
      extractor: {
        name: 'fixture',
        label: 'fixture',
        provenance: { kind: 'fixture', model: 'derived-fixtures', configHash: 'derived-fixtures' },
        extract() {
          return Promise.reject(new Error('fixture provider is initialized after data derivation'));
        },
      },
      embedder: {
        name: 'fixture',
        label: 'fixture / derived hash-vector',
        provenance: {
          kind: 'fixture',
          model: 'derived-hash-vectors',
          dimension: EMBEDDING_DIMENSION,
          configHash: 'derived-hash-vectors',
        },
        provider: {
          name: 'fixture',
          dimension: EMBEDDING_DIMENSION,
          embed() {
            return Promise.reject(new Error('fixture embedder is initialized after data derivation'));
          },
        },
      },
      provenance: {
        extraction: { kind: 'fixture', model: 'derived-fixtures', configHash: 'derived-fixtures' },
        embedding: {
          kind: 'fixture',
          model: 'derived-hash-vectors',
          dimension: EMBEDDING_DIMENSION,
          configHash: 'derived-hash-vectors',
        },
      },
    };
  }

  if (!isDefaultFixtureEligible(cli) && !hasLiveProviderHints(env)) {
    throw new Error(
      'Custom --repo and --keyframes runs require live extraction and live embedding providers.\n' +
        'Set DEMO_EXTRACT_PROVIDER and DEMO_EMBED_PROVIDER with their required model/base URL/key settings.',
    );
  }

  const extractor = resolveLiveExtractionProvider({ env, trace });
  const embedder = resolveLiveEmbeddingProvider({ embeddingDimension: EMBEDDING_DIMENSION, env, trace });
  void queryTexts;
  return {
    modeLabel: `live (${extractor.label} + ${embedder.label})`,
    isLive: true,
    extractor,
    embedder,
    provenance: { extraction: extractor.provenance, embedding: embedder.provenance },
  };
}

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

function hasLiveProviderHints(env: NodeJS.ProcessEnv): boolean {
  const explicitExtract = env['DEMO_EXTRACT_PROVIDER']?.trim();
  const explicitEmbed = env['DEMO_EMBED_PROVIDER']?.trim();
  if (explicitExtract === 'fixture' && explicitEmbed === 'fixture') return false;
  if (explicitExtract && explicitExtract !== 'fixture') return true;
  if (explicitEmbed && explicitEmbed !== 'fixture') return true;
  return Boolean(
    env['ANTHROPIC_API_KEY'] ??
    env['OPENAI_API_KEY'] ??
    env['OPENROUTER_API_KEY'] ??
    env['OLLAMA_HOST'] ??
    env['DEMO_EXTRACT_BASE_URL'] ??
    env['DEMO_EMBED_BASE_URL'],
  );
}
