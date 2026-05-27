# kf-3..kf-4.md: v0.3 phase 1 async contract and lifecycle -> v0.3 phase 2 vectorless namespaces

Source kind: keyframe-pair source bundle
Previous commit: 24dc5e7 (v0.3 phase 1 async contract and lifecycle)
Current commit: bd973d5 (v0.3 phase 2 vectorless namespaces)
Date: 2026-05-19

## Commit message

v0.3 phase 2: vectorless namespace state, migration v003, lazy vec0, fk-toggle

## git diff --stat

```txt
 src/db/migrations/index.ts                  |   7 +-
 src/db/migrations/runner.ts                 |  72 ++++++++--
 src/db/migrations/v003_vectorless.ts        |  97 +++++++++++++
 src/db/repositories/EmbeddingRepository.ts  |  22 ++-
 src/db/repositories/NamespaceRepository.ts  |  64 ++++++---
 src/db/schema/extensions.ts                 |  11 ++
 src/store/TemporalStore.ts                  | 157 +++++++++++++++++----
 test/integration/connection-verifier.test.ts|  15 +-
```

## Material change summary

Phase 2 makes vector indexing optional at the namespace level. Namespaces can run without vector tables, while vector-enabled namespaces lazily create vec0 structures only when embeddings are actually needed.

The migration runner also gains foreign-key toggling around migrations, which prevents schema changes from being blocked by transient table states while still allowing normal runtime integrity checks afterward.

## Selected important file diffs

### src/db/migrations/v003_vectorless.ts

```txt
Migration v003 records vectorless namespace state so a namespace can use BM25-only retrieval without requiring vector rows.
```

### src/store/TemporalStore.ts

```txt
Vector tables are created lazily for namespaces that need embeddings rather than eagerly for every namespace.
```

### src/db/migrations/runner.ts

```txt
The migration runner toggles foreign-key enforcement around migrations and restores enforcement after schema changes complete.
```
