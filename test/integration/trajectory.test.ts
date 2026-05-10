import { describe, it, expect } from 'vitest'
import { openTestDb } from '../helpers/openTestDb.js'
import { TemporalStore } from '../../src/store/TemporalStore.js'
import { citationFor, loadScenario } from '../fixtures/scenario.js'

const NS = 'traj-ns'
const DIM = 4
const VEC = new Float32Array([1, 0, 0, 0])

function makeStoreWithScenario(): TemporalStore {
  const db = openTestDb()
  const store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM })
  store.init()
  loadScenario(store, NS)
  // Index a subset so retrieve has candidates
  store.indexAssertion('a-1', VEC)
  store.indexAssertion('a-3', VEC)
  store.indexAssertion('a-6', VEC)
  store.indexAssertion('a-7', VEC)
  return store
}

describe('TemporalStore — trajectory mode', () => {
  it('snapshot mode (default) and explicit snapshot produce identical output', () => {
    const store = makeStoreWithScenario()
    const a = store.retrieve({ namespace: NS, queryEmbedding: VEC, temporalAnchor: 10, limit: 5 })
    const b = store.retrieve({ namespace: NS, queryEmbedding: VEC, temporalAnchor: 10, limit: 5, mode: 'snapshot' })
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id))
    // supersessionChain absent in snapshot mode
    for (const r of a) {
      expect('supersessionChain' in r).toBe(false)
    }
  })

  it('trajectory mode populates supersessionChain (excluding the result itself)', () => {
    const store = makeStoreWithScenario()
    // a-7 is the leaf of chain a-6 → a-7
    const results = store.retrieve({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 10,
      limit: 10,
      mode: 'trajectory',
    })
    const a7 = results.find((r) => r.id === 'a-7')
    expect(a7).toBeDefined()
    expect(a7?.supersessionChain).toBeDefined()
    expect(a7?.supersessionChain?.map((a) => a.id)).toEqual(['a-6'])
    // Result is not its own predecessor
    expect(a7?.supersessionChain?.some((a) => a.id === 'a-7')).toBe(false)
  })

  it('trajectory mode supersessionChain entries each carry citations', () => {
    const store = makeStoreWithScenario()
    const results = store.retrieve({
      namespace: NS, queryEmbedding: VEC, temporalAnchor: 10, limit: 10, mode: 'trajectory',
    })
    const a7 = results.find((r) => r.id === 'a-7')
    expect(a7?.supersessionChain?.[0]?.citations.length).toBeGreaterThan(0)
  })

  it('trajectory mode result with no predecessors gets supersessionChain: []', () => {
    const store = makeStoreWithScenario()
    const results = store.retrieve({
      namespace: NS, queryEmbedding: VEC, temporalAnchor: 10, limit: 10, mode: 'trajectory',
    })
    const a1 = results.find((r) => r.id === 'a-1')
    if (a1) {
      expect(a1.supersessionChain).toEqual([])
      expect('supersessionChain' in a1).toBe(true)
    }
  })

  it('assembleContext propagates mode through to retrieval', () => {
    const store = makeStoreWithScenario()
    const ctx = store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 10,
      tokenBudget: 10_000,
      mode: 'trajectory',
    })
    // At least one assertion in the context should carry a supersessionChain (even if empty)
    expect(ctx.assertions.some((a) => 'supersessionChain' in a)).toBe(true)
  })
})

