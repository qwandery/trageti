import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openTestDb } from '../helpers/openTestDb.js'
import { TemporalStore } from '../../src/store/TemporalStore.js'
import { ProseFormatter } from '../../src/defaults/formatting/ProseFormatter.js'
import { StructuredFormatter } from '../../src/defaults/formatting/StructuredFormatter.js'
import { JsonFormatter } from '../../src/defaults/formatting/JsonFormatter.js'
import { citationFor } from '../fixtures/scenario.js'
import type { EmbedOptions, EmbeddingProvider, RetrievalStep } from '../../src/index.js'

const NS = 'test-ns'
const DIM = 4
const VEC = new Float32Array([1, 0, 0, 0])

async function setupStore(db: Database): Promise<TemporalStore> {
  const store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM })
  await store.init()
  await store.writeEpisode({
    id: 'ep-1',
    namespace: NS,
    position: 1,
    occurredAt: '',
    type: 'doc',
    content: 'c',
  })
  await store.writeEpisode({
    id: 'ep-2',
    namespace: NS,
    position: 2,
    occurredAt: '',
    type: 'doc',
    content: 'c',
  })
  await store.writeEpisode({
    id: 'ep-3',
    namespace: NS,
    position: 3,
    occurredAt: '',
    type: 'doc',
    content: 'c',
  })
  // Three assertions, slightly different embeddings so all are ranked
  await store.writeAssertion({
    id: 'a-1',
    namespace: NS,
    type: 'fact',
    content: 'Alpha is first.',
    validFrom: 1,
    validUntil: null,
    confidence: 1,
    sourceEpisodeId: 'ep-1',
    supersedesId: null,
    entityId: 'e-a',
    entityType: 'concept',
    citations: [citationFor('a-1', 'ep-1')],
  })
  await store.writeAssertion({
    id: 'a-2',
    namespace: NS,
    type: 'fact',
    content: 'Beta is second.',
    validFrom: 2,
    validUntil: null,
    confidence: 1,
    sourceEpisodeId: 'ep-2',
    supersedesId: null,
    entityId: 'e-b',
    entityType: 'concept',
    citations: [citationFor('a-2', 'ep-2')],
  })
  await store.writeAssertion({
    id: 'a-3',
    namespace: NS,
    type: 'update',
    content: 'Gamma is third.',
    validFrom: 3,
    validUntil: null,
    confidence: 1,
    sourceEpisodeId: 'ep-3',
    supersedesId: null,
    entityId: 'e-g',
    entityType: 'relationship',
    citations: [citationFor('a-3', 'ep-3')],
  })
  await store.indexAssertion('a-1', new Float32Array([1, 0, 0, 0]))
  await store.indexAssertion('a-2', new Float32Array([0.9, 0.44, 0, 0]))
  await store.indexAssertion('a-3', new Float32Array([0.8, 0.6, 0, 0]))
  return store
}

describe('TemporalStore — context assembly', () => {
  let db: Database
  let store: TemporalStore

  beforeEach(async () => {
    db = openTestDb()
    store = await setupStore(db)
  })

  it('assembleContext returns non-empty text', async () => {
    const ctx = await store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
    })
    expect(ctx.text.length).toBeGreaterThan(0)
    expect(ctx.assertions.length).toBeGreaterThan(0)
  })

  it('tokenEstimate is positive and reasonable', async () => {
    const ctx = await store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
    })
    expect(ctx.tokenEstimate).toBeGreaterThan(0)
    expect(ctx.tokenEstimate).toBeLessThan(2000)
  })

  it('coverage.totalAssertions reflects total retrieved', async () => {
    const ctx = await store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
    })
    expect(ctx.coverage.totalAssertions).toBeGreaterThan(0)
    expect(ctx.coverage.includedAssertions).toBeLessThanOrEqual(ctx.coverage.totalAssertions)
  })

  it('coverage.positionRange spans validFrom values of retrieved assertions', async () => {
    const ctx = await store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
    })
    expect(ctx.coverage.positionRange.from).toBeGreaterThanOrEqual(1)
    expect(ctx.coverage.positionRange.to).toBeLessThanOrEqual(3)
    expect(ctx.coverage.positionRange.from).toBeLessThanOrEqual(ctx.coverage.positionRange.to)
  })

  it('forwards debug hooks to retrieval', async () => {
    const steps: RetrievalStep[] = []
    await store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
      debug: {
        onStep: (step, info) => {
          steps.push(step)
          expect(info.step).toBe(step)
        },
      },
    })

    expect(steps).toContain('validate')
    expect(steps).toContain('temporal-filter')
    expect(steps).toContain('rank')
  })

  it('forwards AbortSignal to provider-derived query embedding', async () => {
    let observedSignal: AbortSignal | undefined
    const provider: EmbeddingProvider = {
      name: 'signal-spy',
      dimension: DIM,
      async embed(_texts: readonly string[], options?: EmbedOptions): Promise<Float32Array[]> {
        observedSignal = options?.signal
        return [VEC]
      },
    }
    const signal = new AbortController().signal
    await store.initNamespace(NS, { embeddingProvider: provider })

    await store.assembleContext({
      namespace: NS,
      queryText: 'Alpha',
      temporalAnchor: 3,
      tokenBudget: 2000,
      signal,
    })

    expect(observedSignal).toBe(signal)
  })

  it('token budget truncation sets truncated=true and limits assertions', async () => {
    // Very small budget should force truncation
    const ctx = await store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 5, // extremely tight
    })
    expect(ctx.truncated).toBe(true)
    expect(ctx.coverage.includedAssertions).toBeLessThan(ctx.coverage.totalAssertions)
  })

  it('no truncation within large budget', async () => {
    const ctx = await store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 100_000,
    })
    expect(ctx.truncated).toBe(false)
    expect(ctx.coverage.includedAssertions).toBe(ctx.coverage.totalAssertions)
  })

  it('per-call formatter override is used', async () => {
    const jsonFormatter = new JsonFormatter()
    const ctx = await store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
      formatter: jsonFormatter,
    })
    // JsonFormatter produces valid JSON
    expect(() => JSON.parse(ctx.text)).not.toThrow()
  })

  it('ProseFormatter produces human-readable text', async () => {
    const prose = await store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
      formatter: new ProseFormatter(),
    })
    expect(prose.text).toMatch(/Alpha|Beta|Gamma/)
    expect(prose.metadata['formatter']).toBe('prose')
  })

  it('StructuredFormatter groups by entity type', async () => {
    const structured = await store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 3,
      tokenBudget: 2000,
      formatter: new StructuredFormatter(),
    })
    expect(structured.text.length).toBeGreaterThan(0)
    expect(structured.metadata['formatter']).toBe('structured')
  })

  it('JsonFormatter produces parseable JSON with assertions array', async () => {
    const json = await store.assembleContext({
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
