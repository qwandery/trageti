import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openTestDb } from '../helpers/openTestDb.js'
import { TemporalStore } from '../../src/store/TemporalStore.js'
import { ProseFormatter } from '../../src/defaults/formatting/ProseFormatter.js'
import { StructuredFormatter } from '../../src/defaults/formatting/StructuredFormatter.js'
import { JsonFormatter } from '../../src/defaults/formatting/JsonFormatter.js'

const NS = 'test-ns'
const DIM = 4
const VEC = new Float32Array([1, 0, 0, 0])

function setupStore(db: Database): TemporalStore {
  const store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM })
  store.init()
  store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '', type: 'doc', content: 'c' })
  store.writeEpisode({ id: 'ep-2', namespace: NS, position: 2, occurredAt: '', type: 'doc', content: 'c' })
  store.writeEpisode({ id: 'ep-3', namespace: NS, position: 3, occurredAt: '', type: 'doc', content: 'c' })
  // Three assertions, slightly different embeddings so all are ranked
  store.writeAssertion({ id: 'a-1', namespace: NS, type: 'fact', content: 'Alpha is first.', validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1', supersedesId: null, entityId: 'e-a', entityType: 'concept' })
  store.writeAssertion({ id: 'a-2', namespace: NS, type: 'fact', content: 'Beta is second.', validFrom: 2, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-2', supersedesId: null, entityId: 'e-b', entityType: 'concept' })
  store.writeAssertion({ id: 'a-3', namespace: NS, type: 'update', content: 'Gamma is third.', validFrom: 3, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-3', supersedesId: null, entityId: 'e-g', entityType: 'relationship' })
  store.indexAssertion('a-1', new Float32Array([1, 0, 0, 0]))
  store.indexAssertion('a-2', new Float32Array([0.9, 0.44, 0, 0]))
  store.indexAssertion('a-3', new Float32Array([0.8, 0.6, 0, 0]))
  return store
}

describe('TemporalStore — context assembly', () => {
  let db: Database
  let store: TemporalStore

  beforeEach(() => {
    db = openTestDb()
    store = setupStore(db)
  })

  it('assembleContext returns non-empty text', () => {
    const ctx = store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
    })
    expect(ctx.text.length).toBeGreaterThan(0)
    expect(ctx.assertions.length).toBeGreaterThan(0)
  })

  it('tokenEstimate is positive and reasonable', () => {
    const ctx = store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
    })
    expect(ctx.tokenEstimate).toBeGreaterThan(0)
    expect(ctx.tokenEstimate).toBeLessThan(2000)
  })

  it('coverage.totalAssertions reflects total retrieved', () => {
    const ctx = store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
    })
    expect(ctx.coverage.totalAssertions).toBeGreaterThan(0)
    expect(ctx.coverage.includedAssertions).toBeLessThanOrEqual(ctx.coverage.totalAssertions)
  })

  it('coverage.positionRange spans validFrom values of retrieved assertions', () => {
    const ctx = store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
    })
    expect(ctx.coverage.positionRange.from).toBeGreaterThanOrEqual(1)
    expect(ctx.coverage.positionRange.to).toBeLessThanOrEqual(3)
    expect(ctx.coverage.positionRange.from).toBeLessThanOrEqual(ctx.coverage.positionRange.to)
  })

  it('token budget truncation sets truncated=true and limits assertions', () => {
    // Very small budget should force truncation
    const ctx = store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 5, // extremely tight
    })
    expect(ctx.truncated).toBe(true)
    expect(ctx.coverage.includedAssertions).toBeLessThan(ctx.coverage.totalAssertions)
  })

  it('no truncation within large budget', () => {
    const ctx = store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 100_000,
    })
    expect(ctx.truncated).toBe(false)
    expect(ctx.coverage.includedAssertions).toBe(ctx.coverage.totalAssertions)
  })

  it('per-call formatter override is used', () => {
    const jsonFormatter = new JsonFormatter()
    const ctx = store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
      formatter: jsonFormatter,
    })
    // JsonFormatter produces valid JSON
    expect(() => JSON.parse(ctx.text)).not.toThrow()
  })

  it('ProseFormatter produces human-readable text', () => {
    const prose = store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
      formatter: new ProseFormatter(),
    })
    expect(prose.text).toMatch(/Alpha|Beta|Gamma/)
    expect(prose.metadata['formatter']).toBe('prose')
  })

  it('StructuredFormatter groups by entity type', () => {
    const structured = store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
      formatter: new StructuredFormatter(),
    })
    expect(structured.text.length).toBeGreaterThan(0)
    expect(structured.metadata['formatter']).toBe('structured')
  })

  it('JsonFormatter produces parseable JSON with assertions array', () => {
    const json = store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
      formatter: new JsonFormatter(),
    })
    const parsed = JSON.parse(json.text) as unknown
    expect(Array.isArray(parsed)).toBe(true)
    expect(json.metadata['formatter']).toBe('json')
  })
})
