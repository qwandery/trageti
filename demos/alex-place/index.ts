// alex-place - Alex's cooking journal as a temporal RAG corpus. Runs offline
// in fixture mode by default; set explicit demo provider env vars for live mode.

import 'dotenv/config'
import { TemporalStore, type RetrievedAssertion } from 'trageti'
import {
  createDemoTimeline,
  createDemoLogger,
  printBanner,
  printProviderSummary,
  printQueryPlan,
  printRetrievalResult,
  printSnapshot,
  printNarrative,
  createLlmTraceOptions,
} from '../shared/output.js'
import { resolveDemoProviders } from '../shared/providers.js'
import {
  demoDataVersion,
  ensureDemoMetadata,
  expectedFixtureAssertionIds,
  ingestEpisodes,
  runtimeDbPath,
} from '../shared/runtime.js'
import { NAMESPACE, episodes } from './data/episodes.js'
import { fixtures } from './data/fixtures.js'
import {
  EMBEDDING_DIMENSION,
  QUERY_TEXTS,
  assertionEmbeddings,
  queryEmbeddings,
} from './data/embeddings.js'
import {
  retrieveQueries,
  literatureSemanticQuery,
  dadSemanticQuery,
} from './queries.js'
import { generateNarrative } from './narrative.js'

async function main(): Promise<void> {
  const trace = createLlmTraceOptions()
  const providers = resolveDemoProviders({
    fixtures,
    assertionEmbeddings,
    queryEmbeddings,
    queryTexts: QUERY_TEXTS,
    embeddingDimension: EMBEDDING_DIMENSION,
    trace,
  })
  printBanner(`alex-place - mode: ${providers.modeLabel}`)
  const timeline = createDemoTimeline(episodes)

  const database = runtimeDbPath('alex-place')
  const logger = createDemoLogger()
  printProviderSummary({
    modeLabel: providers.modeLabel,
    namespace: NAMESPACE,
    database,
    extractionLabel: providers.extractor.label,
    embeddingLabel: providers.embedder.label,
    embeddingDimension: EMBEDDING_DIMENSION,
  })
  ensureDemoMetadata({
    database,
    demoName: 'alex-place',
    dataVersion: demoDataVersion('alex-place', episodes, fixtures, assertionEmbeddings, queryEmbeddings, QUERY_TEXTS),
    providers,
    logger,
  })

  logger.step('Opening TemporalStore')
  const store = await TemporalStore.create({
    database,
    namespace: NAMESPACE,
    embeddingDimension: EMBEDDING_DIMENSION,
    embeddingProvider: providers.embedder.provider,
  })
  logger.success('TemporalStore is ready')

  const ingestOptions = {
    store,
    namespace: NAMESPACE,
    episodes,
    providers,
    logger,
  }
  await ingestEpisodes(
    providers.extractor.provenance.kind === 'fixture'
      ? { ...ingestOptions, expectedFixtureAssertionIds: expectedFixtureAssertionIds(fixtures) }
      : ingestOptions,
  )

  logger.step('Running retrieval queries')
  for (const { annotation, query } of retrieveQueries) {
    printQueryPlan(annotation, query, timeline)
    const result = await store.retrieve(query)
    printRetrievalResult(annotation, query, result, timeline, {
      headerPrinted: true,
      order: 'temporal',
      relevance: { maxResults: 14 },
    })
  }

  logger.step('Running graph-expanded literature query')
  printQueryPlan(literatureSemanticQuery.annotation, literatureSemanticQuery.query, timeline)
  const literatureResult = await store.retrieve(literatureSemanticQuery.query)
  printRetrievalResult(literatureSemanticQuery.annotation, literatureSemanticQuery.query, literatureResult, timeline, {
    headerPrinted: true,
    order: 'temporal',
    relevance: { maxResults: 10 },
  })

  logger.step('Running entity history query')
  printQueryPlan(dadSemanticQuery.annotation, dadSemanticQuery.query, timeline)
  const dadSemanticResult = await store.retrieve(dadSemanticQuery.query)
  printRetrievalResult(dadSemanticQuery.annotation, dadSemanticQuery.query, dadSemanticResult, timeline, {
    headerPrinted: true,
    order: 'temporal',
    relevance: { maxResults: 8 },
  })

  const dadEntityId = firstEntityId(dadSemanticResult.results)
  if (dadEntityId) {
    const dadHistory = await store.getEntityHistory(NAMESPACE, dadEntityId)
    printSnapshot(`Query "What would Dad think?" (entity history for retrieved entity "${dadEntityId}")`, dadHistory, {
      timeline,
      emptyMessage:
        `No entity-history assertions were returned for entityId "${dadEntityId}", even though semantic retrieval surfaced it.`,
    })
  } else {
    printSnapshot('Query "What would Dad think?" (entity history)', [], {
      timeline,
      emptyMessage:
        'Semantic retrieval did not surface a stored entity ID for this subject, so there is no entity-history lookup to run.',
    })
  }

  logger.step('Assembling context and generating narrative')
  const narrative = await generateNarrative(store, providers.extractor, providers.isLive)
  printNarrative(narrative)

  logger.step('Closing TemporalStore')
  await store.close()
  logger.success('Demo complete')
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err)
    process.exit(1)
  },
)

function firstEntityId(results: readonly RetrievedAssertion[]): string | null {
  for (const result of results) {
    if (result.entityId) return result.entityId
  }
  return null
}
