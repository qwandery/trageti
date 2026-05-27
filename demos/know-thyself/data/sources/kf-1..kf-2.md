# kf-1..kf-2: citations and trajectory retrieval

Source kind: keyframe-pair source bundle
Previous commit: fac4ada (v0.1 initial implementation)
Current commit: 5695df6 (v0.2 citations + trajectory retrieval)
Date: 2026-05-10

## Commit message

Implement trageti v0.2: citations and trajectory retrieval

## git diff --stat

```txt
 .changeset/v0.2-citations-and-trajectory.md        |   86 ++
 AGENTS.md                                          |   33 +
 README.md                                          |  159 ++-
 _docs/dev/README.md                                |  770 +++++++++++++
 _docs/specs/trageti-spec-v0.2.md                   | 1158 ++++++++++++++++++++
 src/db/migrations/index.ts                         |    3 +-
 src/db/migrations/v002_citations.ts                |   34 +
 src/db/repositories/AssertionRepository.ts         |  145 ++-
 src/db/repositories/CitationRepository.ts          |  132 +++
 src/defaults/formatting/JsonFormatter.ts           |   37 +-
 src/defaults/formatting/ProseFormatter.ts          |   12 +-
 src/defaults/formatting/StructuredFormatter.ts     |    9 +-
 src/defaults/scoring/DefaultScorer.ts              |   73 +-
 src/defaults/validation/DefaultAssertionValidator.ts|   55 +-
 src/domain/types.ts                                |   74 +-
 src/domain/vocabulary.ts                           |   24 +
 src/pipeline/retrieve.ts                           |  117 +-
 src/store/TemporalStore.ts                         |  153 ++-
 test/integration/citations.test.ts                 |  300 +++++
 test/integration/trajectory.test.ts                |  197 ++++
 48 files changed, 5405 insertions(+), 209 deletions(-)
```

## Material change summary

v0.2 adds citations as a first-class provenance mechanism. Assertions now carry
citation records, citation storage is backed by a dedicated table and repository,
and retrieval result formatting includes citation markers so returned assertions
remain traceable to source material.

v0.2 also adds trajectory retrieval. Trajectory mode reconstructs supersession
chains, letting callers see how an assertion evolved from an earlier version
instead of only seeing the current assertion. This deepens the temporal model
without replacing the existing namespace and temporal-anchor retrieval flow.

The temporal ordinal is renamed from sequenceNumber to position. The new name
clarifies that callers define their own stable ordering scheme rather than
being limited to a literal sequence-number interpretation.

## Selected source context

```txt
Citations are introduced as an optional but recommended field on assertions,
supporting source traceability while preserving the existing write path.
```

```txt
The temporal field sequenceNumber is renamed to position and generalized so
callers define their own ordinal scheme.
```

```txt
Trajectory retrieval mode is added so callers can reconstruct supersession
chains across an entity history.
```

