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

  beforeEach(() => {
    db = openTestDb()
    store = new TemporalStore(db, { namespace: NS_A, embeddingDimension: DIM })
    store.init()
    store.initNamespace(NS_B, { embeddingDimension: DIM })
  })

  it('accepts strictly increasing positions within a namespace', () => {
    store.writeEpisode({ id: 'ep-1', namespace: NS_A, position: 1, occurredAt: '2024-01-01T00:00:00Z', type: 'document', content: 'c1' })
    expect(() =>
      store.writeEpisode({ id: 'ep-2', namespace: NS_A, position: 2, occurredAt: '2024-01-02T00:00:00Z', type: 'document', content: 'c2' }),
    ).not.toThrow()
  })

  it('rejects equal positions within a namespace', () => {
    store.writeEpisode({ id: 'ep-1', namespace: NS_A, position: 5, occurredAt: '2024-01-01T00:00:00Z', type: 'document', content: 'c1' })
    expect(() =>
      store.writeEpisode({ id: 'ep-2', namespace: NS_A, position: 5, occurredAt: '2024-01-02T00:00:00Z', type: 'document', content: 'c2' }),
    ).toThrow(ValidationError)
  })

  it('rejects smaller positions within a namespace', () => {
    store.writeEpisode({ id: 'ep-1', namespace: NS_A, position: 5, occurredAt: '2024-01-01T00:00:00Z', type: 'document', content: 'c1' })
    expect(() =>
      store.writeEpisode({ id: 'ep-2', namespace: NS_A, position: 3, occurredAt: '2024-01-02T00:00:00Z', type: 'document', content: 'c2' }),
    ).toThrow(ValidationError)
  })

  it('first write in a fresh namespace accepts any position', () => {
    expect(() =>
      store.writeEpisode({ id: 'ep-x', namespace: NS_A, position: 999, occurredAt: '2024-01-01T00:00:00Z', type: 'document', content: 'c' }),
    ).not.toThrow()
  })

  it('isolates monotonicity per namespace', () => {
    store.writeEpisode({ id: 'ep-a1', namespace: NS_A, position: 10, occurredAt: '2024-01-01T00:00:00Z', type: 'document', content: 'a1' })
    expect(() =>
      store.writeEpisode({ id: 'ep-b1', namespace: NS_B, position: 1, occurredAt: '2024-01-02T00:00:00Z', type: 'document', content: 'b1' }),
    ).not.toThrow()
  })

  it('rolls back the insert when a duplicate position rejection fires (no partial state)', () => {
    store.writeEpisode({ id: 'ep-1', namespace: NS_A, position: 5, occurredAt: '2024-01-01T00:00:00Z', type: 'document', content: 'c1' })
    expect(() =>
      store.writeEpisode({ id: 'ep-2', namespace: NS_A, position: 5, occurredAt: '2024-01-02T00:00:00Z', type: 'document', content: 'c2' }),
    ).toThrow(ValidationError)
    const row = db.prepare<[string], { id: string }>('SELECT id FROM trl_episodes WHERE id = ?').get('ep-2')
    expect(row).toBeUndefined()
  })
})
