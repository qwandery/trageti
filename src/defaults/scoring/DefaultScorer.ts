import type { RetrievalScorer, ScoredCandidate, ScoringContext } from '../../domain/types.js';
import { ErrorCode, TragetiError } from '../../errors/index.js';

const WEIGHT_SEMANTIC = 0.6;
const WEIGHT_BM25 = 0.3;
const WEIGHT_RECENCY = 0.1;

/**
 * Weighted linear combination scorer.
 *
 * v0.2 contract change (BREAKING for custom scorers): bm25Score arrives as the
 * raw FTS5 BM25 value (negative; more-negative = better) instead of the
 * pre-normalised [0, 1] value the pipeline used to compute. Normalisation now
 * happens here, in scoreBatch(), across the full candidate set. Custom scorers
 * that need cross-candidate normalisation should implement scoreBatch as well;
 * those that don't can keep using the per-candidate score() with the raw BM25
 * value.
 *
 * Inputs:
 *   semanticDistance — cosine distance [0, ∞); converted to similarity = max(0, 1 - distance)
 *   bm25Score        — raw FTS5 (negative when present, null when no queryText)
 *   position         — validFrom; normalised by the namespace position range
 *
 * When bm25Score is null (no queryText), semantic and recency weights are renormalised to sum to 1.
 */
export class DefaultScorer implements RetrievalScorer {
  /** The signal weights used by the default scoring formula. Exposed so
   *  callers and custom scorers can reference the canonical values. */
  static readonly WEIGHTS = {
    SEMANTIC: WEIGHT_SEMANTIC,
    BM25: WEIGHT_BM25,
    RECENCY: WEIGHT_RECENCY,
  } as const;

  /**
   * Per-candidate score. Used when scoreBatch is bypassed or for callers that
   * call score() directly. Without cross-candidate context, BM25 cannot be
   * meaningfully normalised; this fallback uses tanh-style compression.
   */
  score(candidate: ScoredCandidate, context: ScoringContext): number {
    const semanticSimilarity =
      candidate.semanticDistance === null ? null : Math.max(0, Math.min(1, 1 - candidate.semanticDistance));
    const { min, max } = context.namespacePositionRange;
    const recency = min !== null && max !== null && max > min ? (candidate.position - min) / (max - min) : 1;

    if (candidate.bm25Score !== null) {
      // Raw FTS5: negative, more-negative = better. Compress while preserving that order.
      const bm25 = 1 - 1 / (1 + Math.abs(candidate.bm25Score));
      if (semanticSimilarity === null) {
        const w = WEIGHT_BM25 + WEIGHT_RECENCY;
        return (WEIGHT_BM25 / w) * bm25 + (WEIGHT_RECENCY / w) * recency;
      }
      return WEIGHT_SEMANTIC * semanticSimilarity + WEIGHT_BM25 * bm25 + WEIGHT_RECENCY * recency;
    }
    if (semanticSimilarity === null) {
      throw new TragetiError(ErrorCode.SCORER_NO_USABLE_SIGNAL, 'candidate has no usable signal');
    }
    const w = WEIGHT_SEMANTIC + WEIGHT_RECENCY;
    return (WEIGHT_SEMANTIC / w) * semanticSimilarity + (WEIGHT_RECENCY / w) * recency;
  }

  /**
   * Batch scorer with cross-candidate BM25 min-max normalisation. When BM25
   * scores are present, they are inverted (negate), then min-max normalised
   * across the candidate set to yield a [0, 1] keyword signal. Equivalent to
   * the pre-v0.2 pipeline behaviour, just relocated to the scorer per spec.
   */
  scoreBatch(candidates: ScoredCandidate[], context: ScoringContext): number[] {
    if (candidates.length === 0) return [];

    // Build BM25 normalisation map across the candidate set
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
        // FTS5 BM25 is negative; more-negative = better. Map min -> 1, max -> 0.
        const norm = range > 0 ? 1 - (x.score - minRaw) / range : 1;
        bm25NormalisedByIndex.set(x.i, norm);
      }
    }

    const { min, max } = context.namespacePositionRange;
    return candidates.map((candidate, i) => {
      const semanticSimilarity =
        candidate.semanticDistance === null ? null : Math.max(0, Math.min(1, 1 - candidate.semanticDistance));
      const recency = min !== null && max !== null && max > min ? (candidate.position - min) / (max - min) : 1;

      if (candidate.bm25Score !== null) {
        const bm25 = bm25NormalisedByIndex.get(i) ?? 0;
        if (semanticSimilarity === null) {
          const w = WEIGHT_BM25 + WEIGHT_RECENCY;
          return (WEIGHT_BM25 / w) * bm25 + (WEIGHT_RECENCY / w) * recency;
        }
        return WEIGHT_SEMANTIC * semanticSimilarity + WEIGHT_BM25 * bm25 + WEIGHT_RECENCY * recency;
      }
      if (semanticSimilarity === null) {
        throw new TragetiError(ErrorCode.SCORER_NO_USABLE_SIGNAL, 'candidate has no usable signal');
      }
      const w = WEIGHT_SEMANTIC + WEIGHT_RECENCY;
      return (WEIGHT_SEMANTIC / w) * semanticSimilarity + (WEIGHT_RECENCY / w) * recency;
    });
  }
}
