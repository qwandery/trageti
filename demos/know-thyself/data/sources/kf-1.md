# kf-1.md: v0.1 implementation

Source kind: initial keyframe source bundle
Commit: fac4ada
Date: 2026-04-29

## Commit message

Implement trageti v0.1: temporally-aware RAG over SQLite

## git show --stat

```txt
fac4ada Implement trageti v0.1: temporally-aware RAG over SQLite
 README.md                                  | 328 ++
 src/db/migrations/v001_initial.ts          | 119 +
 src/db/repositories/AssertionRepository.ts | 169 +
 src/db/repositories/EmbeddingRepository.ts |  73 +
 src/db/repositories/EpisodeRepository.ts   |  67 +
 src/defaults/scoring/DefaultScorer.ts      |  73 +
 src/pipeline/retrieve.ts                   | 142 +
 src/store/TemporalStore.ts                 | 312 +
 test/integration/e2e.test.ts               | 221 +
```

## Material change summary

v0.1 establishes trageti as a TypeScript library for temporally aware retrieval over SQLite. The core unit is an episode with an ordinal sequenceNumber, and assertions attach to episodes with validity windows. Retrieval combines vector distance, BM25 text search, and recency into a weighted hybrid score.

The initial implementation includes TemporalStore, schema migrations, repositories, default graph/scoring/formatting components, and integration tests. Citations are not yet a structural requirement in v0.1; assertions can be written without citation rows.

## Selected source context

### src/defaults/scoring/DefaultScorer.ts

```txt
The v0.1 scorer combines semantic similarity, BM25 text score, and recency into one weighted score.
```

### src/domain/types.ts

```txt
The v0.1 temporal model uses Episode.sequenceNumber as the caller-supplied ordering field for snapshot and retrieval behavior.
```

### src/store/TemporalStore.ts

```txt
TemporalStore writes episodes, assertions, links, and embeddings through SQLite repositories and exposes retrieval methods over that stored state.
```
