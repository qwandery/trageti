# trageti v0.3 — Verification Matrix

This document maps the v0.3 specification at [trageti-spec-v0.3.md](trageti-spec-v0.3.md) — including the dated **Table-naming overhaul** amendment — to the implementation and test evidence in this repository. Every MUST-level invariant, public API surface, error code, schema-migration behavior, and required test class has a row pointing at concrete code and a test.

Updated through the v0.3 remediation (phases R1–R6). The release gate is green: `lint`, `format:check`, `typecheck`, `build`, the full test suite (289 tests), and `test:coverage` at 95/95/95/85.

## Public API surface

| Spec §    | Public symbol                                     | Implementation                                                       | Tests                                                        |
| --------- | ------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| §create   | `TemporalStore.create(options)`                   | `src/store/TemporalStore.ts` `create`                                | `test/integration/store-lifecycle.test.ts`                   |
| §init     | `new TemporalStore(db, opts)` + `await init()`    | `src/store/TemporalStore.ts` constructor + `init`                    | `test/integration/temporal-filter.test.ts` and most suites   |
| §prepare  | `prepareDatabase(source, options)`                | `src/defaults/connection/prepareDatabase.ts`                         | `store-lifecycle` (file-backed) + `store-edge-cases` pragmas |
| §close    | `store.close()` ownership-driven                  | `src/store/TemporalStore.ts` `close`                                 | `store-lifecycle`, `store-edge-cases` (dispose + flush)      |
| §guard    | `requireNotClosed()` open-state guard             | `src/store/TemporalStore.ts` `requireNotClosed`                      | `store-lifecycle` StoreClosedError checks                    |
| §1701     | `RetrievalStrategy` routing (hybrid/vector/bm25)  | `src/store/TemporalStore.ts` `resolveQueryEmbedding` + `retrieve.ts` | `store-operations`, `no-sqlite-vec`, `semantic-retrieval`    |
| §1706     | `QueryTextMode: 'phrase' \| 'fts5'`               | `src/pipeline/retrieve.ts` `escapeFts5Phrase`                        | `retrieve-validation` (fts5 malformed query)                 |
| §envelope | `RetrievalResult { results, meta }`               | `src/pipeline/retrieve.ts` `buildMeta`                               | `retrieve-validation`, `semantic-retrieval`                  |
| §1641     | `IndexBatchResult { indexed, skipped[] }`         | `src/store/TemporalStore.ts` `indexBatch`                            | `test/integration/store-operations.test.ts`                  |
| §1977     | `RebuildFtsResult` + tokenizer round-trip         | `src/store/TemporalStore.ts` `rebuildFts`                            | `store-operations` (rebuildFts)                              |
| §1994     | `NamespaceStats` v0.3 fields                      | `src/store/TemporalStore.ts` `getStats`                              | `temporal-filter`, `vectorless-namespace`                    |
| §2036     | `UpgradeNamespaceToVectorOptions`                 | `src/store/TemporalStore.ts` `upgradeNamespaceToVector`              | `store-operations`, `vectorless-namespace`                   |
| §explain  | `store.explain()` non-executing introspection     | `src/store/TemporalStore.ts` `explain`                               | `store-lifecycle`, `store-edge-cases`                        |
| §debug    | `RetrievalDebug.onStep` hook                      | `src/pipeline/retrieve.ts` `debugStep`                               | `retrieve-validation` (onStep + throwing hook)               |
| §950      | `EmbeddingProvider` contract                      | `src/domain/types.ts`                                                | `providers-tokenizer`, `store-operations`                    |
| §976      | `MockEmbeddingProvider` once-per-process warning  | `src/defaults/providers/MockEmbeddingProvider.ts`                    | `test/unit/providers-tokenizer.test.ts`                      |
| §1118     | `Metrics` interface (no default; guarded helpers) | `src/internal/logger.ts` `incr`/`observe`                            | `test/unit/logger.test.ts`                                   |
| §1090     | `Logger` + `ConsoleLogger`/`NoopLogger`           | `src/internal/logger.ts`                                             | `test/unit/logger.test.ts`                                   |

## Error model

