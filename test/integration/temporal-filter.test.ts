import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openTestDb } from '../helpers/openTestDb.js'
import { TemporalStore } from '../../src/store/TemporalStore.js'
import { NamespaceNotInitializedError, ValidationError } from '../../src/errors/index.js'
import { citationFor } from '../fixtures/scenario.js'

const NS = 'test-ns'
const DIM = 4

function makeStore(db: Database): TemporalStore {
  return new TemporalStore(db, { namespace: NS, embeddingDimension: DIM })
}

describe('TemporalStore — init and namespace lifecycle', () => {
  let db: Database

  beforeEach(() => {
    db = openTestDb()
  })

  it('throws NamespaceNotInitializedError before init()', () => {
    const store = makeStore(db)
    expect(() => store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '2024-01-01T00:00:00Z', type: 't', content: 'c' }))
      .toThrow(NamespaceNotInitializedError)
  })

  it('init() succeeds on fresh db', () => {
    const store = makeStore(db)
    expect(() => store.init()).not.toThrow()
  })

  it('init() is idempotent', () => {
    const store = makeStore(db)
    store.init()
    expect(() => store.init()).not.toThrow()
  })

  it('throws for unknown namespace after init', () => {
    const store = makeStore(db)
    store.init()
    expect(() => store.writeEpisode({ id: 'ep-1', namespace: 'unknown-ns', position: 1, occurredAt: '', type: 't', content: 'c' }))
      .toThrow(NamespaceNotInitializedError)
  })
})

describe('TemporalStore — write and read', () => {
  let db: Database
  let store: TemporalStore

  beforeEach(() => {
    db = openTestDb()
    store = makeStore(db)
    store.init()
    store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '2024-01-01T00:00:00Z', type: 'doc', content: 'Episode content' })
  })

  it('writes and reads an episode', () => {
    const ep = store.getEpisode('ep-1')
    expect(ep).not.toBeNull()
    expect(ep?.id).toBe('ep-1')
    expect(ep?.position).toBe(1)
  })

  it('writes and reads an assertion', () => {
    store.writeAssertion({ id: 'a-1', namespace: NS, type: 'fact', content: 'Test claim.', validFrom: 1, validUntil: null, confidence: 0.9, sourceEpisodeId: 'ep-1', supersedesId: null, entityId: null, entityType: null, citations: [citationFor('a-1', 'ep-1')] })
    const assertions = store.getAssertions(NS)
    expect(assertions.length).toBe(1)
    expect(assertions[0]?.content).toBe('Test claim.')
  })

  it('rejects assertion with validUntil <= validFrom', () => {
    expect(() =>
      store.writeAssertion({ id: 'a-bad', namespace: NS, type: 'fact', content: 'Bad.', validFrom: 5, validUntil: 3, confidence: 1, sourceEpisodeId: 'ep-1', supersedesId: null, entityId: null, entityType: null, citations: [citationFor('a-bad', 'ep-1')] }),
    ).toThrow(ValidationError)
  })

  it('rejects assertion referencing non-existent episode', () => {
    expect(() =>
      store.writeAssertion({ id: 'a-bad', namespace: NS, type: 'fact', content: 'Bad.', validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'no-such-ep', supersedesId: null, entityId: null, entityType: null, citations: [citationFor('a-bad', 'ep-1')] }),
    ).toThrow(ValidationError)
  })

  it('getAssertions with validAt only returns assertions valid at that position', () => {
    store.writeAssertion({ id: 'a-1', namespace: NS, type: 'fact', content: 'Valid at pos 1.', validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1', supersedesId: null, entityId: null, entityType: null, citations: [citationFor('a-1', 'ep-1')] })
    store.writeEpisode({ id: 'ep-10', namespace: NS, position: 10, occurredAt: '2024-01-10T00:00:00Z', type: 'doc', content: 'ep10' })
    store.writeAssertion({ id: 'a-10', namespace: NS, type: 'fact', content: 'Valid from pos 10.', validFrom: 10, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-10', supersedesId: null, entityId: null, entityType: null, citations: [citationFor('a-10', 'ep-10')] })

    const atPos5 = store.getAssertions(NS, { validAt: 5 })
    expect(atPos5.map((a) => a.id)).toContain('a-1')
    expect(atPos5.map((a) => a.id)).not.toContain('a-10')
  })

  it('emits warning for large episode content (does not throw)', () => {
    // maxEpisodeContentBytes defaults to 8192
    const bigContent = 'x'.repeat(9000)
    expect(() =>
      store.writeEpisode({ id: 'ep-big', namespace: NS, position: 2, occurredAt: '', type: 'doc', content: bigContent }),
    ).not.toThrow()
  })

  it('no warning when maxEpisodeContentBytes = 0', () => {
    const storeNoWarn = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM, maxEpisodeContentBytes: 0 })
    // No second init needed — namespace already exists
    storeNoWarn.init()
    const bigContent = 'x'.repeat(9000)
    expect(() =>
      storeNoWarn.writeEpisode({ id: 'ep-big2', namespace: NS, position: 3, occurredAt: '', type: 'doc', content: bigContent }),
    ).not.toThrow()
  })
})

describe('TemporalStore — stats', () => {
  let db: Database
  let store: TemporalStore

  beforeEach(() => {
    db = openTestDb()
    store = makeStore(db)
    store.init()
    store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '', type: 'doc', content: 'c' })
    store.writeAssertion({ id: 'a-1', namespace: NS, type: 'fact', content: 'c1', validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1', supersedesId: null, entityId: null, entityType: null, citations: [citationFor('a-1', 'ep-1')] })
  })

  it('getStats returns correct counts', () => {
    const stats = store.getStats(NS)
    expect(stats.episodeCount).toBe(1)
    expect(stats.assertionCount).toBe(1)
    expect(stats.activeAssertionCount).toBe(1)
    expect(stats.indexedCount).toBe(0)
  })

  it('indexedCount increases after indexing', () => {
    store.indexAssertion('a-1', new Float32Array(DIM))
    expect(store.getStats(NS).indexedCount).toBe(1)
  })
})
