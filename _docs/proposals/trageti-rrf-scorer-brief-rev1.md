# Reciprocal Rank Fusion (RRF) Scorer for trageti

## Implementation Brief

---

## What RRF Is

Reciprocal Rank Fusion is a rank aggregation algorithm that combines results from multiple ranked lists into a single fused ranking. It was introduced in 2009 by Cormack, Clarke, and Büttcher and demonstrated to outperform both Condorcet Fuse and individual learning-to-rank methods.

The core insight: instead of trying to normalize and combine raw scores from different retrieval systems (which live on incomparable scales), RRF ignores scores entirely and works only with rank positions. Documents that multiple retrievers rank highly get the best fused scores.

## The Formula

For a document `d` appearing across a set of ranked lists `R`:

```
RRF_score(d) = Σ  1 / (k + rank_r(d))
               r∈R
```

Where:

- `k` is a constant, conventionally 60 (from the original paper)
- `rank_r(d)` is the 1-based rank position of document `d` in ranker `r`
- If `d` does not appear in a ranker's results, it contributes 0 from that ranker

That's the entire algorithm.

## Worked Example

Two retrievers — semantic (vector) and keyword (BM25) — each return ranked results for the same query:

```
Semantic results:       BM25 results:
  Rank 1: Doc A          Rank 1: Doc C
  Rank 2: Doc B          Rank 2: Doc A
  Rank 3: Doc C          Rank 3: Doc D
  Rank 4: Doc D          Rank 4: Doc E
```

RRF scores (k=60):

```
Doc A: 1/(60+1) + 1/(60+2) = 0.01639 + 0.01613 = 0.03252  ← winner
Doc C: 1/(60+3) + 1/(60+1) = 0.01587 + 0.01639 = 0.03226
Doc B: 1/(60+2) + 0         = 0.01613                       (BM25 didn't find it)
Doc D: 1/(60+4) + 1/(60+3) = 0.01563 + 0.01587 = 0.03150
Doc E: 0         + 1/(60+4) = 0.01563                       (semantic didn't find it)
```

Doc A wins because both retrievers agree it's relevant. Doc C was #1 in BM25 but only #3 in semantic, so it comes second. Documents found by only one retriever are penalized.

## Why It Works

- **No score normalization needed.** BM25 scores are unbounded negative numbers. Cosine distances are 0–2. Trying to combine them on a common scale is fragile and query-dependent. RRF sidesteps this entirely.
- **Rewards consensus.** A document both retrievers agree on beats a document one retriever loves and the other ignores.
- **One parameter.** `k=60` works well across a wide range of tasks. The original paper tested this empirically. Higher `k` compresses the difference between rank positions; lower `k` amplifies it.
- **No training required.** Unlike learned fusion methods, RRF is deterministic and needs no labeled data.

## Implementation for trageti

RRF is the new default scorer for trageti, replacing the previous weighted linear combination (now shipped as `LinearScorer`). trageti's `IRetrievalScorer` interface has a single method — `scoreBatch` — which receives the full candidate set. This is a natural fit for RRF since rank positions only exist relative to other candidates. The RRF scorer needs to:

1. Sort candidates by semantic distance (ascending — lower distance = better) to determine semantic ranks
2. Sort candidates by BM25 score (ascending for raw negative FTS5 scores — more negative = better match) to determine BM25 ranks
3. Compute RRF score per candidate using both rank positions
4. Handle candidates missing from one signal: if a candidate has no BM25 score (null — no queryText was provided), it contributes 0 from that ranker. Same for unindexed candidates with no semantic score.
5. Handle the recency signal: trageti has three signals, not two. Recency can be treated as a third ranker — sort by position descending, assign ranks, add a third RRF term.

### Interface Change (⚠️ Breaking)

**The `IRetrievalScorer` interface is simplified to a single method.** The library's retrieval pipeline always has the full candidate set available — there is no point where the library needs to score a single candidate in isolation. The previous interface had `score()` as required and `scoreBatch()` as optional, which forced batch-only scorers like RRF to implement `score()` just to throw an error. This was a design smell.

The new contract:

```typescript
interface IRetrievalScorer {
  scoreBatch(candidates: ScoredCandidate[], context: ScoringContext): number[];
}
```

One method. One contract. The library always calls `scoreBatch()`. No optional methods, no runtime checks, no throwing from stub implementations.

Scorers that _can_ score individually (like `LinearScorer`) may expose a public `score()` method on the class for consumer convenience — but it is not part of the interface and the library never calls it.

```typescript
// LinearScorer exposes individual scoring as a class convenience, not an interface obligation
class LinearScorer implements IRetrievalScorer {
  scoreBatch(candidates: ScoredCandidate[], context: ScoringContext): number[] {
    return candidates.map((c) => this.score(c, context));
  }

  // Public convenience — not part of IRetrievalScorer
  score(candidate: ScoredCandidate, context: ScoringContext): number {
    // weighted linear combination
  }
}

// RRFScorer implements scoreBatch directly — no individual score() needed or possible
class RRFScorer implements IRetrievalScorer {
  scoreBatch(candidates: ScoredCandidate[], context: ScoringContext): number[] {
    // rank-based fusion across full candidate set
  }
}
```

