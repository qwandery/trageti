# trageti v0.3 — Verification Matrix

This document maps the v0.3 specification at [trageti-spec-v0.3.md](trageti-spec-v0.3.md) to the implementation and test evidence in this repository. Every MUST-level invariant, public API surface, error code, log code, schema-migration behavior, and required test class has a row here pointing at the concrete code path and test that exercises it.

Updated through phase 6 of the implementation. Where a row references an item that lands in a later release, the **Status** column says so.

## Public API surface

| Spec § | Public symbol                                      | Implementation                                                                                           | Tests                                                                                                |
| ------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| §1430  | `TemporalStore.create(options)`                    | [src/store/TemporalStore.ts#L98](../../src/store/TemporalStore.ts)                                       | covered transitively via every async test in `test/integration/*`                                    |
| §1461  | `new TemporalStore(db, opts) + await store.init()` | [src/store/TemporalStore.ts#L107](../../src/store/TemporalStore.ts)                                      | [test/integration/temporal-filter.test.ts](../../test/integration/temporal-filter.test.ts)           |
| §1479  | `prepareDatabase(source, options)`                 | [src/defaults/connection/prepareDatabase.ts](../../src/defaults/connection/prepareDatabase.ts)           | exercised by `TemporalStore.create` paths                                                            |
| §close | `store.close()` ownership-driven                   | [src/store/TemporalStore.ts#L660](../../src/store/TemporalStore.ts)                                      | implicit in every `create()`-using test                                                              |
| §1456  | `store.requireOpen()` guard                        | [src/store/TemporalStore.ts](../../src/store/TemporalStore.ts) `requireNotClosed`                        | StoreClosedError checks in lifecycle tests                                                           |
| §1701  | `RetrievalStrategy` routing (hybrid/vector/bm25)   | [src/pipeline/retrieve.ts#L65](../../src/pipeline/retrieve.ts)                                           | retrieval tests in `test/integration/semantic-retrieval.test.ts`                                     |
| §1706  | `QueryTextMode: 'phrase' \| 'fts5'`                | [src/pipeline/retrieve.ts](../../src/pipeline/retrieve.ts) `escapeFts5Phrase`                            | trajectory/semantic-retrieval tests                                                                  |
| §1641  | `IndexBatchResult` (indexed: number, skipped[])    | [src/store/TemporalStore.ts](../../src/store/TemporalStore.ts) `indexBatch`                              | [test/integration/vectorless-namespace.test.ts](../../test/integration/vectorless-namespace.test.ts) |
| §1977  | `RebuildFtsResult`                                 | [src/store/TemporalStore.ts](../../src/store/TemporalStore.ts) `rebuildFts`                              | integration coverage via tokenizer round-trip                                                        |
| §1994  | `NamespaceStats` v0.3 fields                       | [src/store/TemporalStore.ts](../../src/store/TemporalStore.ts) `getStats`                                | [test/integration/temporal-filter.test.ts](../../test/integration/temporal-filter.test.ts)           |
| §2036  | `UpgradeNamespaceToVectorOptions`                  | [src/store/TemporalStore.ts](../../src/store/TemporalStore.ts) `upgradeNamespaceToVector`                | vectorless tests                                                                                     |
| §950   | `EmbeddingProvider` contract                       | [src/domain/types.ts](../../src/domain/types.ts)                                                         | MockEmbeddingProvider / RawVectorProvider                                                            |
| §976   | `MockEmbeddingProvider` once-per-process warning   | [src/defaults/providers/MockEmbeddingProvider.ts](../../src/defaults/providers/MockEmbeddingProvider.ts) | TODO: dedicated test (Phase 6 follow-up)                                                             |
| §1118  | `Metrics` interface (no default)                   | [src/internal/logger.ts](../../src/internal/logger.ts)                                                   | guarded `incr`/`observe` helpers                                                                     |
| §1090  | `Logger` interface + `ConsoleLogger`/`NoopLogger`  | [src/internal/logger.ts](../../src/internal/logger.ts)                                                   | `connection-verifier`, `citations` tests assert log output                                           |

## Error model

| Spec code                               | Class                             | Where thrown                            | Tests                                         |
| --------------------------------------- | --------------------------------- | --------------------------------------- | --------------------------------------------- |
| `STORE_CLOSED`                          | `StoreClosedError`                | `TemporalStore.requireNotClosed`        | lifecycle coverage                            |
| `NAMESPACE_DIMENSION_MISMATCH`          | `NamespaceDimensionMismatchError` | `NamespaceRepository.upsert`            | implicit in reopen tests                      |
| `MIGRATION_COMPATIBILITY`               | `MigrationCompatibilityError`     | v003 tokenizer conflict                 | covered by FTS round-trip test                |
| `REFERENCED_EXTENSION_TABLE`            | `ReferencedExtensionTableError`   | `deleteNamespace` cascade gate          | TODO: dedicated cascade test                  |
| `MISSING_PEER_DEPENDENCY`               | `MissingPeerDependencyError`      | `prepareDatabase` + `ensureVectorReady` | `connection-verifier` warns; vectorless tests |
| `INDEXING_ASSERTION_NOT_FOUND`          | `IndexingError`                   | `indexAssertion` + `indexBatch.skipped` | indexBatch tests                              |
| `INDEXING_NAMESPACE_VECTORLESS`         | `IndexingError`                   | `ensureVectorReady(_,'indexing')`       | vectorless tests                              |
| `INDEXING_NO_EMBEDDING_AND_NO_PROVIDER` | `IndexingError`                   | `indexAssertion` / `indexBatch.skipped` | vectorless tests                              |
| `RETRIEVAL_INPUT_EMPTY`                 | `RetrievalInputError`             | `retrieveCore` Step 0                   | retrieval validation tests                    |
| `RETRIEVAL_REQUIRES_QUERY_TEXT`         | `RetrievalInputError`             | bm25-strategy guard                     | retrieval validation tests                    |
| `RETRIEVAL_REQUIRES_VECTOR_INPUT`       | `RetrievalInputError`             | vector-strategy guard                   | retrieval validation tests                    |
| `RETRIEVAL_INVALID_LIMIT`               | `RetrievalInputError`             | `retrieveCore` Step 0                   | covered indirectly by `middleware` test       |
| `RETRIEVAL_NAMESPACE_VECTORLESS`        | `RetrievalInputError`             | `ensureVectorReady(_,'retrieval')`      | vectorless tests                              |
| `SCORER_NO_USABLE_SIGNAL`               | `TragetiError`                    | `DefaultScorer` Case D                  | `default-scorer` unit test                    |
| `EMBEDDING_PROVIDER_ERROR`              | `EmbeddingProviderError`          | `indexBatch` fail-fast path             | provider error path tests                     |
| `REINDEX_ERROR`                         | `ReindexError`                    | reindex failure boundary                | reindex integration tests                     |

## Schema migrations

| Version                | Behavior                                                                                           | File                                                                                    | Tests                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| v001                   | initial schema (trl_namespaces, trl_episodes, trl_assertions, trl_links, trl_fts)                  | [src/db/migrations/v001_initial.ts](../../src/db/migrations/v001_initial.ts)            | `test/integration/migrations.test.ts` |
| v002                   | citations table + reverse-supersession index                                                       | [src/db/migrations/v002_citations.ts](../../src/db/migrations/v002_citations.ts)        | `test/integration/migrations.test.ts` |
| v003                   | nullable embedding columns with CHECK + `trl_fts_meta`                                             | [src/db/migrations/v003_vectorless.ts](../../src/db/migrations/v003_vectorless.ts)      | `test/integration/migrations.test.ts` |
| FK-toggle choreography | capture FK, disable, BEGIN, body, foreign_key_check, INSERT version, COMMIT, restore FK in finally | [src/db/migrations/runner.ts](../../src/db/migrations/runner.ts) `runFkToggleMigration` | covered transitively via v003         |

## Required test classes (spec §2780+)

| Class                                                         | Status                                                                                        | Test file                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| File-backed lifecycle: create, write, close, reopen, retrieve | **partial** — create/close exercised throughout; explicit reopen test pending                 | —                                                                |
| Vectorless + BM25-only retrieval                              | **covered**                                                                                   | `test/integration/vectorless-namespace.test.ts`                  |
| Vec0 readiness matrix (sqlite-vec × vec0)                     | **partial**                                                                                   | `test/integration/connection-verifier.test.ts`                   |
| Lazy vec0 creation                                            | **covered** (init no longer eager)                                                            | `test/integration/temporal-filter.test.ts`                       |
| Hybrid degradation log codes                                  | **partial** — TRGT_RETRIEVE_VECTOR_SKIPPED branch is wired but specific log-code test pending | —                                                                |
| FK-toggle migration failure (rollback + FK restore)           | **partial** — choreography implemented; targeted failure-path test pending                    | —                                                                |
| Adversarial FTS inputs (phrase + fts5 modes)                  | **partial** — phrase escaping in place; dedicated adversarial test pending                    | —                                                                |
| `rebuildFts` rowid preservation                               | **partial** — implementation preserves rowid; dedicated test pending                          | —                                                                |
| Reindex provider failure preserves old embeddings             | **partial** — implementation deferred (Phase 3 in-place fallback)                             | —                                                                |
| `indexBatch` skipped + ordering invariants                    | **covered**                                                                                   | `test/integration/vectorless-namespace.test.ts`                  |
| `deleteNamespace` with extension tables                       | **partial** — cascade option scaffolded; explicit cascade test pending                        | —                                                                |
| `namespaceColumn` validation at init() time                   | **covered**                                                                                   | `test/integration/schema-extensions.test.ts`                     |
| Invalid public options fail early                             | **covered** for limit; targeted negative-maxDepth / dimension-mismatch tests pending          | —                                                                |
| `writeAssertion` normalization order                          | **covered**                                                                                   | `test/integration/citations.test.ts`                             |
| `DefaultScorer` four cases                                    | **covered**                                                                                   | `test/unit/default-scorer.test.ts`                               |
| `MockEmbeddingProvider` non-production warning                | **partial** — implementation emits once; dedicated regression test pending                    | —                                                                |
| Determinism contract (tie-breaks)                             | **covered**                                                                                   | retrieval tests in `test/integration/semantic-retrieval.test.ts` |

## Documentation

| Spec requirement                 | File                                                             |
| -------------------------------- | ---------------------------------------------------------------- |
| Migration guide v0.2 → v0.3      | [\_docs/migration-v0.2-to-v0.3.md](../migration-v0.2-to-v0.3.md) |
| Release notes / breaking changes | [CHANGELOG.md](../../CHANGELOG.md)                               |
| Quick-start (v0.3 surface)       | [README.md](../../README.md)                                     |
| Spec verification matrix         | this file                                                        |

## Known gaps (deferred to a follow-up release)

These items are partially implemented but not fully test-covered through the
required-test-class lens above. They are tracked here so the gaps are explicit:

- Adversarial FTS5 input regression test under both `'phrase'` (default)
  and `'fts5'` modes.
- Dedicated `rebuildFts` rowid-preservation regression test.
- Staging-swap `reindexNamespace` with `onProviderError: 'fail-fast'`
  preserving the previous index on failure.
- Dedicated cascade-delete and `ReferencedExtensionTableError` regression
  tests.
- `MockEmbeddingProvider` once-per-process warning regression test.
- `RetrievalDebug.onStep` hook and `store.explain()` non-executing
  introspection.
- `RetrievalResult` envelope return shape from `store.retrieve()`
  (currently bare array; envelope types are exported but the runtime
  return still matches v0.2 for back-compat with the existing 188-test
  suite). The envelope will replace the array in a follow-up commit
  alongside the corresponding test updates.

Each entry is referenced by `[[verification-gap-<slug>]]` in the
implementation notes so they can be picked up in a future PR.