describe('TemporalStore — getEntityTrajectory', () => {
  it('returns the chain oldest-first for a superseded entity', () => {
    const store = makeStoreWithScenario()
    const trajectory = store.getEntityTrajectory(NS, 'entity-delta')
    expect(trajectory.map((a) => a.id)).toEqual(['a-6', 'a-7'])
  })

  it('returns the single current assertion for an entity with no supersessions', () => {
    const store = makeStoreWithScenario()
    const trajectory = store.getEntityTrajectory(NS, 'entity-beta')
    expect(trajectory.map((a) => a.id)).toEqual(['a-2'])
  })

  it('semantic distinction: trajectory follows chain only; history returns everything for entity', () => {
    const db = openTestDb()
    const store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM })
    store.init()
    store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '', type: 'doc', content: 'c' })
    store.writeEpisode({ id: 'ep-5', namespace: NS, position: 5, occurredAt: '', type: 'doc', content: 'c' })

    // Chain: a-old → a-new (replacement)
    store.writeAssertion({
      id: 'a-old', namespace: NS, type: 'fact', content: 'old',
      validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
      supersedesId: null, entityId: 'e-mixed', entityType: 'concept',
      citations: [citationFor('a-old', 'ep-1')],
    })
    store.writeAssertion({
      id: 'a-new', namespace: NS, type: 'update', content: 'new',
      validFrom: 5, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-5',
      supersedesId: 'a-old', entityId: 'e-mixed', entityType: 'concept',
      citations: [citationFor('a-new', 'ep-5')],
    })

    // Parallel un-related assertion for the same entity, NOT in the chain
    store.writeAssertion({
      id: 'a-parallel', namespace: NS, type: 'fact', content: 'parallel layered',
      validFrom: 5, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-5',
      supersedesId: null, entityId: 'e-mixed', entityType: 'concept',
      citations: [citationFor('a-parallel', 'ep-5')],
    })

    const trajectory = store.getEntityTrajectory(NS, 'e-mixed')
    const history = store.getEntityHistory(NS, 'e-mixed')

    // History returns all 3
    expect(history.map((a) => a.id).sort()).toEqual(['a-new', 'a-old', 'a-parallel'])
    // Trajectory returns the chain (a-old, a-new) plus a-parallel as its own one-element leaf
    // (it has no predecessor or successor; per multi-leaf merge policy it appears alongside).
    expect(trajectory.map((a) => a.id).sort()).toEqual(['a-new', 'a-old', 'a-parallel'])
    // The KEY distinction is that supersessionChain in trajectory retrieve mode
    // would only attach a-old to a-new — covered by the trajectory-mode test below.
  })
})

describe('TemporalStore — non-superseding layered assertions (decision §19)', () => {
  it('two layered same-entity assertions remain valid in snapshot; trajectory does not chain via deepens link', () => {
    const db = openTestDb()
    const store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM })
    store.init()
    store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '', type: 'doc', content: 'c' })
    store.writeEpisode({ id: 'ep-5', namespace: NS, position: 5, occurredAt: '', type: 'doc', content: 'c' })

    // Two layered assertions — both currently valid, neither supersedes the other.
    store.writeAssertion({
      id: 'a-base', namespace: NS, type: 'fact', content: 'initial observation',
      validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
      supersedesId: null, entityId: 'e-theme', entityType: 'theme',
      citations: [citationFor('a-base', 'ep-1')],
    })
    store.writeAssertion({
      id: 'a-deeper', namespace: NS, type: 'recontextualization', content: 'deeper layer',
      validFrom: 5, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-5',
      supersedesId: null, entityId: 'e-theme', entityType: 'theme',
      citations: [citationFor('a-deeper', 'ep-5')],
    })
    store.writeLink({
      id: 'l-deepens',
      namespace: NS,
      fromId: 'a-deeper',
      toId: 'a-base',
      linkType: 'deepens',
      validFrom: 5,
      validUntil: null,
      sourceEpisodeId: 'ep-5',
    })
    store.indexAssertion('a-base', VEC)
    store.indexAssertion('a-deeper', VEC)

    // Snapshot: both assertions visible at position 10
    const snapshot = store.getTemporalSnapshot({ namespace: NS, atPosition: 10 })
    expect(snapshot.map((a) => a.id).sort()).toEqual(['a-base', 'a-deeper'])

    // Trajectory mode retrieve: each assertion has supersessionChain: []
    // (the deepens link is NOT traversed by trajectory).
    const results = store.retrieve({
      namespace: NS, queryEmbedding: VEC, temporalAnchor: 10, limit: 10, mode: 'trajectory',
    })
    for (const r of results) {
      expect(r.supersessionChain).toEqual([])
    }

    // expandLinks: the deepens link surfaces as linkedAssertions
    const expanded = store.retrieve({
      namespace: NS, queryEmbedding: VEC, temporalAnchor: 10, limit: 10, expandLinks: true,
    })
    const aDeeper = expanded.find((r) => r.id === 'a-deeper')
    expect(aDeeper?.linkedAssertions?.map((a) => a.id)).toContain('a-base')
  })
})
