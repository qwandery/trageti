import type { IRetrievalScorer, ScoredCandidate, ScoringContext } from '../../domain/types.js';
import { ErrorCode, TragetiError } from '../../errors/index.js';

export interface LinearScorerWeights {
  semantic: number;
  keyword: number;
  recency: number;
}

export interface LinearScorerOptions {
  weights?: Partial<LinearScorerWeights>;
}

const DEFAULT_WEIGHTS: LinearScorerWeights = {
  semantic: 0.6,
  keyword: 0.3,
  recency: 0.1,
};

function semanticSimilarity(candidate: ScoredCandidate): number | null {
  return candidate.semanticDistance === null ? null : Math.max(0, Math.min(1, 1 - candidate.semanticDistance));
}

function recency(candidate: ScoredCandidate, context: ScoringContext): number {
  const { min, max } = context.namespacePositionRange;
  return min !== null && max !== null && max > min ? (candidate.position - min) / (max - min) : 1;
}

/**
 * Weighted linear combination scorer.
 *
 * This is the renamed form of the pre-rev2 default scorer. It is retained for
 * callers who want explicit signal weights instead of rank-based fusion.
 */
export class LinearScorer implements IRetrievalScorer {
  static readonly WEIGHTS = {
    SEMANTIC: DEFAULT_WEIGHTS.semantic,
    BM25: DEFAULT_WEIGHTS.keyword,
    RECENCY: DEFAULT_WEIGHTS.recency,
  } as const;

  private readonly weights: LinearScorerWeights;

  constructor(options: LinearScorerOptions = {}) {
    this.weights = {
      semantic: options.weights?.semantic ?? DEFAULT_WEIGHTS.semantic,
      keyword: options.weights?.keyword ?? DEFAULT_WEIGHTS.keyword,
      recency: options.weights?.recency ?? DEFAULT_WEIGHTS.recency,
    };
  }

  /**
   * Convenience scorer for callers that want to score one candidate directly.
   * The retrieval pipeline does not call this method.
   */
  score(candidate: ScoredCandidate, context: ScoringContext): number {
    const semantic = semanticSimilarity(candidate);
    const time = recency(candidate, context);

    if (candidate.bm25Score !== null) {
      // Raw FTS5 BM25 is negative; more-negative is better.
      const keyword = 1 - 1 / (1 + Math.abs(candidate.bm25Score));
      if (semantic === null) {
        const w = this.weights.keyword + this.weights.recency;
        return (this.weights.keyword / w) * keyword + (this.weights.recency / w) * time;
      }
      return this.weights.semantic * semantic + this.weights.keyword * keyword + this.weights.recency * time;
    }

    if (semantic === null) {
      throw new TragetiError(ErrorCode.SCORER_NO_USABLE_SIGNAL, 'candidate has no usable signal');
    }

    const w = this.weights.semantic + this.weights.recency;
    return (this.weights.semantic / w) * semantic + (this.weights.recency / w) * time;
  }

  scoreBatch(candidates: ScoredCandidate[], context: ScoringContext): number[] {
    if (candidates.length === 0) return [];

    const bm25NormalisedByIndex = new Map<number, number>();
    const bm25Values = candidates
      .map((c, i) => ({ i, score: c.bm25Score }))
      .filter((x): x is { i: number; score: number } => x.score !== null);

    if (bm25Values.length > 0) {
      const raw = bm25Values.map((x) => x.score);
      const minRaw = Math.min(...raw);
      const maxRaw = Math.max(...raw);
      const range = maxRaw - minRaw;
      for (const x of bm25Values) {
        bm25NormalisedByIndex.set(x.i, range > 0 ? 1 - (x.score - minRaw) / range : 1);
      }
    }

    return candidates.map((candidate, i) => {
      const semantic = semanticSimilarity(candidate);
      const time = recency(candidate, context);

      if (candidate.bm25Score !== null) {
        const keyword = bm25NormalisedByIndex.get(i) ?? 0;
        if (semantic === null) {
          const w = this.weights.keyword + this.weights.recency;
          return (this.weights.keyword / w) * keyword + (this.weights.recency / w) * time;
        }
        return this.weights.semantic * semantic + this.weights.keyword * keyword + this.weights.recency * time;
      }

      if (semantic === null) {
        throw new TragetiError(ErrorCode.SCORER_NO_USABLE_SIGNAL, 'candidate has no usable signal');
      }

      const w = this.weights.semantic + this.weights.recency;
      return (this.weights.semantic / w) * semantic + (this.weights.recency / w) * time;
    });
  }
}
