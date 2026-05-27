# kf-1..kf-2.md: v0.1 implementation -> v0.2 citations and trajectory retrieval

Source kind: keyframe-pair source bundle
Previous commit: fac4ada (v0.1 implementation)
Current commit: 5695df6 (v0.2 citations and trajectory retrieval)
Date: 2026-05-10

## Commit message

Implement trageti v0.2: citations and trajectory retrieval

## git diff --stat

```txt
 .changeset/v0.2-citations-and-trajectory.md |   86 ++
 README.md                                   |  159 ++-
 _docs/specs/trageti-spec-v0.2.md            | 1158 ++++++++++++++++++++
 src/db/migrations/v002_citations.ts         |   34 +
 src/db/repositories/CitationRepository.ts   |  132 +++
 src/domain/types.ts                         |  127 ++-
 src/pipeline/retrieve.ts                    |  141 ++-
 src/store/TemporalStore.ts                  |  259 +++--
```

## Material change summary

v0.2 adds citations as first-class assertion provenance and introduces trajectory retrieval over supersession chains. The schema gains a citation table, the store writes citation rows with assertions, and retrieval can return temporally ordered chains rather than only a current snapshot.

The temporal field is renamed from sequenceNumber to position, making the ordering concept shorter and more general. Citations are optional in this release, but the API and docs establish them as the expected way to ground assertions.

## Selected important file diffs

### src/db/migrations/v002_citations.ts

```txt
Migration v002 adds storage for assertion citations, including sourceRef, excerpt, and optional excerptStart/excerptEnd fields.
```

### src/pipeline/retrieve.ts

```txt
Trajectory retrieval reconstructs supersession chains so callers can ask how an assertion evolved instead of only asking what is current.
```

### src/domain/types.ts

```txt
The temporal ordering field is renamed from sequenceNumber to position and remains caller supplied.
```
