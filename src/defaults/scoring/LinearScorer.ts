import type { IRetrievalScorer, ScoredCandidate, ScoringContext } from '../../domain/types.js';
import { ErrorCode, TragetiError } from '../../errors/index.js';

export interface LinearScorerWeights {
  semantic: number;
  keyword: number;
  recency: number;
}

export interface LinearScorerOptions {
  weights?: Partial<LinearScorerWeights>;
  recencyMode?: 'namespace-position' | 'anchor-distance';
}

const DEFAULT_WEIGHTS: LinearScorerWeights = {
  semantic: 0.6,
  keyword: 0.3,
  recency: 0.1,
};

function semanticSimilarity(candidate: ScoredCandidate): number | null {
  return candidate.semanticDistance === null ? null : Math.max(0, Math.min(1, 1 - candidate.semanticDistance));
}

function namespaceRecency(candidate: ScoredCandidate, context: ScoringContext): number {
  const { min, max } = context.namespacePositionRange;
  return min !== null && max !== null && max > min ? (candidate.position - min) / (max - min) : 1;
}

function anchorDistanceRecency(candidate: ScoredCandidate, context: ScoringContext): number {
  return 1 / (1 + Math.abs(context.temporalAnchor - candidate.position));
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
  private readonly recencyMode: 'namespace-position' | 'anchor-distance';

  constructor(options: LinearScorerOptions = {}) {
    this.weights = {
      semantic: options.weights?.semantic ?? DEFAULT_WEIGHTS.semantic,
      keyword: options.weights?.keyword ?? DEFAULT_WEIGHTS.keyword,
      recency: options.weights?.recency ?? DEFAULT_WEIGHTS.recency,
    };
    this.recencyMode = options.recencyMode ?? 'namespace-position';
  }

  /**
   * @deprecated Use scoreBatch(). Batch scoring is required for BM25
   * normalization that matches the retrieval pipeline.
   */
  score(candidate: ScoredCandidate, context: ScoringContext): number {
    if (candidate.bm25Score !== null) {
      throw new TragetiError(
        ErrorCode.SCORER_REQUIRES_BATCH_CONTEXT,
        'LinearScorer.score() cannot score BM25 candidates without batch context; use scoreBatch().',
      );
    }
    const semantic = semanticSimilarity(candidate);
    const time = this.recency(candidate, context);

    if (semantic === null) {
      throw new TragetiError(ErrorCode.SCORER_NO_USABLE_SIGNAL, 'candidate has no usable signal');
    }

    const w = this.weights.semantic + this.weights.recency;
    return (this.weights.semantic / w) * semantic + (this.weights.recency / w) * time;
  }

  private recency(candidate: ScoredCandidate, context: ScoringContext): number {
    return this.recencyMode === 'anchor-distance'
      ? anchorDistanceRecency(candidate, context)
      : namespaceRecency(candidate, context);
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
      const time = this.recency(candidate, context);

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
