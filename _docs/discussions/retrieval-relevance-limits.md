# Retrieval Relevance, Limits, and Presentation

## Context

The demos are currently the primary dogfood surface for trageti. They show that
`limit` is doing two jobs at once:

- bounding retrieval work, because the pipeline oversamples from `limit`
- bounding final presentation, because only `limit` results are returned

That is workable for small examples, but it is not ideal for temporal RAG. A
demo query such as "What does Alex know about making sourdough today?" should
not silently hide relevant earlier claims just because they fall outside a small
top-N window.

## Observed Shortcomings

### Hard Limits Can Hide Relevant Temporal Context

A fixed top-N result count is easy to understand, but it can exclude important
evidence. This is especially visible in trajectory questions, where an older
claim may be less semantically close to the wording of the query while still
being essential to understanding how knowledge evolved.

### Semantic Distance Is Not a Stable Global Cutoff

Raw vector distance is useful as a ranking signal, but it is not reliably
comparable across embedding providers, models, corpora, or query styles. A
distance threshold that works for one demo setup may be wrong for another.

### Final Score Is Better, But Still Query-Local

The final retrieval score is a better caller-facing relevance signal because it
can combine semantic distance, BM25, confidence, recency, and custom scorer
logic. However, it is still query-local. A score of `0.60` should not be treated
as a universal threshold across providers or applications.

### Retrieval Order and Presentation Order Are Different Concerns

The retrieval pipeline should rank by relevance. A temporal demo often needs to
present by time first, then rank within each time position. That presentation
choice helps users understand knowledge evolution without requiring the core
retrieval API to change ordering semantics.

### Candidate Limits and Result Limits May Need Separation

Because `limit` influences candidate gathering, a future relevance filter cannot
simply replace `limit`. The API may need separate concepts such as:

- candidate cap
- final result cap
- minimum result count
- relative relevance cutoff

## Demo-Side Approach For Now

The demos now use broad retrieval caps and then apply presentation filtering:

1. Retrieve a broad result set.
2. Keep results close to the best returned score.
3. Always show a small minimum when available.
4. Cap displayed results to protect readability.
5. Present results by temporal position first, then rank within each position.

This keeps the demos focused on trageti's existing public API while making the
output more faithful to what the knowledge graph knows.

## Possible Future Library Features

These ideas should be evaluated at the specification level before implementation:

```ts
interface RetrievalQuery {
  candidateLimit?: number
  resultLimit?: number
  relevance?: {
    relativeToBest?: number
    maxDropFromBest?: number
    minResults?: number
    maxResults?: number
  }
  presentation?: {
    order?: 'ranked' | 'temporal'
  }
}
```

Open design questions:

- Should relevance filtering happen before or after hydration?
- Should filtering operate on final score only, or expose scorer-specific hooks?
- How should BM25-only candidates participate when semantic distance is `null`?
- Should temporal ordering be a core retrieval option, or remain a caller
  presentation concern?
- How should debug metadata explain results hidden by relevance filtering?
- Should `assembleContext()` use relevance thresholds in addition to token
  budgets?

## Recommendation

Do not add this API opportunistically from the demos alone. Capture examples from
the demos, then update the v0.3+ specification with a deliberate design for:

- candidate selection
- relative relevance filtering
- result caps
- presentation ordering
- context assembly behavior

