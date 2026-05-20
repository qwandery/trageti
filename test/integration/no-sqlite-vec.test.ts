import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { TemporalStore } from '../../src/store/TemporalStore.js'
import { MockEmbeddingProvider } from '../../src/defaults/providers/MockEmbeddingProvider.js'
import { IndexingError, MissingPeerDependencyError } from '../../src/errors/index.js'
import { citationFor } from '../fixtures/scenario.js'

const NS = 'novec'
const DIM = 4

/** A database with WAL + FK but deliberately WITHOUT the sqlite-vec extension. */
function openPlainDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('temp_store = MEMORY')
  return db
}

async function seed(store: TemporalStore): Promise<void> {
  await store.writeEpisode({
    id: 'ep-1',
    namespace: NS,
    position: 1,
    occurredAt: '2024-01-01T00:00:00Z',
    type: 'document',
    content: 'episode',
  })
  await store.writeAssertion({
    id: 'a-1',
    namespace: NS,
    type: 'fact',
    content: 'assertion about foxes',
    validFrom: 1,
    validUntil: null,
    confidence: 0.9,
    sourceEpisodeId: 'ep-1',
    supersedesId: null,
    entityId: null,
    entityType: null,
    citations: [citationFor('a-1', 'ep-1')],
  })
}

describe('TemporalStore without sqlite-vec loaded', () => {
  it('initialises a vector-configured namespace (vec0 is created lazily)', async () => {
    const store = new TemporalStore(openPlainDb(), { namespace: NS, embeddingDimension: DIM })
    await store.init()
    const stats = await store.getStats(NS)
    expect(stats.embeddingDimension).toBe(DIM)
    expect(stats.vectorReady).toBe(false)
    await store.close()
  })

  it('indexAssertion throws MissingPeerDependencyError on a vector path', async () => {
    const store = new TemporalStore(openPlainDb(), { namespace: NS, embeddingDimension: DIM })
    await store.init()
    await seed(store)
    await expect(store.indexAssertion('a-1', new Float32Array([1, 0, 0, 0]))).rejects.toThrow(
      MissingPeerDependencyError,
    )
    await store.close()
  })

  it("retrieve with strategy 'vector' throws MissingPeerDependencyError", async () => {
    const store = new TemporalStore(openPlainDb(), { namespace: NS, embeddingDimension: DIM })
    await store.init()
    await seed(store)
    await expect(
      store.retrieve({
        namespace: NS,
        queryEmbedding: new Float32Array([1, 0, 0, 0]),
        retrievalStrategy: 'vector',
        temporalAnchor: 5,
      }),
    ).rejects.toThrow(MissingPeerDependencyError)
    await store.close()
  })

  it('hybrid retrieval degrades to BM25 with a NO_SQLITE_VEC warning', async () => {
    const store = new TemporalStore(openPlainDb(), {
      namespace: NS,
      embeddingDimension: DIM,
      embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
    })
    await store.init()
    await seed(store)
    const { meta } = await store.retrieve({
      namespace: NS,
      queryText: 'foxes',
      temporalAnchor: 5,
    })
    expect(meta.warnings.some((w) => w.code === 'TRGT_RETRIEVE_VECTOR_SKIPPED')).toBe(true)
    await store.close()
  })

  it('getPendingIndexing returns all active assertions when vec0 is not yet created', async () => {
    const store = new TemporalStore(openPlainDb(), { namespace: NS, embeddingDimension: DIM })
    await store.init()
    await seed(store)
    const pending = await store.getPendingIndexing(NS)
    expect(pending.map((p) => p.id)).toEqual(['a-1'])
    await store.close()
  })

  it('indexAssertion error is an IndexingError or MissingPeerDependencyError, never a silent pass', async () => {
    const store = new TemporalStore(openPlainDb(), { namespace: NS, embeddingDimension: DIM })
    await store.init()
    await expect(store.indexAssertion('ghost', new Float32Array([1, 0, 0, 0]))).rejects.toThrow(
      IndexingError,
    )
    await store.close()
  })
})
