import { describe, it, expect } from 'vitest';
import { DefaultScorer } from '../../src/defaults/scoring/DefaultScorer.js';
import { RRFScorer } from '../../src/defaults/scoring/RRFScorer.js';
import type { Assertion, ScoredCandidate, ScoringContext } from '../../src/domain/types.js';

const ctx: ScoringContext = {
  temporalAnchor: 10,
  namespacePositionRange: { min: 1, max: 10 },
  query: { namespace: 'x', temporalAnchor: 10 },
};

function candidate(partial: Partial<ScoredCandidate>): ScoredCandidate {
  return {
    assertion: {} as Assertion,
    semanticDistance: null,
    bm25Score: null,
    position: 1,
    ...partial,
  };
}

describe('RRFScorer', () => {
  it('returns an empty array for no candidates', () => {
    expect(new RRFScorer().scoreBatch([], ctx)).toEqual([]);
  });

  it('reproduces the semantic plus BM25 consensus ranking', () => {
    const scorer = new RRFScorer({ includeRecency: false });
    const candidates = [
      candidate({ assertion: { id: 'A' } as Assertion, semanticDistance: 0.1, bm25Score: -4, position: 1 }),
      candidate({ assertion: { id: 'B' } as Assertion, semanticDistance: 0.2, bm25Score: null, position: 1 }),
      candidate({ assertion: { id: 'C' } as Assertion, semanticDistance: 0.3, bm25Score: -5, position: 1 }),
      candidate({ assertion: { id: 'D' } as Assertion, semanticDistance: 0.4, bm25Score: -3, position: 1 }),
      candidate({ assertion: { id: 'E' } as Assertion, semanticDistance: null, bm25Score: -2, position: 1 }),
    ];

    const ranked = candidates
      .map((c, i) => ({ id: c.assertion.id, score: scorer.scoreBatch(candidates, ctx)[i] ?? 0 }))
      .sort((a, b) => b.score - a.score);

    expect(ranked.map((r) => r.id)).toEqual(['A', 'C', 'D', 'B', 'E']);
  });

  it('omits null semantic and BM25 signals from their rankers', () => {
    const scorer = new RRFScorer({ includeRecency: false });
    const scores = scorer.scoreBatch(
      [candidate({ semanticDistance: 0.1, bm25Score: null }), candidate({ semanticDistance: null, bm25Score: -10 })],
      ctx,
    );

    expect(scores[0]).toBeCloseTo(1 / 61);
    expect(scores[1]).toBeCloseTo(1 / 61);
  });

  it('can include or omit recency as a ranker', () => {
    const candidates = [
      candidate({ semanticDistance: null, bm25Score: null, position: 1 }),
      candidate({ semanticDistance: null, bm25Score: null, position: 10 }),
    ];
    const withRecency = new RRFScorer().scoreBatch(candidates, ctx);
    const withoutRecency = new RRFScorer({ includeRecency: false }).scoreBatch(candidates, ctx);

    expect(withRecency[1]).toBeGreaterThan(withRecency[0] ?? 0);
    expect(withoutRecency).toEqual([0, 0]);
  });

  it('uses custom k for score magnitude', () => {
    const candidates = [candidate({ semanticDistance: 0.1, bm25Score: -1, position: 1 })];
    const defaultScore = new RRFScorer().scoreBatch(candidates, ctx)[0] ?? 0;
    const customScore = new RRFScorer({ k: 10 }).scoreBatch(candidates, ctx)[0] ?? 0;

    expect(customScore).toBeGreaterThan(defaultScore);
  });

  it('keeps DefaultScorer as a deprecated RRF-compatible export', () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- verifies deprecated compatibility export
    expect(new DefaultScorer().scoreBatch([candidate({ semanticDistance: 0.1 })], ctx)).toEqual(
      new RRFScorer().scoreBatch([candidate({ semanticDistance: 0.1 })], ctx),
    );
  });
});
