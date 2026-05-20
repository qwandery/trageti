import { describe, it, expect } from 'vitest'
import { DefaultScorer } from '../../src/defaults/scoring/DefaultScorer.js'
import { TragetiError } from '../../src/errors/index.js'
import type { Assertion, ScoredCandidate, ScoringContext } from '../../src/domain/types.js'

const ctx: ScoringContext = {
  temporalAnchor: 10,
  namespacePositionRange: { min: 1, max: 10 },
  query: { namespace: 'x', temporalAnchor: 10 },
}

function candidate(partial: Partial<ScoredCandidate>): ScoredCandidate {
  return {
    assertion: {} as Assertion,
    semanticDistance: null,
    bm25Score: null,
    position: 5,
    ...partial,
  }
}

describe('DefaultScorer.WEIGHTS', () => {
  it('exposes the canonical signal weights', () => {
    expect(DefaultScorer.WEIGHTS).toEqual({ SEMANTIC: 0.6, BM25: 0.3, RECENCY: 0.1 })
  })
})

describe('DefaultScorer.score — single-signal cases', () => {
  const scorer = new DefaultScorer()

  it('scores a vector-only candidate (bm25 null, semantic present)', () => {
    const s = scorer.score(candidate({ semanticDistance: 0.2 }), ctx)
    expect(s).toBeGreaterThan(0)
    expect(Number.isFinite(s)).toBe(true)
  })

  it('scores a bm25-only candidate (semantic null, bm25 present)', () => {
    const s = scorer.score(candidate({ bm25Score: -3.5 }), ctx)
    expect(s).toBeGreaterThan(0)
    expect(Number.isFinite(s)).toBe(true)
  })

  it('throws SCORER_NO_USABLE_SIGNAL when both signals are null', () => {
    expect(() => scorer.score(candidate({}), ctx)).toThrow(TragetiError)
  })
})

describe('DefaultScorer.scoreBatch', () => {
  const scorer = new DefaultScorer()

  it('returns an empty array for no candidates', () => {
    expect(scorer.scoreBatch([], ctx)).toEqual([])
  })

  it('normalises BM25 across the candidate set', () => {
    const scores = scorer.scoreBatch(
      [candidate({ bm25Score: -1 }), candidate({ bm25Score: -9 })],
      ctx,
    )
    expect(scores).toHaveLength(2)
    // The more-negative BM25 (-9) is the stronger keyword hit.
    expect(scores[1]).toBeGreaterThan(scores[0] ?? 0)
  })

  it('handles a single-candidate batch (BM25 range === 0)', () => {
    const scores = scorer.scoreBatch([candidate({ bm25Score: -4 })], ctx)
    expect(scores).toHaveLength(1)
    expect(Number.isFinite(scores[0] ?? NaN)).toBe(true)
  })

  it('throws SCORER_NO_USABLE_SIGNAL when a batched candidate has no signal', () => {
    expect(() => scorer.scoreBatch([candidate({})], ctx)).toThrow(TragetiError)
  })
})
