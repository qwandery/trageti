# kf-2..kf-3.md: v0.2 citations and trajectory retrieval -> v0.3 phase 1 async contract and lifecycle

Source kind: keyframe-pair source bundle
Previous commit: 5695df6 (v0.2 citations and trajectory retrieval)
Current commit: 24dc5e7 (v0.3 phase 1 async contract and lifecycle)
Date: 2026-05-19

## Commit message

v0.3 phase 1: async public contract, lifecycle, logger metrics error foundation

## git diff --stat

```txt
 CHANGELOG.md                               |  120 +
 _docs/specs/trageti-spec-v0.3.md           | 3275 ++++++++++++++++++++
 src/defaults/connection/prepareDatabase.ts |   42 +
 src/defaults/graph/CTEGraphAdapter.ts      |  120 +-
 src/domain/types.ts                        |  258 +-
 src/errors/index.ts                        |  193 +-
 src/internal/logger.ts                     |  130 +-
 src/store/TemporalStore.ts                 |  441 ++-
```

## Material change summary

v0.3 phase 1 moves the public store contract toward async methods and explicit lifecycle management. Store creation and close paths become part of the public shape so callers can use the same API even if future providers or storage backends become asynchronous.

This phase also adds the error foundation, internal logger, metrics hooks, and connection preparation path. The change is architectural rather than only cosmetic: trageti starts treating observability and lifecycle as first-class library behavior.

## Selected important file diffs

### src/store/TemporalStore.ts

```txt
TemporalStore creation, retrieval, writing, and close behavior are shaped as asynchronous public operations.
```

### src/internal/logger.ts

```txt
The logger and metrics foundation records store activity without forcing application code to parse console output.
```

### src/errors/index.ts

```txt
The error foundation introduces typed trageti errors so callers can distinguish configuration, validation, and runtime failures.
```
