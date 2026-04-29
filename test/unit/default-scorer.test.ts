import { describe, it, expect } from 'vitest'
import { DefaultScorer } from '../../src/defaults/scoring/DefaultScorer.js'
import type { ScoredCandidate, ScoringContext, Assertion } from '../../src/domain/types.js'

function makeAssertion(overrides: Partial<Assertion> = {}): Assertion {
  return {
    id: 'a-1',
    namespace: 'ns',
    type: 'fact',
    content: 'test',
    validFrom: 5,
    validUntil: null,
    confidence: 1,
    sourceEpisodeId: 'ep-1',
    supersedesId: null,
    entityId: null,
    entityType: null,
    createdAt: '2024-01-01T00:00:00Z',
    extensions: {},
    ...overrides,
  }
}

function makeContext(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    temporalAnchor: 10,
    namespacePositionRange: { min: 0, max: 10 },
    query: {
      namespace: 'ns',
      queryEmbedding: new Float32Array(4),
      temporalAnchor: 10,
    },
    ...overrides,
  }
}

describe('DefaultScorer', () => {
  const scorer = new DefaultScorer()

  it('returns a number between 0 and 1 (no BM25)', () => {
    const candidate: ScoredCandidate = {
      assertion: makeAssertion(),
      semanticDistance: 0.3,
      bm25Score: null,
      position: 5,
    }
    const score = scorer.score(candidate, makeContext())
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('perfect semantic match (distance=0) scores higher than poor match (distance=1)', () => {
    const ctx = makeContext()
    const perfect: ScoredCandidate = { assertion: makeAssertion(), semanticDistance: 0, bm25Score: null, position: 5 }
    const poor: ScoredCandidate = { assertion: makeAssertion(), semanticDistance: 1, bm25Score: null, position: 5 }
    expect(scorer.score(perfect, ctx)).toBeGreaterThan(scorer.score(poor, ctx))
  })

  it('more recent assertion scores higher than older one with same semantic distance', () => {
    const ctx = makeContext({ namespacePositionRange: { min: 0, max: 10 } })
    const recent: ScoredCandidate = { assertion: makeAssertion({ validFrom: 9 }), semanticDistance: 0.5, bm25Score: null, position: 9 }
    const old: ScoredCandidate = { assertion: makeAssertion({ validFrom: 1 }), semanticDistance: 0.5, bm25Score: null, position: 1 }
    expect(scorer.score(recent, ctx)).toBeGreaterThan(scorer.score(old, ctx))
  })

  it('includes BM25 signal when present', () => {
    const ctx = makeContext()
    const withBm25: ScoredCandidate = {
      assertion: makeAssertion(),
      semanticDistance: 0.5,
      bm25Score: 0.8,
      position: 5,
    }
    const noBm25: ScoredCandidate = {
      assertion: makeAssertion(),
      semanticDistance: 0.5,
      bm25Score: null,
      position: 5,
    }
    // With a high BM25 signal, the score should differ
    expect(scorer.score(withBm25, ctx)).not.toBe(scorer.score(noBm25, ctx))
  })

  it('handles flat position range (min === max) without division by zero', () => {
    const ctx = makeContext({ namespacePositionRange: { min: 5, max: 5 } })
    const candidate: ScoredCandidate = { assertion: makeAssertion({ validFrom: 5 }), semanticDistance: 0.2, bm25Score: null, position: 5 }
    expect(() => scorer.score(candidate, ctx)).not.toThrow()
  })
})
