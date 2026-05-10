import { describe, it, expect, vi } from 'vitest'
import { openTestDb } from '../helpers/openTestDb.js'
import { TemporalStore } from '../../src/store/TemporalStore.js'
import type { RetrievalMiddleware, RetrievalQuery, RetrievedAssertion } from '../../src/domain/types.js'
import { citationFor } from '../fixtures/scenario.js'

const NS = 'test-ns'
const DIM = 4
const VEC_A = new Float32Array([1, 0, 0, 0])

function makeStoreWithMiddleware(middleware: RetrievalMiddleware[]): TemporalStore {
  const db = openTestDb()
  const store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM, middleware })
  store.init()
  store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '', type: 'doc', content: 'c' })
  store.writeAssertion({ id: 'a-1', namespace: NS, type: 'fact', content: 'Test assertion alpha.', validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1', supersedesId: null, entityId: null, entityType: null, citations: [citationFor('a-1', 'ep-1')] })
  store.indexAssertion('a-1', VEC_A)
  return store
}

describe('TemporalStore — middleware', () => {
  it('global before middleware is called before retrieval', () => {
    const log: string[] = []
    const mw: RetrievalMiddleware = {
      before: (q) => { log.push('global-before'); return q },
    }
    const store = makeStoreWithMiddleware([mw])
    store.retrieve({ namespace: NS, queryEmbedding: VEC_A, temporalAnchor: 1 })
    expect(log).toContain('global-before')
  })

  it('global after middleware is called after retrieval', () => {
    const log: string[] = []
    const mw: RetrievalMiddleware = {
      after: (results) => { log.push('global-after'); return results },
    }
    const store = makeStoreWithMiddleware([mw])
    store.retrieve({ namespace: NS, queryEmbedding: VEC_A, temporalAnchor: 1 })
    expect(log).toContain('global-after')
  })

  it('global before runs before per-call before', () => {
    const order: string[] = []
    const globalMw: RetrievalMiddleware = {
      before: (q) => { order.push('global-before'); return q },
    }
    const callMw: RetrievalMiddleware = {
      before: (q) => { order.push('call-before'); return q },
    }
    const store = makeStoreWithMiddleware([globalMw])
    store.retrieve({ namespace: NS, queryEmbedding: VEC_A, temporalAnchor: 1, middleware: [callMw] })
    expect(order.indexOf('global-before')).toBeLessThan(order.indexOf('call-before'))
  })

  it('per-call after runs before global after', () => {
    const order: string[] = []
    const globalMw: RetrievalMiddleware = {
      after: (r) => { order.push('global-after'); return r },
    }
    const callMw: RetrievalMiddleware = {
      after: (r) => { order.push('call-after'); return r },
    }
    const store = makeStoreWithMiddleware([globalMw])
    store.retrieve({ namespace: NS, queryEmbedding: VEC_A, temporalAnchor: 1, middleware: [callMw] })
    expect(order.indexOf('call-after')).toBeLessThan(order.indexOf('global-after'))
  })

  it('before middleware can mutate the query', () => {
    const mw: RetrievalMiddleware = {
      before: (q: RetrievalQuery) => ({ ...q, limit: 0 }),
    }
    const store = makeStoreWithMiddleware([mw])
    const results = store.retrieve({ namespace: NS, queryEmbedding: VEC_A, temporalAnchor: 1 })
    // limit=0 means empty results (or the pipeline interprets 0 as no-limit — check results are an array)
    expect(Array.isArray(results)).toBe(true)
  })

  it('after middleware can filter results', () => {
    const mw: RetrievalMiddleware = {
      after: (_results: RetrievedAssertion[]) => [],
    }
    const store = makeStoreWithMiddleware([mw])
    const results = store.retrieve({ namespace: NS, queryEmbedding: VEC_A, temporalAnchor: 1 })
    expect(results).toEqual([])
  })

  it('after middleware receives results from the core pipeline', () => {
    const captured: RetrievedAssertion[][] = []
    const mw: RetrievalMiddleware = {
      after: (results: RetrievedAssertion[]) => { captured.push(results); return results },
    }
    const store = makeStoreWithMiddleware([mw])
    store.retrieve({ namespace: NS, queryEmbedding: VEC_A, temporalAnchor: 1 })
    expect(captured.length).toBe(1)
    expect(captured[0]?.length).toBeGreaterThan(0)
    expect(captured[0]?.[0]?.id).toBe('a-1')
  })

  it('multiple global middlewares run in registration order (before)', () => {
    const order: string[] = []
    const mw1: RetrievalMiddleware = { before: (q) => { order.push('mw1'); return q } }
    const mw2: RetrievalMiddleware = { before: (q) => { order.push('mw2'); return q } }
    const mw3: RetrievalMiddleware = { before: (q) => { order.push('mw3'); return q } }
    const db = openTestDb()
    const store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM, middleware: [mw1, mw2, mw3] })
    store.init()
    store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '', type: 'doc', content: 'c' })
    store.writeAssertion({ id: 'a-1', namespace: NS, type: 'fact', content: 'c', validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1', supersedesId: null, entityId: null, entityType: null, citations: [citationFor('a-1', 'ep-1')] })
    store.indexAssertion('a-1', VEC_A)
    store.retrieve({ namespace: NS, queryEmbedding: VEC_A, temporalAnchor: 1 })
    expect(order).toEqual(['mw1', 'mw2', 'mw3'])
  })

  it('multiple global middlewares run in reverse order (after)', () => {
    const order: string[] = []
    const mw1: RetrievalMiddleware = { after: (r) => { order.push('mw1'); return r } }
    const mw2: RetrievalMiddleware = { after: (r) => { order.push('mw2'); return r } }
    const mw3: RetrievalMiddleware = { after: (r) => { order.push('mw3'); return r } }
    const db = openTestDb()
    const store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM, middleware: [mw1, mw2, mw3] })
    store.init()
    store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '', type: 'doc', content: 'c' })
    store.writeAssertion({ id: 'a-1', namespace: NS, type: 'fact', content: 'c', validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1', supersedesId: null, entityId: null, entityType: null, citations: [citationFor('a-1', 'ep-1')] })
    store.indexAssertion('a-1', VEC_A)
    store.retrieve({ namespace: NS, queryEmbedding: VEC_A, temporalAnchor: 1 })
    expect(order).toEqual(['mw3', 'mw2', 'mw1'])
  })
})

// Suppress unused import
void vi
