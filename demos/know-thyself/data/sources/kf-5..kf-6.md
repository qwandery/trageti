# kf-5..kf-6.md: v0.3 phase 3 provider-driven indexing -> v0.3 phase 4 retrieval routing

Source kind: keyframe-pair source bundle
Previous commit: 1924f45 (v0.3 phase 3 provider-driven indexing)
Current commit: b73f7c6 (v0.3 phase 4 retrieval routing)
Date: 2026-05-19

## Commit message

v0.3 phase 4: retrieval strategy routing, queryTextMode, deterministic tie-breaks

## git diff --stat

```txt
 src/defaults/scoring/DefaultScorer.ts |   5 +-
 src/pipeline/retrieve.ts              | 126 +++++++++++++++++++++++++---------
 test/integration/middleware.test.ts   |   5 +-
```

## Material change summary

Phase 4 makes retrieval routing explicit. The retrieve pipeline honors strategy selection, queryTextMode, and applied-signal flags so callers can tell whether semantic vectors, BM25, or both participated in a result set.

The phase also adds deterministic tie-break behavior, reducing unstable ordering when scores are equal or nearly equal.

## Selected important file diffs

### src/pipeline/retrieve.ts

```txt
Retrieval strategy routing decides when vector search, BM25 search, or hybrid search should run for a query.
```

### src/pipeline/retrieve.ts

```txt
queryTextMode controls how query text is interpreted for text search rather than forcing every query into the same BM25 behavior.
```

### src/pipeline/retrieve.ts

```txt
Deterministic tie-breaks stabilize retrieval ordering when multiple candidates have comparable scores.
```
