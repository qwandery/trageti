import { createHash } from 'node:crypto';
import type { TragetiStore, RetrievedAssertion } from 'trageti';
import {
  PREPARED_ARTIFACT_VERSION,
  type PreparedDemoArtifact,
  type PreparedIngestionUnit,
} from '../shared/artifacts.js';
import {
  assertCustomQuerySupported,
  buildCustomRetrievalQuery,
  envWithDemoRateLimit,
  parseDemoCliOptions,
} from '../shared/cli.js';
import type { DemoScenario, DemoScenarioContext } from '../shared/demo-runner.js';
import { expectedFixtureAssertionIds, runtimeDbPath } from '../shared/runtime.js';
import { resolveDemoProviders, type ResolvedDemoProviders } from '../shared/providers.js';
import {
  createDemoTimeline,
  printAssembledAnswer,
  printNarrative,
  printQueryPlan,
  printRetrievalResult,
  printSnapshot,
} from '../shared/output.js';
import { generateAssembledAnswer } from '../shared/synthesis.js';
import { QUERY_TEXTS, assertionEmbeddings, queryEmbeddings } from './data/embeddings.js';
import { NAMESPACE, episodes } from './data/episodes.js';
import { fixtures } from './data/fixtures.js';
import { citationSources } from './data/sources.js';
import { dadSemanticQuery, literatureSemanticQuery, retrieveQueries } from './queries.js';
import { generateNarrative } from './narrative.js';

export const alexPlaceScenario: DemoScenario = {
  name: 'alex-place',
  title: 'alex-place',
  namespace: NAMESPACE,
  prepare(context) {
    const units = episodes.map((episode) => prepareAlexUnit(episode));
    const artifact: PreparedDemoArtifact = {
      artifactVersion: PREPARED_ARTIFACT_VERSION,
      scenario: 'alex-place',
      namespace: NAMESPACE,
      preparedAt: new Date().toISOString(),
      dataVersion: alexPreparedDataVersion(units),
      units,
      metadata: {
        queryTexts: QUERY_TEXTS,
      },
    };
    context.logger.detail('Prepared journal entries and reference notes as separate ingestion units');
    return Promise.resolve(artifact);
  },
  resolveProviders(context) {
    const cli = parseDemoCliOptions([...context.argv]);
    const providers = resolveDemoProviders({
      fixtures,
      assertionEmbeddings,
      queryEmbeddings,
      queryTexts: QUERY_TEXTS,
      env: envWithDemoRateLimit(context.env, cli.rateLimitSeconds),
      trace: context.trace,
      providerSelection: cli.providerSelection,
      sessionName: 'alex-place',
    });
    if (cli.query) assertCustomQuerySupported(providers.embedder);
    return providers;
  },
  databasePath() {
    return runtimeDbPath('alex-place');
  },
  expectedFixtureAssertionIds(_artifact, providers) {
    return providers.extractor.provenance.kind === 'fixture' ? expectedFixtureAssertionIds(fixtures) : undefined;
  },
  async retrieve(context, _artifact, providers, store) {
    await retrieveAlexPlace(context, providers, store);
  },
};

function prepareAlexUnit(episode: (typeof episodes)[number]): PreparedIngestionUnit {
  const source = sourceForEpisode(episode.id, episode.occurredAt);
  return {
    id: episode.id,
    episode,
    document: episode.content,
    citationSources: source,
    metadata: {
      sourceRefs: Object.keys(source),
    },
  };
}

function sourceForEpisode(id: string, occurredAt: string): Record<string, string> {
  if (id.startsWith('journal-')) {
    const date = occurredAt.slice(0, 10);
    return { [`alex.md#${date}`]: markdownSectionByDate(citationSources['alex.md'] ?? '', date) };
  }
  if (id === 'ref-field')
    return { 'references/field-fermentation.md': citationSources['references/field-fermentation.md'] ?? '' };
  if (id === 'ref-gf-sourdough')
    return { 'references/gluten-free-sourdough.md': citationSources['references/gluten-free-sourdough.md'] ?? '' };
  if (id === 'ref-ito') return { 'references/ito-paitan.md': citationSources['references/ito-paitan.md'] ?? '' };
  if (id === 'ref-maillard')
    return { 'references/maillard-browning.md': citationSources['references/maillard-browning.md'] ?? '' };
  throw new Error(`No source mapping configured for Alex episode ${id}`);
}

function markdownSectionByDate(markdown: string, date: string): string {
  const headingPattern = /^(#{1,6})\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(markdown)) !== null) {
    const heading = match[2] ?? '';
    if (!heading.includes(date)) continue;
    const level = match[1]?.length ?? 1;
    let start = headingPattern.lastIndex;
    while (markdown[start] === '\r' || markdown[start] === '\n') start += 1;
    const nextHeadingPattern = new RegExp(`^#{1,${String(level)}}\\s+`, 'gm');
    nextHeadingPattern.lastIndex = start;
    const next = nextHeadingPattern.exec(markdown);
    return markdown.slice(start, next?.index ?? markdown.length).replace(/[\r\n]+$/u, '');
  }
  throw new Error(`alex.md does not contain a journal section for ${date}`);
}

function alexPreparedDataVersion(units: readonly PreparedIngestionUnit[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        scenario: 'alex-place',
        units,
        fixtures,
        assertionEmbeddings,
        queryEmbeddings,
        queryTexts: QUERY_TEXTS,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

async function retrieveAlexPlace(
  context: DemoScenarioContext,
  providers: ResolvedDemoProviders,
  store: TragetiStore,
): Promise<void> {
  const cli = parseDemoCliOptions([...context.argv]);
  const timeline = createDemoTimeline(episodes);
  if (cli.query) {
    context.logger.step('Running custom user query');
    const query = buildCustomRetrievalQuery({
      namespace: NAMESPACE,
      queryText: cli.query,
      temporalAnchor: 24,
    });
    const annotation = '"User query" (custom)';
    printQueryPlan(annotation, query, timeline);
    const result = await store.retrieve(query);
    printRetrievalResult(annotation, query, result, timeline, {
      headerPrinted: true,
      order: 'temporal',
      relevance: { maxResults: 14 },
    });
    printAssembledAnswer(
      await generateAssembledAnswer({ store, extractor: providers.extractor, annotation, query, logger: context.logger }),
    );
    return;
  }

  context.logger.step('Running retrieval queries');
  for (const { annotation, query } of retrieveQueries) {
    printQueryPlan(annotation, query, timeline);
    const result = await store.retrieve(query);
    printRetrievalResult(annotation, query, result, timeline, {
      headerPrinted: true,
      order: 'temporal',
      relevance: { maxResults: 14 },
    });
    printAssembledAnswer(
      await generateAssembledAnswer({ store, extractor: providers.extractor, annotation, query, logger: context.logger }),
    );
  }

  context.logger.step('Running graph-expanded literature query');
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
      logger: context.logger,
    }),
  );

  context.logger.step('Running entity history query');
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
      logger: context.logger,
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

  context.logger.step('Assembling context and generating narrative');
  printNarrative(await generateNarrative(store, providers.extractor, context.logger));
}

function firstEntityId(results: readonly RetrievedAssertion[], preferredEntityId?: string): string | null {
  if (preferredEntityId && results.some((result) => result.entityId === preferredEntityId)) return preferredEntityId;
  if (preferredEntityId) return null;
  for (const result of results) {
    if (result.entityId) return result.entityId;
  }
  return null;
}
