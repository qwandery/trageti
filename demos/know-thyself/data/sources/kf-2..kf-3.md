# kf-2..kf-3: v0.3 retrieval, validation, and vectorless namespaces

Source kind: keyframe-pair source bundle
Previous commit: 5695df6 (v0.2 citations + trajectory retrieval)
Current commit: 8350531 (v0.3.0 - phase 6 release)
Date: 2026-05-19

## Commit message

v0.3 phase 6: package metadata, coverage thresholds, verification matrix - v0.3.0

## git diff --stat

```txt
 CHANGELOG.md                                       |  215 ++
 README.md                                          |   20 +-
 _docs/migration-v0.2-to-v0.3.md                    |  198 ++
 _docs/specs/trageti-spec-v0.3-verification.md      |  110 +
 _docs/specs/trageti-spec-v0.3.md                   | 3275 ++++++++++++++++++++
 src/db/migrations/runner.ts                        |   72 +-
 src/db/migrations/v003_vectorless.ts               |   97 +
 src/db/repositories/EmbeddingRepository.ts         |   22 +-
 src/db/repositories/EpisodeRepository.ts           |   50 +-
 src/db/repositories/NamespaceRepository.ts         |   64 +-
 src/defaults/providers/MockEmbeddingProvider.ts    |   39 +
 src/defaults/providers/RawVectorProvider.ts        |   42 +
 src/defaults/scoring/DefaultScorer.ts              |   23 +-
 src/domain/types.ts                                |  258 +-
 src/errors/index.ts                                |  193 +-
 src/internal/logger.ts                             |  130 +-
 src/pipeline/retrieve.ts                           |  125 +-
 src/store/TemporalStore.ts                         |  480 ++-
 test/integration/vectorless-namespace.test.ts      |   85 +
 test/integration/graph-traversal.test.ts           |  173 +-
 59 files changed, 6303 insertions(+), 907 deletions(-)
```

## Material change summary

v0.3 reworks the DefaultScorer into a four-case formula with weight
renormalization across vector and BM25 signals. Retrieval now handles vector,
BM25, hybrid, and unavailable-signal cases more explicitly, making scoring
behavior easier to reason about.

Citations become a structural invariant. Every assertion must carry at least
one citation, and foreign key enforcement plus structural validation guard data
integrity end to end.

Vectorless namespaces are introduced for BM25-only retrieval. This lets a
namespace exist without sqlite-vec vectors, while still allowing callers to
upgrade to vector-backed retrieval later.

## Selected source context

```txt
The DefaultScorer is reworked into a four-case formula with weight
renormalization across vector and BM25 signals.
```

```txt
Citations become a structural invariant: every assertion must carry at least
one citation.
```

```txt
Vectorless namespaces are supported alongside vector namespaces, and structural
validation guards data integrity end to end.
```

