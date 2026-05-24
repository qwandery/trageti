// know-thyself - trageti ingests its own development history and answers
// questions about its own evolution. Runs offline in fixture mode by default;
// set explicit demo provider env vars for live mode.

import 'dotenv/config'
import { TemporalStore } from 'trageti'
import {
  printBanner,
  printQueryHeader,
  printAssertion,
  printSnapshot,
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
import { retrieveQueries, snapshotAtV01 } from './queries.js'

async function main(): Promise<void> {
  const providers = resolveDemoProviders({
    fixtures,
    assertionEmbeddings,
    queryEmbeddings,
    queryTexts: QUERY_TEXTS,
    embeddingDimension: EMBEDDING_DIMENSION,
  })
  printBanner(`know-thyself - mode: ${providers.modeLabel}`)

  const database = runtimeDbPath('know-thyself')
  ensureDemoMetadata({
    database,
    demoName: 'know-thyself',
    dataVersion: demoDataVersion('know-thyself', episodes, fixtures, assertionEmbeddings, queryEmbeddings, QUERY_TEXTS),
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
    providers.extractor.provenance.kind === 'fixture'
      ? { ...ingestOptions, expectedFixtureAssertionIds: expectedFixtureAssertionIds(fixtures) }
      : ingestOptions,
  )

  for (const { annotation, query } of retrieveQueries) {
    const { results, meta } = await store.retrieve(query)
    printQueryHeader(annotation, meta)
    for (const [i, r] of results.entries()) {
      printAssertion(r, i)
    }
  }

  console.log('')
  console.log(`Query: ${snapshotAtV01.annotation}`)
  const snapshot = await store.getTemporalSnapshot(snapshotAtV01.options)
  printSnapshot(snapshot)

  await store.close()
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err)
    process.exit(1)
  },
)
