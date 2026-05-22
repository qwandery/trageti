// know-thyself — trageti ingests its own development history and answers
// questions about its own evolution. Skeleton smoke test: 3 keyframes, ~7
// assertions, 3 retrieve queries + 1 position snapshot. Runs offline in
// fixture mode (the default); set env vars for live mode (see README).

import { TemporalStore, RawVectorProvider } from 'trageti'
import type { Assertion, EmbeddingProvider } from 'trageti'
import { ingest } from '../shared/ingest.js'
import {
  fixtureExtractor,
  anthropicExtractor,
  openaiExtractor,
  ollamaEmbeddingProvider,
  openaiEmbeddingProvider,
} from '../shared/extractors.js'
import {
  printBanner,
  printQueryHeader,
  printAssertion,
  printSnapshot,
} from '../shared/output.js'
import { parseExtraction } from '../shared/parse.js'
import { NAMESPACE, episodes } from './data/episodes.js'
import { fixtures } from './data/fixtures.js'
import {
  EMBEDDING_DIMENSION,
  QUERY_TEXTS,
  assertionEmbeddings,
  queryEmbeddings,
} from './data/embeddings.js'
import { retrieveQueries, snapshotAtV01 } from './queries.js'

interface ResolvedMode {
  label: string
  extract: (prompt: string) => Promise<string>
  embedder: EmbeddingProvider
}

function resolveMode(): ResolvedMode {
  const anthropicKey = process.env['ANTHROPIC_API_KEY']
  const openaiKey = process.env['OPENAI_API_KEY']
  const openrouterKey = process.env['OPENROUTER_API_KEY']
  const ollamaHost = process.env['OLLAMA_HOST']

  const hasLiveExtractor = Boolean(anthropicKey ?? openaiKey ?? openrouterKey ?? ollamaHost)
  const hasLiveEmbedder = Boolean(openaiKey ?? ollamaHost)

  if (hasLiveExtractor && !hasLiveEmbedder) {
    throw new Error(
      'Live extraction requires a live embedding provider. ' +
        'Set OLLAMA_HOST or OPENAI_API_KEY, or unset the extractor key to run in fixture mode.',
    )
  }

  if (!hasLiveExtractor) {
    // Build a RawVectorProvider seeded with pre-computed vectors for every
    // fixture assertion content + every query text.
    const provider = new RawVectorProvider(EMBEDDING_DIMENSION)
    for (const episodeId of Object.keys(fixtures)) {
      const raw = fixtures[episodeId]
      if (raw === undefined) throw new Error(`fixture missing for episode ${episodeId}`)
      for (const a of parseExtraction(raw).assertions) {
        const vec = assertionEmbeddings[a.id]
        if (!vec) throw new Error(`missing assertion embedding: ${a.id}`)
        provider.set(a.content, vec)
      }
    }
    for (const text of QUERY_TEXTS) {
      const vec = queryEmbeddings[text]
      if (!vec) throw new Error(`missing query embedding: ${text}`)
      provider.set(text, vec)
    }
    return { label: 'fixture / raw-vector', extract: fixtureExtractor(fixtures), embedder: provider }
  }

  // Live mode — pick the first available extractor and embedder.
  const extract = anthropicKey
    ? anthropicExtractor(anthropicKey)
    : openaiKey
      ? openaiExtractor({ baseUrl: 'https://api.openai.com/v1', apiKey: openaiKey, model: 'gpt-4o-mini' })
      : openrouterKey
        ? openaiExtractor({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: openrouterKey, model: 'anthropic/claude-sonnet-4' })
        : openaiExtractor({ baseUrl: ollamaHost ?? '', apiKey: 'ollama', model: 'llama3.1' })

  const embedder = openaiKey
    ? openaiEmbeddingProvider({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: openaiKey,
        model: 'text-embedding-3-small',
        dimension: EMBEDDING_DIMENSION,
      })
    : ollamaEmbeddingProvider({
        host: ollamaHost ?? 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimension: EMBEDDING_DIMENSION,
      })

  const extractorLabel = anthropicKey
    ? 'anthropic'
    : openaiKey
      ? 'openai'
      : openrouterKey
        ? 'openrouter'
        : 'ollama'
  return { label: `live (${extractorLabel} + ${embedder.name})`, extract, embedder }
}

async function main(): Promise<void> {
  const mode = resolveMode()
  printBanner(`know-thyself — mode: ${mode.label}`)

  const store = await TemporalStore.create({
    database: ':memory:',
    namespace: NAMESPACE,
    embeddingDimension: EMBEDDING_DIMENSION,
    embeddingProvider: mode.embedder,
  })

  // Ingest in fixture-key declaration order; accumulator gives live extraction
  // prior-context for supersession/accumulation decisions.
  const accumulated: Assertion[] = []
  for (const episode of episodes) {
    const result = await ingest({
      store,
      namespace: NAMESPACE,
      episode,
      document: episode.content,
      existingAssertions: accumulated,
      extract: mode.extract,
    })
    const ib = await store.indexBatch(
      result.assertions.map((a) => ({ assertionId: a.id })),
      { onProviderError: 'skip' },
    )
    if (ib.skipped.length > 0) {
      const reason = ib.skipped[0]?.reason ?? 'UNKNOWN'
      throw new Error(`indexBatch skipped ${String(ib.skipped.length)} assertion(s): ${reason}`)
    }
    accumulated.length = 0
    accumulated.push(...(await store.getAssertions(NAMESPACE, { includeSuperseded: true })))
  }

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
