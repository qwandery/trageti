// alex-place - Alex's cooking journal as a temporal RAG corpus. Runs offline
// in fixture mode by default; set explicit demo provider env vars for live mode.

import 'dotenv/config'
import { TemporalStore, type Assertion } from 'trageti'
import {
  createDemoTimeline,
  createDemoLogger,
  printBanner,
  printProviderSummary,
  printQueryPlan,
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
    printQueryPlan(annotation, query, timeline)
    const result = await store.retrieve(query)
    printRetrievalResult(annotation, query, result, timeline, { headerPrinted: true })
  }

  logger.step('Running graph path query')
  const pathEndpoints = await resolveLiteraturePathEndpoints(store)
  const pathOptions = pathEndpoints
    ? {
        ...literaturePathQuery.options,
        fromAssertionId: pathEndpoints.fromId,
        toAssertionId: pathEndpoints.toId,
      }
    : literaturePathQuery.options
  const path = pathEndpoints ? await store.findPath(pathOptions) : null
  printPathHops(`Query ${literaturePathQuery.annotation}`, path ?? [], {
    fromAssertionId: pathOptions.fromAssertionId,
    toAssertionId: pathOptions.toAssertionId,
    temporalAnchor: literaturePathQuery.options.temporalAnchor,
    maxDepth: literaturePathQuery.options.maxDepth,
    liveMode: providers.isLive,
    timeline,
    staleFixtureAdvice: !providers.isLive,
  })

  logger.step('Running entity history query')
  const dadHistory = await store.getEntityHistory(dadEntityQuery.namespace, dadEntityQuery.entityId)
  printSnapshot(`Query ${dadEntityQuery.annotation}`, dadHistory, {
    timeline,
    emptyMessage:
      `No entity-history assertions were returned for entityId "${dadEntityQuery.entityId}". ` +
      'This intentional negative-control query does not run semantic search for the word "Dad"; it only reads assertions that extraction tagged with that exact entity ID. ' +
      (providers.isLive
        ? 'Live extraction may mention Dad without assigning this entity ID.'
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

async function resolveLiteraturePathEndpoints(store: TemporalStore): Promise<{ fromId: string; toId: string } | null> {
  const assertions = await store.getAssertions(NAMESPACE, { includeSuperseded: true })
  const from = bestAssertionMatch(assertions, ['acidity', 'starter maturity', 'inoculation', 'temperature'])
  const to = bestAssertionMatch(assertions, ['acidity', 'target', 'younger levain'])
  if (!from || !to) return null
  return { fromId: from.id, toId: to.id }
}

function bestAssertionMatch(assertions: readonly Assertion[], terms: readonly string[]): Assertion | null {
  let best: { assertion: Assertion; score: number } | null = null
  for (const assertion of assertions) {
    const content = assertion.content.toLowerCase()
    const score = terms.filter((term) => content.includes(term.toLowerCase())).length
    if (score === 0) continue
    if (!best || score > best.score || (score === best.score && assertion.validFrom > best.assertion.validFrom)) {
      best = { assertion, score }
    }
  }
  return best?.assertion ?? null
}
