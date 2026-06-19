import type { TragetiStore } from 'trageti';
import {
  PREPARED_ARTIFACT_VERSION,
  type PreparedDemoArtifact,
  type PreparedIngestionUnit,
} from '../shared/artifacts.js';
import { buildCustomRetrievalQuery, warmupDemoProviders } from '../shared/cli.js';
import type { DemoScenario, DemoScenarioContext } from '../shared/demo-runner.js';
import {
  createDemoTimeline,
  printAssembledAnswer,
  printNarrative,
  printQueryPlan,
  printRetrievalResult,
  printSnapshot,
} from '../shared/output.js';
import { expectedFixtureAssertionIds } from '../shared/runtime.js';
import { generateAssembledAnswer } from '../shared/synthesis.js';
import {
  NAMESPACE,
  createCachedLiveSummarizer,
  createDeterministicFixtures,
  createDeterministicSummarizer,
  createFixtureProviders,
  dataVersion,
  defaultQueryTexts,
  deriveHistoryData,
  parseKnowThyselfCliOptions,
  resolveProvidersAndDataMode,
  resolveRepoPath,
  runHash,
  runtimeDatabasePath,
  sanitizeRepositoryExtractionResult,
  type DerivedHistoryData,
  type HistoryProgress,
} from './history.js';
import { buildInitialSnapshot, buildRetrieveQueries } from './queries.js';
import { generateNarrative } from './narrative.js';
import type { ResolvedDemoProviders } from '../shared/providers.js';

interface KnowArtifactMetadata {
  repoPath: string;
  keyframes: DerivedHistoryData['keyframes'];
  latestPosition: number;
  initialPosition: number;
  queryTexts: string[];
  fixtureData?: ReturnType<typeof createDeterministicFixtures>;
}

export const knowThyselfScenario: DemoScenario = {
  name: 'know-thyself',
  title: 'know-thyself',
  namespace: NAMESPACE,
  async prepare(context) {
    const cli = parseKnowThyselfCliOptions([...context.argv]);
    const queryTexts = cli.query ? [...defaultQueryTexts(), cli.query] : [...defaultQueryTexts()];
    const providers = resolveProvidersAndDataMode(cli, context.trace);
    if (cli.warmup) await warmupDemoProviders({ providers, logger: context.logger });
    context.logger.detail(`Repository: ${resolveRepoPath(cli.repo)}`);
    context.logger.detail(`Keyframe refs: ${cli.keyframes.map(formatKeyframeRef).join(', ')}`);
    context.logger.detail(
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
              resilience: { logger: context.logger },
            }),
      mode: providers.extractor.provenance.kind === 'fixture' ? 'fixture' : 'live',
      progress: progressLogger(context.logger),
    });
    const fixtureData =
      providers.extractor.provenance.kind === 'fixture' ? createDeterministicFixtures(data, queryTexts) : undefined;
    const units = data.episodes.map((episode): PreparedIngestionUnit => {
      const sourceRef = sourceRefFromEpisode(episode.content);
      const source = data.citationSources[sourceRef];
      if (source === undefined) throw new Error(`missing prepared source ${sourceRef}`);
      return {
        id: episode.id,
        episode,
        document: episode.content,
        citationSources: { [sourceRef]: source },
        metadata: { sourceRef },
      };
    });
    const metadata: KnowArtifactMetadata = {
      repoPath: data.repoPath,
      keyframes: data.keyframes,
      latestPosition: data.latestPosition,
      initialPosition: data.initialPosition,
      queryTexts: [...queryTexts],
      ...(fixtureData !== undefined ? { fixtureData } : {}),
    };
    return {
      artifactVersion: PREPARED_ARTIFACT_VERSION,
      scenario: 'know-thyself',
      namespace: NAMESPACE,
      preparedAt: new Date().toISOString(),
      dataVersion: dataVersion({
        repoPath: data.repoPath,
        keyframes: data.keyframes,
        episodes: data.episodes,
        citationSources: data.citationSources,
        queryTexts,
      }),
      units,
      metadata: metadata as unknown as Record<string, unknown>,
    };
  },
  resolveProviders(context, artifact) {
    const cli = parseKnowThyselfCliOptions([...context.argv]);
    const metadata = knowMetadata(artifact);
    if (metadata.fixtureData !== undefined) {
      if (cli.query && !metadata.queryTexts.includes(cli.query)) {
        throw new Error(
          'This prepared fixture artifact does not include an embedding for the requested custom query. Run prepare again with the same --query, or use a live embedding provider.',
        );
      }
      return createFixtureProviders({ ...metadata.fixtureData, queryTexts: metadata.queryTexts });
    }
    return resolveProvidersAndDataMode(cli, context.trace);
  },
  databasePath(_context, artifact, providers) {
    const metadata = knowMetadata(artifact);
    return runtimeDatabasePath(
      runHash({
        repoPath: metadata.repoPath,
        keyframes: metadata.keyframes,
        providers,
        queryTexts: metadata.queryTexts,
      }),
    );
  },
  expectedFixtureAssertionIds(artifact, providers) {
    const metadata = knowMetadata(artifact);
    return providers.extractor.provenance.kind === 'fixture' && metadata.fixtureData !== undefined
      ? expectedFixtureAssertionIds(metadata.fixtureData.fixtures)
      : undefined;
  },
  sanitizeExtractionResult(result, context) {
    return sanitizeRepositoryExtractionResult(result, context.existingAssertions);
  },
  async retrieve(context, artifact, providers, store) {
    await retrieveKnowThyself(context, artifact, providers, store);
  },
};

