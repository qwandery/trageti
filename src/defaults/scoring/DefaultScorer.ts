import type { RetrievalScorer, ScoredCandidate, ScoringContext } from '../../domain/types.js'

const WEIGHT_SEMANTIC = 0.6
const WEIGHT_BM25 = 0.3
const WEIGHT_RECENCY = 0.1

/**
 * Weighted linear combination scorer.
 *
 * Inputs expected from the retrieve pipeline:
 *   semanticDistance — cosine distance [0, ∞); converted to similarity = max(0, 1 - distance)
 *   bm25Score        — normalised to [0, 1] by the pipeline (FTS5 raw values are negative;
 *                      the pipeline min-max normalises over the candidate set before scoring)
 *   position         — validFrom; normalised to [0, 1] using namespace position range
 *
 * When bm25Score is null (no queryText), semantic and recency weights are renormalised to sum to 1.
 */
export class DefaultScorer implements RetrievalScorer {
  score(candidate: ScoredCandidate, context: ScoringContext): number {
    const semanticSimilarity = Math.max(0, Math.min(1, 1 - candidate.semanticDistance))

    const { min, max } = context.namespacePositionRange
    const recency = max > min ? (candidate.position - min) / (max - min) : 1

    if (candidate.bm25Score !== null) {
      const bm25Normalised = Math.max(0, Math.min(1, candidate.bm25Score))
      return (
        WEIGHT_SEMANTIC * semanticSimilarity +
        WEIGHT_BM25 * bm25Normalised +
        WEIGHT_RECENCY * recency
      )
    }

    // No keyword signal — renormalise remaining weights to sum to 1
    const w = WEIGHT_SEMANTIC + WEIGHT_RECENCY
    return (WEIGHT_SEMANTIC / w) * semanticSimilarity + (WEIGHT_RECENCY / w) * recency
  }
}