### Relationship to Existing Scorers

**`RRFScorer` becomes the default scorer for trageti.** When no scorer is configured, this is what consumers get. It requires no tuning, no score normalization, and one well-established parameter (`k=60`). This aligns with industry practice — Elasticsearch, OpenSearch, Weaviate, and Qdrant all default to RRF for hybrid search.

**`LinearScorer`** is the new name for the previous default (weighted linear combination of normalized signals). It is retained as a shipped alternative for consumers who want direct control over signal weights. It takes configurable `weights: { semantic, keyword, recency }` and handles min-max normalization of BM25 and cosine scores onto a common [0,1] scale before combining. Consumers who choose `LinearScorer` accept responsibility for tuning the weights to their domain.

```typescript
// Default — RRF, no configuration needed
const store = await TemporalStore.create({ ... })

// Explicit RRF with custom k
const store = await TemporalStore.create({
  scorer: new RRFScorer({ k: 40 })
})

// Linear scorer (previous default behavior)
const store = await TemporalStore.create({
  scorer: new LinearScorer({ weights: { semantic: 0.6, keyword: 0.3, recency: 0.1 } })
})
```

### Pseudocode

```typescript
class RRFScorer implements IRetrievalScorer {
  private k: number;
  private includeRecency: boolean;

  constructor(options?: { k?: number; includeRecency?: boolean }) {
    this.k = options?.k ?? 60;
    this.includeRecency = options?.includeRecency ?? true;
  }

  scoreBatch(candidates: ScoredCandidate[], context: ScoringContext): number[] {
    const n = candidates.length;

    // Rank by semantic distance (ascending — lower = better)
    const semanticRanks = rankBy(candidates, (c) => c.semanticDistance, 'asc');

    // Rank by BM25 (for FTS5 raw scores: more negative = better, so ascending)
    const bm25Ranks = rankBy(
      candidates,
      (c) => c.bm25Score,
      'asc', // -5.2 < -3.1, so ascending puts best BM25 first
      true, // skip candidates with null bm25Score
    );

    // Optionally rank by recency (higher position = more recent = better)
    const recencyRanks = this.includeRecency ? rankBy(candidates, (c) => c.position, 'desc') : null;

    // Compute RRF score per candidate
    return candidates.map((_, i) => {
      let score = 0;
      if (semanticRanks[i] !== null) {
        score += 1 / (this.k + semanticRanks[i]);
      }
      if (bm25Ranks[i] !== null) {
        score += 1 / (this.k + bm25Ranks[i]);
      }
      if (recencyRanks && recencyRanks[i] !== null) {
        score += 1 / (this.k + recencyRanks[i]);
      }
      return score;
    });
  }
}

// Helper: assign 1-based ranks; null for candidates excluded from this signal
function rankBy(
  candidates: ScoredCandidate[],
  getValue: (c: ScoredCandidate) => number | null,
  direction: 'asc' | 'desc',
  skipNull: boolean = false,
): (number | null)[] {
  const indexed = candidates.map((c, i) => ({ i, v: getValue(c) }));
  const valid = indexed.filter((x) => x.v !== null);
  valid.sort((a, b) => (direction === 'asc' ? a.v! - b.v! : b.v! - a.v!));
  const ranks: (number | null)[] = new Array(candidates.length).fill(null);
  valid.forEach((x, rank) => {
    ranks[x.i] = rank + 1;
  }); // 1-based
  return ranks;
}
```

### Configuration

```typescript
// Default (no scorer specified) — RRF with k=60, three signals
const store = await TemporalStore.create({ ... })

// RRF with custom k, no recency signal
const store = await TemporalStore.create({
  scorer: new RRFScorer({ k: 40, includeRecency: false })
})

// LinearScorer (previous default) — caller tunes weights
const store = await TemporalStore.create({
  scorer: new LinearScorer({
    weights: { semantic: 0.5, keyword: 0.4, recency: 0.1 }
  })
})
```

## References

**Original paper:**
Cormack, G. V., Clarke, C. L. A., & Büttcher, S. (2009). "Reciprocal Rank Fusion outperforms Condorcet and Individual Rank Learning Methods." SIGIR '09, pp. 758–759.

- PDF: https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf
- ACM: https://dl.acm.org/doi/10.1145/1571941.1572114

**Production implementations:**

- Elasticsearch RRF retriever: https://www.elastic.co/guide/en/elasticsearch/reference/current/rrf.html
- OpenSearch hybrid search: https://opensearch.org/docs/latest/search-plugins/hybrid-search/
- Weaviate hybrid search: https://weaviate.io/developers/weaviate/search/hybrid
- Qdrant hybrid queries: https://qdrant.tech/documentation/concepts/hybrid-queries/

**Explanatory articles:**

- "Reciprocal Rank Fusion: the one-line algorithm behind hybrid search" — https://blog.serghei.pl/posts/reciprocal-rank-fusion-explained/
- "Why Vector Search Alone Isn't Enough: Hybrid Retrieval for RAG" (InfoQ) — https://www.infoq.com/articles/hybrid-retrieval-rag/