| Spec code                         | Class                             | Where thrown                                  | Tests                                        |
| --------------------------------- | --------------------------------- | --------------------------------------------- | -------------------------------------------- |
| `STORE_CLOSED`                    | `StoreClosedError`                | `requireNotClosed`                            | `store-lifecycle`                            |
| `NAMESPACE_DIMENSION_MISMATCH`    | `NamespaceDimensionMismatchError` | `NamespaceRepository.upsert`                  | `store-lifecycle` (reopen matrix)            |
| `MIGRATION_COMPATIBILITY`         | `MigrationCompatibilityError`     | v003 tokenizer conflict / `validateTokenizer` | `migration-internals`, `providers-tokenizer` |
| `REFERENCED_EXTENSION_TABLE`      | `ReferencedExtensionTableError`   | `deleteNamespace` cascade gate                | `vectorless-namespace` (cascade)             |
| `MISSING_PEER_DEPENDENCY`         | `MissingPeerDependencyError`      | `prepareDatabase` / `ensureVectorReady`       | `no-sqlite-vec`                              |
| `ASSERTION_NOT_FOUND`             | `IndexingError`                   | `indexAssertion` / `indexBatch.skipped`       | `store-operations`                           |
| `INDEXING_NAMESPACE_VECTORLESS`   | `IndexingError`                   | `ensureVectorReady(_,'indexing')`             | `vectorless-namespace`                       |
| `NO_EMBEDDING_AND_NO_PROVIDER`    | `IndexingError`                   | `indexAssertion` / `indexBatch.skipped`       | `store-operations`                           |
| `EMBEDDING_DIMENSION_MISMATCH`    | `IndexingError`                   | `indexAssertion` / `indexBatch.skipped`       | `store-operations`                           |
| `RETRIEVAL_INPUT_EMPTY`           | `RetrievalInputError`             | `retrieveCore` input validation               | `retrieve-validation`                        |
| `RETRIEVAL_REQUIRES_QUERY_TEXT`   | `RetrievalInputError`             | bm25-strategy guard                           | `retrieve-validation`                        |
| `RETRIEVAL_REQUIRES_VECTOR_INPUT` | `RetrievalInputError`             | vector-strategy guard                         | `retrieve-validation`, `store-operations`    |
| `RETRIEVAL_INVALID_LIMIT`         | `RetrievalInputError`             | `retrieveCore` input validation               | `retrieve-validation`                        |
| `RETRIEVAL_INVALID_MAX_DEPTH`     | `RetrievalInputError`             | `retrieveCore` input validation               | `retrieve-validation`                        |
| `RETRIEVAL_DIMENSION_MISMATCH`    | `RetrievalInputError`             | `retrieveCore` input validation               | `retrieve-validation`                        |
| `RETRIEVAL_NAMESPACE_VECTORLESS`  | `RetrievalInputError`             | `ensureVectorReady(_,'retrieval')`            | `vectorless-namespace`                       |
| `SCORER_INVALID_OUTPUT`           | `RetrievalInputError`             | scorer finiteness check in `retrieve.ts`      | `retrieve-validation`                        |
| `SCORER_NO_USABLE_SIGNAL`         | `TragetiError`                    | `DefaultScorer` both-signals-null             | `test/unit/scorer-edge.test.ts`              |
| `EMBEDDING_PROVIDER_ERROR`        | `EmbeddingProviderError`          | `indexBatch` fail-fast path                   | `store-operations`, `store-edge-cases`       |
| `REINDEX_ERROR`                   | `ReindexError`                    | reindex failure boundary                      | `store-operations`, `store-edge-cases`       |

## Schema migrations

| Version                | Behavior                                                                                             | File                                              | Tests                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| v001                   | initial schema (`trl_*` core tables, `trl_fts`, indexes, triggers)                                   | `src/db/migrations/v001_initial.ts`               | `migrations.test.ts`                                                |
| v002                   | `trl_citations` table + reverse-supersession index                                                   | `src/db/migrations/v002_citations.ts`             | `migrations.test.ts`                                                |
| v003 (FK-toggle)       | nullable embedding columns with `CHECK` + `trl_fts_meta` tokenizer table                             | `src/db/migrations/v003_vectorless.ts`            | `migrations.test.ts`, `migration-internals.test.ts` (compat branch) |
| v004 (standard)        | backfill `created_at` to canonical ISO-8601                                                          | `src/db/migrations/v004_timestamps.ts`            | `migrations.test.ts`, `e2e.test.ts`                                 |
| v005 (FK-toggle)       | rename every library table `trl_*` → `trageti_*`; FTS5 recreate; embedding copy-swap                 | `src/db/migrations/v005_rename.ts`                | `migrations.test.ts`, `migration-internals.test.ts` (copy-swap)     |
| FK-toggle choreography | capture FK, disable, BEGIN, body, `foreign_key_check`, INSERT version, COMMIT, restore               | `runner.ts` `runFkToggleMigration`                | `migration-internals.test.ts` (rollback path)                       |
| schema-version table   | runner self-migrates `trl_schema_version` → `trageti_schema_version` (copy, then drop after success) | `runner.ts` `getCurrentVersion`/`applyMigrations` | `migrations.test.ts`, `migration-internals.test.ts`                 |

## Required test classes (spec Testing Strategy)