async function retrieveKnowThyself(
  context: DemoScenarioContext,
  artifact: PreparedDemoArtifact,
  providers: ResolvedDemoProviders,
  store: TragetiStore,
): Promise<void> {
  const cli = parseKnowThyselfCliOptions([...context.argv]);
  const metadata = knowMetadata(artifact);
  const timeline = createDemoTimeline(artifact.units.map((unit) => unit.episode));

  if (cli.query) {
    context.logger.step('Running custom user query');
    const query = buildCustomRetrievalQuery({
      namespace: NAMESPACE,
      queryText: cli.query,
      temporalAnchor: metadata.latestPosition,
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
      await generateAssembledAnswer({
        store,
        extractor: providers.extractor,
        annotation,
        query,
        logger: context.logger,
      }),
    );
    return;
  }

  context.logger.step('Running retrieval queries');
  for (const { annotation, query } of buildRetrieveQueries(metadata.latestPosition)) {
    printQueryPlan(annotation, query, timeline);
    const result = await store.retrieve(query);
    printRetrievalResult(annotation, query, result, timeline, {
      headerPrinted: true,
      order: 'temporal',
      relevance: { maxResults: 10 },
    });
    printAssembledAnswer(
      await generateAssembledAnswer({
        store,
        extractor: providers.extractor,
        annotation,
        query,
        logger: context.logger,
      }),
    );
  }

  context.logger.step('Running temporal snapshot query');
  const snapshotAtInitial = buildInitialSnapshot(metadata.initialPosition);
  const snapshot = await store.getTemporalSnapshot(snapshotAtInitial.options);
  printSnapshot(`Query ${snapshotAtInitial.annotation}`, snapshot, { timeline });

  context.logger.step('Assembling context and generating narrative');
  printNarrative(await generateNarrative(store, providers.extractor, metadata.latestPosition, context.logger));
}

function knowMetadata(artifact: PreparedDemoArtifact): KnowArtifactMetadata {
  return artifact.metadata as unknown as KnowArtifactMetadata;
}

function sourceRefFromEpisode(content: string): string {
  const match = /Source document:\s+(sources\/\S+?\.md)/.exec(content);
  if (!match?.[1]) throw new Error(`episode content does not name a source document: ${content}`);
  return match[1];
}

function progressLogger(logger: DemoScenarioContext['logger']): HistoryProgress {
  return {
    start(event) {
      logger.detail(`Resolved ${String(event.keyframeCount)} keyframe ref(s) from ${event.repoPath}`);
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

function formatKeyframeRef(ref: string): string {
  return /^[0-9a-f]{20,}$/i.test(ref) ? ref.slice(0, 12) : ref;
}
