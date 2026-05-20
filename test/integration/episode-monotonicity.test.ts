import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openTestDb } from '../helpers/openTestDb.js'
import { TemporalStore } from '../../src/store/TemporalStore.js'
import { ValidationError } from '../../src/errors/index.js'

const NS_A = 'test-ns-a'
const NS_B = 'test-ns-b'
const DIM = 4

describe('Episode position monotonicity (v0.2 spec invariant)', () => {
  let db: Database
  let store: TemporalStore

  beforeEach(async () => {
    db = openTestDb()
    store = new TemporalStore(db, { namespace: NS_A, embeddingDimension: DIM })
    await store.init()
    await store.initNamespace(NS_B, { embeddingDimension: DIM })
  })

  it('accepts strictly increasing positions within a namespace', async () => {
    await store.writeEpisode({
      id: 'ep-1',
      namespace: NS_A,
      position: 1,
      occurredAt: '2024-01-01T00:00:00Z',
      type: 'document',
      content: 'c1',
    })
    await expect(
      store.writeEpisode({
        id: 'ep-2',
        namespace: NS_A,
        position: 2,
        occurredAt: '2024-01-02T00:00:00Z',
        type: 'document',
        content: 'c2',
      }),
    ).resolves.toBeDefined()
  })

  it('rejects equal positions within a namespace', async () => {
    await store.writeEpisode({
      id: 'ep-1',
      namespace: NS_A,
      position: 5,
      occurredAt: '2024-01-01T00:00:00Z',
      type: 'document',
      content: 'c1',
    })
    await expect(
      store.writeEpisode({
        id: 'ep-2',
        namespace: NS_A,
        position: 5,
        occurredAt: '2024-01-02T00:00:00Z',
        type: 'document',
        content: 'c2',
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('rejects smaller positions within a namespace', async () => {
    await store.writeEpisode({
      id: 'ep-1',
      namespace: NS_A,
      position: 5,
      occurredAt: '2024-01-01T00:00:00Z',
      type: 'document',
      content: 'c1',
    })
    await expect(
      store.writeEpisode({
        id: 'ep-2',
        namespace: NS_A,
        position: 3,
        occurredAt: '2024-01-02T00:00:00Z',
        type: 'document',
        content: 'c2',
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('first write in a fresh namespace accepts any position', async () => {
    await expect(
      store.writeEpisode({
        id: 'ep-x',
        namespace: NS_A,
        position: 999,
        occurredAt: '2024-01-01T00:00:00Z',
        type: 'document',
        content: 'c',
      }),
    ).resolves.toBeDefined()
  })

  it('isolates monotonicity per namespace', async () => {
    await store.writeEpisode({
      id: 'ep-a1',
      namespace: NS_A,
      position: 10,
      occurredAt: '2024-01-01T00:00:00Z',
      type: 'document',
      content: 'a1',
    })
    await expect(
      store.writeEpisode({
        id: 'ep-b1',
        namespace: NS_B,
        position: 1,
        occurredAt: '2024-01-02T00:00:00Z',
        type: 'document',
        content: 'b1',
      }),
    ).resolves.toBeDefined()
  })

  it('rolls back the insert when a duplicate position rejection fires (no partial state)', async () => {
    await store.writeEpisode({
      id: 'ep-1',
      namespace: NS_A,
      position: 5,
      occurredAt: '2024-01-01T00:00:00Z',
      type: 'document',
      content: 'c1',
    })
    await expect(
      store.writeEpisode({
        id: 'ep-2',
        namespace: NS_A,
        position: 5,
        occurredAt: '2024-01-02T00:00:00Z',
        type: 'document',
        content: 'c2',
      }),
    ).rejects.toThrow(ValidationError)
    const row = db
      .prepare<[string], { id: string }>('SELECT id FROM trageti_episodes WHERE id = ?')
      .get('ep-2')
    expect(row).toBeUndefined()
  })
})
