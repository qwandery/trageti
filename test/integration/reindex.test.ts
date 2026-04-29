import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openTestDb } from '../helpers/openTestDb.js'
import { TemporalStore } from '../../src/store/TemporalStore.js'

const NS = 'test-ns'
const DIM_INIT = 4
const DIM_NEW = 8

function makeEmbeddingProvider(dim: number) {
  return async (_id: string, _content: string): Promise<Float32Array> => {
    const vec = new Float32Array(dim)
    vec[0] = 1
    return vec
  }
}

describe('TemporalStore — reindexNamespace', () => {
  let db: Database
  let store: TemporalStore

  beforeEach(async () => {
    db = openTestDb()
    store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM_INIT })
    store.init()
    store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '', type: 'doc', content: 'c' })
    store.writeEpisode({ id: 'ep-2', namespace: NS, position: 2, occurredAt: '', type: 'doc', content: 'c' })
    store.writeEpisode({ id: 'ep-3', namespace: NS, position: 3, occurredAt: '', type: 'doc', content: 'c' })
    store.writeAssertion({ id: 'a-1', namespace: NS, type: 'fact', content: 'First.', validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1', supersedesId: null, entityId: null, entityType: null })
    store.writeAssertion({ id: 'a-2', namespace: NS, type: 'fact', content: 'Second.', validFrom: 2, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-2', supersedesId: null, entityId: null, entityType: null })
    store.writeAssertion({ id: 'a-3', namespace: NS, type: 'fact', content: 'Third.', validFrom: 3, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-3', supersedesId: null, entityId: null, entityType: null })
    // Index all three at dim=4
    store.indexAssertion('a-1', new Float32Array([1, 0, 0, 0]))
    store.indexAssertion('a-2', new Float32Array([0, 1, 0, 0]))
    store.indexAssertion('a-3', new Float32Array([0, 0, 1, 0]))
  })

  it('initial indexedCount is 3', () => {
    expect(store.getStats(NS).indexedCount).toBe(3)
  })

  it('reindex dim 4→8: indexedCount is 3 after reindex', async () => {
    await store.reindexNamespace(NS, {
      newDimension: DIM_NEW,
      embeddingProvider: makeEmbeddingProvider(DIM_NEW),
    })
    expect(store.getStats(NS).indexedCount).toBe(3)
  })

  it('reindex clears old embeddings before inserting new ones', async () => {
    // After reindex, retrieve with new dim should still work
    await store.reindexNamespace(NS, {
      newDimension: DIM_NEW,
      embeddingProvider: makeEmbeddingProvider(DIM_NEW),
    })
    const pending = store.getPendingIndexing(NS)
    expect(pending).toHaveLength(0)
  })

  it('failed reindex leaves vec0 table empty (resumable via getPendingIndexing)', async () => {
    const throwingProvider = async (_id: string, _content: string): Promise<Float32Array> => {
      throw new Error('Embedding service unavailable')
    }

    await expect(
      store.reindexNamespace(NS, {
        newDimension: DIM_NEW,
        embeddingProvider: throwingProvider,
      }),
    ).rejects.toThrow('Embedding service unavailable')

    // Table was recreated empty — all assertions are pending
    const pending = store.getPendingIndexing(NS)
    expect(pending).toHaveLength(3)
    expect(pending.map((p) => p.id).sort()).toEqual(['a-1', 'a-2', 'a-3'])
  })

  it('can resume after failed reindex by calling reindexNamespace again', async () => {
    const throwingProvider = async (): Promise<Float32Array> => {
      throw new Error('transient error')
    }

    await expect(
      store.reindexNamespace(NS, { newDimension: DIM_NEW, embeddingProvider: throwingProvider }),
    ).rejects.toThrow()

    // Resume with working provider
    await store.reindexNamespace(NS, {
      newDimension: DIM_NEW,
      embeddingProvider: makeEmbeddingProvider(DIM_NEW),
    })

    expect(store.getStats(NS).indexedCount).toBe(3)
    expect(store.getPendingIndexing(NS)).toHaveLength(0)
  })

  it('getStats().indexedCount reflects indexed count after reindex', async () => {
    expect(store.getStats(NS).indexedCount).toBe(3) // before

    await store.reindexNamespace(NS, {
      newDimension: DIM_NEW,
      embeddingProvider: makeEmbeddingProvider(DIM_NEW),
    })

    expect(store.getStats(NS).indexedCount).toBe(3) // after
  })
})
