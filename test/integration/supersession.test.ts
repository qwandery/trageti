import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openTestDb } from '../helpers/openTestDb.js'
import { TemporalStore } from '../../src/store/TemporalStore.js'
import { ValidationError } from '../../src/errors/index.js'
import { citationFor } from '../fixtures/scenario.js'

const NS = 'test-ns'
const NS2 = 'other-ns'
const DIM = 4

function makeStore(db: Database, namespace = NS): TemporalStore {
  return new TemporalStore(db, { namespace, embeddingDimension: DIM })
}

describe('TemporalStore — supersession', () => {
  let db: Database
  let store: TemporalStore

  beforeEach(async () => {
    db = openTestDb()
    store = makeStore(db)
    await store.init()
    await store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '2024-01-01T00:00:00Z', type: 'doc', content: 'ep1' })
    await store.writeEpisode({ id: 'ep-5', namespace: NS, position: 5, occurredAt: '2024-01-05T00:00:00Z', type: 'doc', content: 'ep5' })
    await store.writeAssertion({ id: 'a-1', namespace: NS, type: 'fact', content: 'Original claim.', validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1', supersedesId: null, entityId: 'entity-x', entityType: 'concept', citations: [citationFor('a-1', 'ep-1')] })
  })

  it('supersedeAssertion sets validUntil on the original assertion', async () => {
    await store.supersedeAssertion('a-1', { validUntil: 5 })
    const assertions = await store.getAssertions(NS, { includeSuperseded: true })
    const original = assertions.find((a) => a.id === 'a-1')
    expect(original?.validUntil).toBe(5)
  })

  it('superseded assertion no longer appears at validUntil position', async () => {
    await store.supersedeAssertion('a-1', { validUntil: 5 })
    const atPos5 = await store.getAssertions(NS, { validAt: 5 })
    expect(atPos5.map((a) => a.id)).not.toContain('a-1')
  })

  it('superseded assertion still appears before validUntil', async () => {
    await store.supersedeAssertion('a-1', { validUntil: 5 })
    const atPos3 = await store.getAssertions(NS, { validAt: 3 })
    expect(atPos3.map((a) => a.id)).toContain('a-1')
  })

  it('writeAssertion with supersedesId atomically closes the predecessor', async () => {
    // v0.2 atomic supersession: writing the replacement closes the predecessor.
    await store.writeAssertion({ id: 'a-2', namespace: NS, type: 'fact', content: 'Updated claim.', validFrom: 5, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-5', supersedesId: 'a-1', entityId: 'entity-x', entityType: 'concept', citations: [citationFor('a-2', 'ep-5')] })
    const all = await store.getAssertions(NS, { includeSuperseded: true })
    const original = all.find((a) => a.id === 'a-1')
    expect(original?.validUntil).toBe(5)
  })

  it('supersedeAssertion does NOT modify supersedes_id on the predecessor (regression for v0.1 bug)', async () => {
    // v0.1 bug: supersedeAssertion with replacedById overwrote old.supersedes_id.
    // v0.2 fix: supersedes_id is strictly new -> old; supersedeAssertion only writes valid_until.
    await store.supersedeAssertion('a-1', { validUntil: 5, replacedById: 'some-id' })
    const a1 = (await store.getAssertions(NS, { includeSuperseded: true })).find((a) => a.id === 'a-1')
    expect(a1?.supersedesId).toBeNull()
  })

  it('rejects supersedeAssertion when validUntil <= validFrom', async () => {
    await expect(store.supersedeAssertion('a-1', { validUntil: 1 })).rejects.toThrow(ValidationError)
  })

  it('rejects supersedeAssertion for non-existent assertion', async () => {
    await expect(store.supersedeAssertion('no-such', { validUntil: 10 })).rejects.toThrow(ValidationError)
  })

  it('rejects supersedeAssertion on already-closed assertion (strict policy)', async () => {
    // Once an assertion is closed (via auto-supersession or earlier supersedeAssertion),
    // mutating its validity window risks chain inconsistency. v0.2 rejects it.
    await store.supersedeAssertion('a-1', { validUntil: 5 })
    await expect(store.supersedeAssertion('a-1', { validUntil: 7 })).rejects.toThrow(ValidationError)
  })

  it('rejects cross-namespace replacedById', async () => {
    await store.initNamespace(NS2)
    await store.writeEpisode({ id: 'ep-other', namespace: NS2, position: 1, occurredAt: '', type: 'doc', content: 'c' })
    await store.writeAssertion({ id: 'a-other', namespace: NS2, type: 'fact', content: 'Other ns claim.', validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-other', supersedesId: null, entityId: null, entityType: null, citations: [citationFor('a-other', 'ep-other')] })

    await expect(store.supersedeAssertion('a-1', { validUntil: 5, replacedById: 'a-other' })).rejects.toThrow(ValidationError)
  })

  it('getEntityHistory returns all assertions for entity including superseded', async () => {
    // writeAssertion with supersedesId atomically closes a-1; no explicit supersedeAssertion needed.
    await store.writeAssertion({ id: 'a-2', namespace: NS, type: 'fact', content: 'Updated claim.', validFrom: 5, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-5', supersedesId: 'a-1', entityId: 'entity-x', entityType: 'concept', citations: [citationFor('a-2', 'ep-5')] })

    const history = await store.getEntityHistory(NS, 'entity-x')
    expect(history.length).toBe(2)
    expect(history.map((a) => a.id)).toContain('a-1')
    expect(history.map((a) => a.id)).toContain('a-2')
  })

  it('getEntityHistory returns in ascending position order', async () => {
    await store.writeAssertion({ id: 'a-2', namespace: NS, type: 'fact', content: 'Updated claim.', validFrom: 5, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-5', supersedesId: 'a-1', entityId: 'entity-x', entityType: 'concept', citations: [citationFor('a-2', 'ep-5')] })

    const history = await store.getEntityHistory(NS, 'entity-x')
    expect(history[0]?.id).toBe('a-1')
    expect(history[1]?.id).toBe('a-2')
  })
})
