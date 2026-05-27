// alex-place - Alex's cooking journal as a temporal RAG corpus. Runs offline
// in fixture mode by default; set explicit demo provider env vars for live mode.

import 'dotenv/config'
import { TemporalStore } from 'trageti'
import {
  createDemoTimeline,
  createDemoLogger,
  printBanner,
  printProviderSummary,
  printRetrievalResult,
  printPathHops,
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
  literaturePathQuery,
  dadEntityQuery,
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
    const result = await store.retrieve(query)
    printRetrievalResult(annotation, query, result, timeline)
  }

  logger.step('Running graph path query')
  const path = await store.findPath(literaturePathQuery.options)
  printPathHops(`Query ${literaturePathQuery.annotation}`, path ?? [], {
    fromAssertionId: literaturePathQuery.options.fromAssertionId,
    toAssertionId: literaturePathQuery.options.toAssertionId,
    temporalAnchor: literaturePathQuery.options.temporalAnchor,
    maxDepth: literaturePathQuery.options.maxDepth,
    liveMode: providers.isLive,
    timeline,
  })

  logger.step('Running entity history query')
  const dadHistory = await store.getEntityHistory(dadEntityQuery.namespace, dadEntityQuery.entityId)
  printSnapshot(`Query ${dadEntityQuery.annotation}`, dadHistory, {
    timeline,
    emptyMessage:
      `No entity-history assertions were returned for entityId "${dadEntityQuery.entityId}". ` +
      'This query does not run semantic search for the word "Dad"; it only reads assertions that extraction tagged with that exact entity ID. ' +
      (providers.isLive
        ? 'Live extraction may mention Dad without assigning the fixture entity ID; fixture mode is deterministic for this near-miss demo.'
        : 'The fixture corpus intentionally treats this as a sparse near-miss signal.'),
  })

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
