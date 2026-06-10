import type { IRetrievalScorer, ScoredCandidate, ScoringContext } from '../../domain/types.js';

export interface RRFScorerOptions {
  k?: number;
  includeRecency?: boolean;
}

type RankDirection = 'asc' | 'desc';

function rankBy(
  candidates: ScoredCandidate[],
  getValue: (candidate: ScoredCandidate) => number | null,
  direction: RankDirection,
): Array<number | null> {
  const valid = candidates
    .map((candidate, index) => ({ index, value: getValue(candidate) }))
    .filter((item): item is { index: number; value: number } => item.value !== null);

  valid.sort((a, b) => {
    const byValue = direction === 'asc' ? a.value - b.value : b.value - a.value;
    return byValue !== 0 ? byValue : a.index - b.index;
  });

  const ranks: Array<number | null> = new Array<number | null>(candidates.length).fill(null);
  valid.forEach((item, rank) => {
    ranks[item.index] = rank + 1;
  });
  return ranks;
}

/**
 * Reciprocal Rank Fusion scorer.
 *
 * RRF ignores raw score magnitudes and fuses ranked lists from semantic, BM25,
 * and optional recency signals.
 */
export class RRFScorer implements IRetrievalScorer {
  private readonly k: number;
  private readonly includeRecency: boolean;

  constructor(options: RRFScorerOptions = {}) {
    this.k = options.k ?? 60;
    this.includeRecency = options.includeRecency ?? true;
  }

  scoreBatch(candidates: ScoredCandidate[], _context: ScoringContext): number[] {
    if (candidates.length === 0) return [];

    const semanticRanks = rankBy(candidates, (candidate) => candidate.semanticDistance, 'asc');
    const bm25Ranks = rankBy(candidates, (candidate) => candidate.bm25Score, 'asc');
    const recencyRanks = this.includeRecency ? rankBy(candidates, (candidate) => candidate.position, 'desc') : null;

    return candidates.map((_, i) => {
      let score = 0;
      const semanticRank = semanticRanks[i] ?? null;
      const bm25Rank = bm25Ranks[i] ?? null;
      const recencyRank = recencyRanks?.[i] ?? null;

      if (semanticRank !== null) score += 1 / (this.k + semanticRank);
      if (bm25Rank !== null) score += 1 / (this.k + bm25Rank);
      if (recencyRank !== null) score += 1 / (this.k + recencyRank);

      return score;
    });
  }
}
