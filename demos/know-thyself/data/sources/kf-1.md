# kf-1: v0.1 initial implementation

Source kind: initial keyframe source bundle
Commit: fac4ada
Label: v0.1 initial implementation
Date: 2026-05-10

## Commit message

Implement trageti v0.1: temporally-aware RAG over SQLite

## Initial state summary

The first keyframe establishes trageti as a TypeScript library for temporally-aware
RAG over SQLite. The public model centers on episodes with sequence numbers,
assertions with validity windows, hybrid retrieval over semantic and keyword
signals, and a TemporalStore API for writing and querying temporal knowledge.

The scoring model combines semantic similarity, BM25 relevance, and recency into
a weighted hybrid score. Retrieval is scoped by namespace and temporal anchor,
so callers can ask what was true at a particular point rather than only asking
for the latest matching text.

## Selected source context

From the v0.1 domain model:

```ts
export interface Episode {
  id: string
  namespace: string
  sequenceNumber: number
  occurredAt: string
  type: string
  content: string
}
```

From the v0.1 retrieval design:

```txt
retrieve(query) searches assertions in a namespace, applies the requested
temporal anchor, combines vector and keyword evidence, and returns ranked
assertions with score components.
```

From the v0.1 scoring behavior:

```txt
DefaultScorer computes a weighted hybrid scoring formula combining semantic
similarity, BM25, and recency.
```