| Class                                                             | Status      | Test file                                               |
| ----------------------------------------------------------------- | ----------- | ------------------------------------------------------- |
| File-backed lifecycle: create → write → close → reopen → retrieve | **covered** | `store-lifecycle.test.ts`                               |
| Namespace dimension mismatch on reopen                            | **covered** | `store-lifecycle.test.ts` (reopen matrix)               |
| Vectorless + BM25-only retrieval                                  | **covered** | `vectorless-namespace.test.ts`, `no-sqlite-vec.test.ts` |
| `getStats`/`getPendingIndexing` across the vec0 matrix            | **covered** | `vectorless-namespace.test.ts`, `no-sqlite-vec.test.ts` |
| `getStats`/`getPendingIndexing` on an unknown namespace           | **covered** | `store-lifecycle.test.ts`                               |
| Lazy vec0 creation                                                | **covered** | `vectorless-namespace.test.ts`                          |
| Hybrid degradation + `TRGT_RETRIEVE_VECTOR_SKIPPED`               | **covered** | `store-operations.test.ts`, `no-sqlite-vec.test.ts`     |
| FK-toggle migration failure (rollback + FK restore)               | **covered** | `migration-internals.test.ts`                           |
| FK verifier fail-closed                                           | **covered** | `connection-verifier.test.ts`                           |
| Multi-hop `findPath` (DAGs, determinism, cycles)                  | **covered** | `graph-traversal.test.ts`                               |
| Adversarial FTS inputs (`phrase` + `fts5` modes)                  | **covered** | `retrieve-validation.test.ts`                           |
| `rebuildFts` rowid preservation + tokenizer round-trip            | **covered** | `store-operations.test.ts`                              |
| Staging-swap reindex failure preserves the previous index         | **covered** | `reindex.test.ts`, `store-edge-cases.test.ts`           |
| `indexBatch` invariants (`indexed + skipped === items.length`)    | **covered** | `store-operations.test.ts`                              |
| `deleteNamespace` cascade + `ReferencedExtensionTableError`       | **covered** | `vectorless-namespace.test.ts`                          |
| `namespaceColumn` validation at init() time                       | **covered** | `schema-extensions.test.ts`                             |
| Invalid public options fail before SQLite execution               | **covered** | `retrieve-validation.test.ts`                           |
| `writeAssertion` normalization order / structural invariants      | **covered** | `citations.test.ts`, `store-edge-cases.test.ts`         |
| `DefaultScorer` four cases + `scoreBatch range === 0`             | **covered** | `default-scorer.test.ts`, `scorer-edge.test.ts`         |
| `MockEmbeddingProvider` once-per-process warning                  | **covered** | `providers-tokenizer.test.ts`                           |
| Determinism contract (tie-breaks)                                 | **covered** | `semantic-retrieval.test.ts`, `graph-traversal.test.ts` |
| `store.explain` shape (non-executing; routing flags)              | **covered** | `store-lifecycle.test.ts`, `store-edge-cases.test.ts`   |
| `initNamespace` reopen matrix + per-namespace providers           | **covered** | `store-lifecycle.test.ts`                               |
| Realistic temporal-drift E2E scenario                             | **covered** | `e2e.test.ts`                                           |
| v005 embedding-table copy-swap (vectors survive the rename)       | **covered** | `migration-internals.test.ts`                           |

## Documentation

| Spec requirement                 | File                                                         |
| -------------------------------- | ------------------------------------------------------------ |
| Migration guide v0.2 → v0.3      | [../migration-v0.2-to-v0.3.md](../migration-v0.2-to-v0.3.md) |
| Release notes / breaking changes | [../../CHANGELOG.md](../../CHANGELOG.md)                     |
| Quick-start (v0.3 surface)       | [../../README.md](../../README.md)                           |
| Developer / contributor guide    | [../dev/README.md](../dev/README.md)                         |
| Spec table-naming amendment      | trageti-spec-v0.3.md — "v0.3 Amendment" entry                |
| Spec verification matrix         | this file                                                    |

## Documented deviations

The implementation matches the spec (as amended) with two documented, intentional deviations:

1. **`getTemporalSnapshot` — additive superset.** The spec signature is
   `getTemporalSnapshot(namespace, temporalAnchor)`. The implementation also
   accepts `entityTypes` / `assertionTypes` / `includeSuperseded` filters as
   additional options. This is an _additive_ deviation (a superset of the spec
   signature) — no spec-described call is broken. Removing working capability
   for cosmetic signature alignment was rejected.

2. **Unsupported embedding-table residue.** Fresh v0.3 databases, and migrated
   databases opened with `sqlite-vec` loaded, contain zero `trl_*` tables after
   migration v005. The single exception is an unsupported pre-v0.3 vector
   database opened _without_ `sqlite-vec`: a vec0 table physically cannot be
   copied without the extension, so the legacy `trl_embeddings_*` table is left
   inert and `embedding_table` keeps pointing at it. No known deployment is in
   this state. v0.3 source contains no hard-coded runtime `trl_*` table literal;
   the rename is eager-only inside v005 with no lazy runtime path.

## Allowed residual `trl_` references

These are expected, not gaps. Every other `trl_` in `src/` or `test/` is a real miss.

- v001–v004 migration bodies (immutable — they created/operated on `trl_*` tables of their era).
- The v005 rename migration body (names every `trl_*` source table it renames).
- The runner's schema-version self-migration (`trl_schema_version` — the table it copies from and drops).
- Legacy-state test seeding in `migrations.test.ts` and `migration-internals.test.ts` (deliberately simulating pre-R6 databases).
- Historical sections of `CHANGELOG.md`, the migration guide, and the spec changelog / Migration v003 section.
