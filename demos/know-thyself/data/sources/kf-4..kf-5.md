# kf-4..kf-5.md: v0.3 phase 2 vectorless namespaces -> v0.3 phase 3 provider-driven indexing

Source kind: keyframe-pair source bundle
Previous commit: bd973d5 (v0.3 phase 2 vectorless namespaces)
Current commit: 1924f45 (v0.3 phase 3 provider-driven indexing)
Date: 2026-05-19

## Commit message

v0.3 phase 3: writing normalization, provider-driven indexing, rebuildFts

## git diff --stat

```txt
 src/defaults/providers/MockEmbeddingProvider.ts |  39 ++++
 src/defaults/providers/RawVectorProvider.ts     |  42 ++++
 src/defaults/validation/DefaultAssertionValidator.ts | 30 ++-
 src/index.ts                                    |   2 +
 src/store/TemporalStore.ts                      | 232 ++++++++++++++++-----
 test/integration/vectorless-namespace.test.ts   |  85 ++++++++
```

## Material change summary

Phase 3 moves indexing to the embedding provider boundary. The store can call a configured embedding provider during assertion writes, while RawVectorProvider lets callers supply exact vectors for fixtures, tests, and deterministic demos.

The store also adds write normalization and rebuildFts, making indexing and text-search maintenance explicit operational behaviors instead of incidental side effects.

## Selected important file diffs

### src/defaults/providers/RawVectorProvider.ts

```txt
RawVectorProvider returns caller-supplied vectors directly, which lets fixtures exercise sqlite-vec without making live embedding requests.
```

### src/store/TemporalStore.ts

```txt
Provider-driven indexing embeds assertion text during writes and records pending indexing state when embeddings are not yet available.
```

### src/store/TemporalStore.ts

```txt
rebuildFts gives applications a public maintenance path for rebuilding full-text search state from stored assertions.
```
