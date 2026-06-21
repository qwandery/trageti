import { describe, it, expect } from 'vitest';
import { LinearScorer } from '../../src/defaults/scoring/LinearScorer.js';
import type { ScoredCandidate, ScoringContext, Assertion } from '../../src/domain/types.js';

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
    citations: [],
    createdAt: '2024-01-01T00:00:00Z',
    extensions: {},
    ...overrides,
  };
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
  };
}

describe('LinearScorer', () => {
  const scorer = new LinearScorer();

  it('returns a number between 0 and 1 (no BM25)', async () => {
    const candidate: ScoredCandidate = {
      assertion: makeAssertion(),
      semanticDistance: 0.3,
      bm25Score: null,
      position: 5,
    };
    const [score] = scorer.scoreBatch([candidate], makeContext());
    expect(score ?? NaN).toBeGreaterThanOrEqual(0);
    expect(score ?? NaN).toBeLessThanOrEqual(1);
  });

  it('perfect semantic match (distance=0) scores higher than poor match (distance=1)', async () => {
    const ctx = makeContext();
    const perfect: ScoredCandidate = {
      assertion: makeAssertion(),
      semanticDistance: 0,
      bm25Score: null,
      position: 5,
    };
    const poor: ScoredCandidate = {
      assertion: makeAssertion(),
      semanticDistance: 1,
      bm25Score: null,
      position: 5,
    };
    const [perfectScore, poorScore] = scorer.scoreBatch([perfect, poor], ctx);
    expect(perfectScore).toBeGreaterThan(poorScore ?? 0);
  });

  it('more recent assertion scores higher than older one with same semantic distance', async () => {
    const ctx = makeContext({ namespacePositionRange: { min: 0, max: 10 } });
    const recent: ScoredCandidate = {
      assertion: makeAssertion({ validFrom: 9 }),
      semanticDistance: 0.5,
      bm25Score: null,
      position: 9,
    };
    const old: ScoredCandidate = {
      assertion: makeAssertion({ validFrom: 1 }),
      semanticDistance: 0.5,
      bm25Score: null,
      position: 1,
    };
    const [recentScore, oldScore] = scorer.scoreBatch([recent, old], ctx);
    expect(recentScore).toBeGreaterThan(oldScore ?? 0);
  });

  it('batch scoring handles raw FTS5 BM25 (negative values)', async () => {
    const ctx = makeContext();
    // v0.2: BM25 arrives as raw FTS5 (negative; more-negative = better).
    const withBm25: ScoredCandidate = {
      assertion: makeAssertion(),
      semanticDistance: 0.5,
      bm25Score: -2.5,
      position: 5,
    };
    const noBm25: ScoredCandidate = {
      assertion: makeAssertion(),
      semanticDistance: 0.5,
      bm25Score: null,
      position: 5,
    };
    const [withBm25Score, noBm25Score] = scorer.scoreBatch([withBm25, noBm25], ctx);
    expect(withBm25Score).not.toBe(noBm25Score);
  });

  it('handles flat position range (min === max) without division by zero', async () => {
    const ctx = makeContext({ namespacePositionRange: { min: 5, max: 5 } });
    const candidate: ScoredCandidate = {
      assertion: makeAssertion({ validFrom: 5 }),
      semanticDistance: 0.2,
      bm25Score: null,
      position: 5,
    };
    expect(() => scorer.scoreBatch([candidate], ctx)).not.toThrow();
  });

  describe('scoreBatch — cross-candidate BM25 normalisation (v0.2)', () => {
    it('returns array of same length as input', async () => {
      const ctx = makeContext();
      const candidates: ScoredCandidate[] = [
        {
          assertion: makeAssertion({ id: 'a' }),
          semanticDistance: 0.1,
          bm25Score: -1.0,
          position: 5,
        },
        {
          assertion: makeAssertion({ id: 'b' }),
          semanticDistance: 0.5,
          bm25Score: -3.0,
          position: 5,
        },
        {
          assertion: makeAssertion({ id: 'c' }),
          semanticDistance: 0.3,
          bm25Score: -2.0,
          position: 5,
        },
      ];
      const scores = scorer.scoreBatch(candidates, ctx);
      expect(scores.length).toBe(3);
      for (const s of scores) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    });

    it('most-negative raw BM25 (best match) gets highest BM25-normalised contribution', async () => {
      const ctx = makeContext();
      // Make semantic + recency identical across candidates so BM25 dominates ranking.
      const candidates: ScoredCandidate[] = [
        {
          assertion: makeAssertion({ id: 'best' }),
          semanticDistance: 0.5,
          bm25Score: -10.0,
          position: 5,
        },
        {
          assertion: makeAssertion({ id: 'worst' }),
          semanticDistance: 0.5,
          bm25Score: -1.0,
          position: 5,
        },
      ];
      const scores = scorer.scoreBatch(candidates, ctx);
      expect(scores[0]).toBeGreaterThan(scores[1] ?? 0);
    });

    it('handles single candidate (range = 0) without NaN', async () => {
      const ctx = makeContext();
      const candidates: ScoredCandidate[] = [
        { assertion: makeAssertion(), semanticDistance: 0.2, bm25Score: -2.0, position: 5 },
      ];
      const scores = scorer.scoreBatch(candidates, ctx);
      expect(scores.length).toBe(1);
      expect(Number.isFinite(scores[0])).toBe(true);
    });

    it('handles identical BM25 scores across candidates (range = 0)', async () => {
      const ctx = makeContext();
      const candidates: ScoredCandidate[] = [
        {
          assertion: makeAssertion({ id: 'a' }),
          semanticDistance: 0.5,
          bm25Score: -2.0,
          position: 5,
        },
        {
          assertion: makeAssertion({ id: 'b' }),
          semanticDistance: 0.5,
          bm25Score: -2.0,
          position: 5,
        },
      ];
      const scores = scorer.scoreBatch(candidates, ctx);
      expect(scores.length).toBe(2);
      expect(scores[0]).toBeCloseTo(scores[1] ?? 0);
    });

    it('handles all-null BM25 (no queryText) like the no-keyword fallback', async () => {
      const ctx = makeContext();
      const candidates: ScoredCandidate[] = [
        {
          assertion: makeAssertion({ id: 'a' }),
          semanticDistance: 0.5,
          bm25Score: null,
          position: 5,
        },
      ];
      const scores = scorer.scoreBatch(candidates, ctx);
      expect(scores.length).toBe(1);
      expect(Number.isFinite(scores[0])).toBe(true);
    });

    it('empty input returns empty output', async () => {
      const ctx = makeContext();
      expect(scorer.scoreBatch([], ctx)).toEqual([]);
    });
  });
});
