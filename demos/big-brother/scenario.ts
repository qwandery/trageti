import type { TemporalStore } from 'trageti';
import { PREPARED_ARTIFACT_VERSION, type PreparedDemoArtifact } from '../shared/artifacts.js';
import { buildCustomRetrievalQuery, warmupDemoProviders } from '../shared/cli.js';
import type { DemoScenario, DemoScenarioContext } from '../shared/demo-runner.js';
import {
  createDemoTimeline,
  printAssembledAnswer,
  printNarrative,
  printQueryPlan,
  printRetrievalResult,
} from '../shared/output.js';
import { expectedFixtureAssertionIds } from '../shared/runtime.js';
import { generateAssembledAnswer } from '../shared/synthesis.js';
import type { ResolvedDemoProviders } from '../shared/providers.js';
import {
  NAMESPACE,
  bigBrotherMetadata,
  parseBigBrotherCliOptions,
  prepareBigBrotherArtifact,
  resolveBigBrotherProviders,
  runHash,
  runtimeDatabasePath,
} from './big-brother.js';
import { buildRetrieveQueries } from './queries.js';
import { generateNarrative } from './narrative.js';

export const bigBrotherScenario: DemoScenario = {
  name: 'big-brother',
  title: 'Big Brother',
  namespace: NAMESPACE,
  async prepare(context) {
    const cli = parseBigBrotherCliOptions([...context.argv]);
    if (cli.warmup) {
      const artifact = emptyWarmupArtifact();
      const providers = resolveBigBrotherProviders({ cli, artifact, env: context.env, trace: context.trace });
      await warmupDemoProviders({ providers, logger: context.logger });
    }
    context.logger.detail(
      cli.multimodal
        ? 'Prepare mode: capture screenshots now; send images directly during ingestion'
        : 'Prepare mode: capture screenshots and ask the vision model for detailed descriptions',
    );
    return await prepareBigBrotherArtifact({
      cli,
      env: context.env,
      trace: context.trace,
      progress: {
        captureStart(event) {
          context.logger.detail(`Capturing screenshot ${String(event.index)}/${String(event.total)} -> ${event.path}`);
        },
        captureDone(event) {
          context.logger.detail(`  Captured screenshot ${String(event.index)}/${String(event.total)} -> ${event.path}`);
        },
        describeStart(event) {
          context.logger.detail(`Describing ${event.id} via vision model`);
        },
        describeDone(event) {
          context.logger.detail(`  Description complete for ${event.id}`);
        },
      },
    });
  },
  resolveProviders(context, artifact) {
    const cli = parseBigBrotherCliOptions([...context.argv]);
    return resolveBigBrotherProviders({ cli, artifact, env: context.env, trace: context.trace });
  },
  databasePath(_context, artifact, providers) {
    return runtimeDatabasePath(runHash({ artifact, providers }));
  },
  expectedFixtureAssertionIds(artifact, providers) {
    const metadata = bigBrotherMetadata(artifact);
    return providers.extractor.provenance.kind === 'fixture' && metadata.fixtureData !== undefined
      ? expectedFixtureAssertionIds(metadata.fixtureData.fixtures)
      : undefined;
  },
  async retrieve(context, artifact, providers, store) {
    await retrieveBigBrother(context, artifact, providers, store);
  },
};

async function retrieveBigBrother(
  context: DemoScenarioContext,
  artifact: PreparedDemoArtifact,
  providers: ResolvedDemoProviders,
  store: TemporalStore,
): Promise<void> {
  const cli = parseBigBrotherCliOptions([...context.argv]);
  const metadata = bigBrotherMetadata(artifact);
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
    printAssembledAnswer(await generateAssembledAnswer({ store, extractor: providers.extractor, annotation, query }));
    return;
  }

  context.logger.step('Running screen-activity retrieval queries');
  for (const { annotation, query } of buildRetrieveQueries(metadata.latestPosition)) {
    printQueryPlan(annotation, query, timeline);
    const result = await store.retrieve(query);
    printRetrievalResult(annotation, query, result, timeline, {
      headerPrinted: true,
      order: 'temporal',
      relevance: { maxResults: 10 },
    });
    printAssembledAnswer(await generateAssembledAnswer({ store, extractor: providers.extractor, annotation, query }));
  }

  context.logger.step('Assembling context and generating activity narrative');
  printNarrative(await generateNarrative(store, providers.extractor, metadata.latestPosition));
}

function emptyWarmupArtifact(): PreparedDemoArtifact {
  return {
    artifactVersion: PREPARED_ARTIFACT_VERSION,
    scenario: 'big-brother',
    namespace: NAMESPACE,
    preparedAt: new Date().toISOString(),
    dataVersion: 'warmup',
    units: [],
    metadata: {
      mode: 'descriptions',
      captureCount: 0,
      durationMinutes: 0,
      latestPosition: 1,
      queryTexts: [],
    },
  };
}
