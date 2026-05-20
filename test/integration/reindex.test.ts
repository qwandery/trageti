import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openTestDb } from '../helpers/openTestDb.js'
import { TemporalStore } from '../../src/store/TemporalStore.js'
import type { EmbeddingProvider } from '../../src/domain/types.js'
import { citationFor } from '../fixtures/scenario.js'

const NS = 'test-ns'
const DIM_INIT = 4
const DIM_NEW = 8

function makeProvider(dim: number): EmbeddingProvider {
  return {
    name: 'test-fixed',
    dimension: dim,
    embed: async (texts) =>
      texts.map(() => {
        const vec = new Float32Array(dim)
        vec[0] = 1
        return vec
      }),
  }
}

describe('TemporalStore — reindexNamespace (staging-swap)', () => {
  let db: Database
  let store: TemporalStore

  beforeEach(async () => {
    db = openTestDb()
    store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM_INIT })
    await store.init()
    for (const [id, pos] of [
      ['ep-1', 1],
      ['ep-2', 2],
      ['ep-3', 3],
    ] as const) {
      await store.writeEpisode({
        id,
        namespace: NS,
        position: pos,
        occurredAt: '',
        type: 'doc',
        content: 'c',
      })
    }
    for (const [id, ep, pos] of [
      ['a-1', 'ep-1', 1],
      ['a-2', 'ep-2', 2],
      ['a-3', 'ep-3', 3],
    ] as const) {
      await store.writeAssertion({
        id,
        namespace: NS,
        type: 'fact',
        content: `Assertion ${id}.`,
        validFrom: pos,
        validUntil: null,
        confidence: 1,
        sourceEpisodeId: ep,
        supersedesId: null,
        entityId: null,
        entityType: null,
        citations: [citationFor(id, ep)],
      })
    }
    // Index all three at dim=4.
    await store.indexAssertion('a-1', new Float32Array([1, 0, 0, 0]))
    await store.indexAssertion('a-2', new Float32Array([0, 1, 0, 0]))
    await store.indexAssertion('a-3', new Float32Array([0, 0, 1, 0]))
  })

  it('initial indexedCount is 3', async () => {
    expect((await store.getStats(NS)).indexedCount).toBe(3)
  })

  it('reindex dim 4→8: indexedCount is 3 after reindex', async () => {
    const result = await store.reindexNamespace(NS, {
      newDimension: DIM_NEW,
      embeddingProvider: makeProvider(DIM_NEW),
    })
    expect(result.reindexed).toBe(3)
    expect(result.swappedAt).toBeDefined()
    expect((await store.getStats(NS)).indexedCount).toBe(3)
    expect((await store.getStats(NS)).embeddingDimension).toBe(DIM_NEW)
  })

  it('reindex leaves no pending assertions', async () => {
    await store.reindexNamespace(NS, {
      newDimension: DIM_NEW,
      embeddingProvider: makeProvider(DIM_NEW),
    })
    expect(await store.getPendingIndexing(NS)).toHaveLength(0)
  })

  it('failed reindex preserves the previous index (staging-swap is non-destructive)', async () => {
    const throwing: EmbeddingProvider = {
      name: 'broken',
      dimension: DIM_NEW,
      embed: async () => {
        throw new Error('Embedding service unavailable')
      },
    }

    await expect(
      store.reindexNamespace(NS, { newDimension: DIM_NEW, embeddingProvider: throwing }),
    ).rejects.toThrow(/Embedding service unavailable/)

    // The previous index is intact — all three are still indexed at dim 4.
    expect((await store.getStats(NS)).indexedCount).toBe(3)
    expect((await store.getStats(NS)).embeddingDimension).toBe(DIM_INIT)
    expect(await store.getPendingIndexing(NS)).toHaveLength(0)
  })

  it('can resume after a failed reindex by calling reindexNamespace again', async () => {
    const throwing: EmbeddingProvider = {
      name: 'broken',
      dimension: DIM_NEW,
      embed: async () => {
        throw new Error('transient error')
      },
    }

    await expect(
      store.reindexNamespace(NS, { newDimension: DIM_NEW, embeddingProvider: throwing }),
    ).rejects.toThrow()

    // Retry with a working provider.
    await store.reindexNamespace(NS, {
      newDimension: DIM_NEW,
      embeddingProvider: makeProvider(DIM_NEW),
    })

    expect((await store.getStats(NS)).indexedCount).toBe(3)
    expect(await store.getPendingIndexing(NS)).toHaveLength(0)
  })

  it('reindexNamespace uses the store-configured provider when none is passed', async () => {
    const storeWithProvider = new TemporalStore(db, {
      namespace: NS,
      embeddingDimension: DIM_INIT,
      embeddingProvider: makeProvider(DIM_NEW),
    })
    await storeWithProvider.init()
    const result = await storeWithProvider.reindexNamespace(NS, { newDimension: DIM_NEW })
    expect(result.reindexed).toBe(3)
  })
})
