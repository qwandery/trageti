// alex-place - Alex's cooking journal as a temporal RAG corpus. Runs offline
// in fixture mode by default; set explicit demo provider env vars for live mode.

import 'dotenv/config'
import { TemporalStore } from 'trageti'
import {
  printBanner,
  printQueryHeader,
  printAssertion,
  printPathHops,
  printSnapshot,
  printNarrative,
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
  const providers = resolveDemoProviders({
    fixtures,
    assertionEmbeddings,
    queryEmbeddings,
    queryTexts: QUERY_TEXTS,
    embeddingDimension: EMBEDDING_DIMENSION,
  })
  printBanner(`alex-place - mode: ${providers.modeLabel}`)

  const database = runtimeDbPath('alex-place')
  ensureDemoMetadata({
    database,
    demoName: 'alex-place',
    dataVersion: demoDataVersion('alex-place', episodes, fixtures),
    providers,
  })

  const store = await TemporalStore.create({
    database,
    namespace: NAMESPACE,
    embeddingDimension: EMBEDDING_DIMENSION,
    embeddingProvider: providers.embedder.provider,
  })

  const ingestOptions = {
    store,
    namespace: NAMESPACE,
    episodes,
    providers,
  }
  await ingestEpisodes(
    providers.isLive
      ? ingestOptions
      : { ...ingestOptions, expectedFixtureAssertionIds: expectedFixtureAssertionIds(fixtures) },
  )

  for (const { annotation, query } of retrieveQueries) {
    const { results, meta } = await store.retrieve(query)
    printQueryHeader(annotation, meta)
    for (const [i, r] of results.entries()) {
      printAssertion(r, i)
    }
  }

  console.log('')
  console.log(`Query: ${literaturePathQuery.annotation}`)
  const path = await store.findPath(literaturePathQuery.options)
  printPathHops(path ?? [])

  console.log('')
  console.log(`Query: ${dadEntityQuery.annotation}`)
  const dadHistory = await store.getEntityHistory(dadEntityQuery.namespace, dadEntityQuery.entityId)
  printSnapshot(dadHistory)

  const narrative = await generateNarrative(store, providers.extractor, providers.isLive)
  printNarrative(narrative)

  await store.close()
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err)
    process.exit(1)
  },
)
