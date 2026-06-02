# trageti v0.3 — Verification Matrix

This document maps the v0.3 specification at [trageti-spec-v0.3.md](trageti-spec-v0.3.md) — including the dated **Table-naming overhaul**, **API-conformance remediation (R9)**, and **Retrieval & graph polish** amendments — to the implementation and test evidence in this repository. Every MUST-level invariant, public API surface, error code, schema-migration behavior, and required test class has a row pointing at concrete code and a test.

Updated through the v0.3 remediation (phases R1-R9), the 2026-05-21 retrieval/graph polish round, the 2026-06-01 code-review remediation pass, and the June 2026 demo synthesis/custom-query work. R7 closed 16 code-review findings; R8 closed a follow-up review - reindex never converts a vectorless namespace, dimension/provider agreement is validated at registration/upgrade, and provider error messages no longer leak the raw cause. R9 reconciled the remaining contract divergences (mid-chain temporal retrieval, citation-excerpt bypass, graph option types, new error codes, tokenizer reopen semantics) and added the dated R9 spec amendment. The polish round made snapshot `includeSuperseded` meaningful, hardened raw FTS5 error handling, fixed debug/explain step ordering, named the shared retrieval/graph defaults, and made graph neighborhood ordering deterministic. The June 2026 remediation flattened v0.3 storage to a single baseline migration, hardened reindex/retrieval/lifecycle behavior, and refreshed docs and demos. The latest release gate is green: `lint`, `format:check`, `typecheck`, `build`, the full test suite (405 tests), and `test:coverage` at 95.16 statements, 88.95 branches, 98.75 functions, and 95.16 lines.

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

| Spec code                           | Class                                  | Where thrown                                                                | Tests                                                     |
| ----------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| `STORE_CLOSED`                      | `StoreClosedError`                     | `requireNotClosed`                                                          | `store-lifecycle`                                         |
| `NAMESPACE_DIMENSION_MISMATCH`      | `NamespaceDimensionMismatchError`      | `NamespaceRepository.upsert`                                                | `store-lifecycle` (reopen matrix)                         |
| `MIGRATION_COMPATIBILITY`           | `MigrationCompatibilityError`          | baseline tokenizer conflict / `validateTokenizer`                           | `migration-internals`, `providers-tokenizer`              |
| `REFERENCED_EXTENSION_TABLE`        | `ReferencedExtensionTableError`        | `deleteNamespace` cascade gate                                              | `vectorless-namespace` (cascade)                          |
| `MISSING_PEER_DEPENDENCY`           | `MissingPeerDependencyError`           | `prepareDatabase` / `ensureVectorReady`                                     | `no-sqlite-vec`                                           |
| `ASSERTION_NOT_FOUND`               | `IndexingError`                        | `indexAssertion` / `indexBatch.skipped`                                     | `store-operations`                                        |
| `INDEXING_NAMESPACE_VECTORLESS`     | `IndexingError`                        | `ensureVectorReady(_,'indexing')`                                           | `vectorless-namespace`                                    |
| `NO_EMBEDDING_AND_NO_PROVIDER`      | `IndexingError`                        | `indexAssertion` / `indexBatch.skipped`                                     | `store-operations`                                        |
| `EMBEDDING_DIMENSION_MISMATCH`      | `IndexingError`                        | `indexAssertion` / `indexBatch.skipped`                                     | `store-operations`                                        |
| `RETRIEVAL_INPUT_EMPTY`             | `RetrievalInputError`                  | `retrieveCore` input validation                                             | `retrieve-validation`                                     |
| `RETRIEVAL_REQUIRES_QUERY_TEXT`     | `RetrievalInputError`                  | bm25-strategy guard (missing/blank query text only)                         | `retrieve-validation`, `v03-polish`                       |
| `RETRIEVAL_INVALID_QUERY_TEXT`      | `RetrievalInputError`                  | malformed `queryTextMode: 'fts5'` expression (generic, non-leaking message) | `v03-polish`                                              |
| `RETRIEVAL_REQUIRES_VECTOR_INPUT`   | `RetrievalInputError`                  | vector-strategy guard                                                       | `retrieve-validation`, `store-operations`                 |
| `RETRIEVAL_INVALID_LIMIT`           | `RetrievalInputError`                  | `retrieveCore` input validation                                             | `retrieve-validation`                                     |
| `RETRIEVAL_INVALID_MAX_DEPTH`       | `RetrievalInputError`                  | `retrieveCore` input validation                                             | `retrieve-validation`                                     |
| `RETRIEVAL_INVALID_TEMPORAL_WINDOW` | `RetrievalInputError`                  | `retrieveCore` input validation (`temporalWindow.from > to`)                | `r9-conformance`                                          |
| `RETRIEVAL_INVALID_CONFIDENCE`      | `RetrievalInputError`                  | `retrieveCore` input validation (`minConfidence` ∉ [0,1])                   | `r9-conformance`                                          |
| `RETRIEVAL_INVALID_TOKEN_BUDGET`    | `RetrievalInputError`                  | `assembleContext` input validation                                          | `r9-conformance`                                          |
| `SCORER_BATCH_LENGTH_MISMATCH`      | `RetrievalInputError`                  | `scoreBatch()` returns a wrong-length score array                           | `r9-conformance`                                          |
| `RETRIEVAL_DIMENSION_MISMATCH`      | `RetrievalInputError`                  | `retrieveCore` input validation                                             | `retrieve-validation`                                     |
| `RETRIEVAL_NAMESPACE_VECTORLESS`    | `RetrievalInputError`                  | `ensureVectorReady(_,'retrieval')`                                          | `vectorless-namespace`                                    |
| `SCORER_INVALID_OUTPUT`             | `RetrievalInputError`                  | scorer finiteness check in `retrieve.ts`                                    | `retrieve-validation`                                     |
| `SCORER_NO_USABLE_SIGNAL`           | `TragetiError`                         | `DefaultScorer` both-signals-null                                           | `test/unit/scorer-edge.test.ts`                           |
| `EMBEDDING_PROVIDER_ERROR`          | `EmbeddingProviderError`               | `indexBatch` fail-fast path / Step-0 provider failure                       | `store-operations`, `store-edge-cases`, `r7-conformance`  |
| `REINDEX_ERROR`                     | `ReindexError`                         | reindex failure boundary                                                    | `store-operations`, `store-edge-cases`, `reindex-options` |
| `REINDEX_PARTIAL_REJECTED`          | `ReindexError` (`.skipped`, `.advice`) | staging-swap skip build rejected without `allowPartialSwap`                 | `reindex-options`                                         |
| `REINDEX_ALREADY_RUNNING`           | `ReindexError`                         | per-namespace reindex lock rejects overlapping same-namespace runs          | `reindex-options`                                         |
| `INTERNAL_INVARIANT`                | `TragetiError`                         | "should never happen" guards (row absent after self-insert)                 | defensive — unreachable in correct use                    |

## Schema migrations

| Version              | Behavior                                                                                                                        | File                                             | Tests                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| v001 baseline        | creates the steady-state `trageti_` schema directly at schema version `1`                                                       | `src/db/migrations/v001_baseline.ts`             | `migrations.test.ts`, `migration-internals.test.ts` |
| schema-version table | runner bootstraps `trageti_schema_version`; no legacy `trl_schema_version` copy-forward path exists in the active v0.3 baseline | `src/db/migrations/runner.ts`                    | `migrations.test.ts`, `migration-internals.test.ts` |
| schema fixture       | baseline schema is compared with the captured v001-v005 steady-state fixture                                                    | `test/fixtures/schema-v001-v005-steady-state.ts` | `migrations.test.ts`                                |

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
| Baseline schema matches captured steady-state schema fixture      | **covered** | `migrations.test.ts`, `migration-internals.test.ts`     |

## R7 — code-review conformance fixes

| Finding                                                                                             | Spec                   | Implementation                                                                              | Tests                                                   |
| --------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Full `ReindexOptions` (skip / allowPartialSwap / in-place / in-place+newDimension / signal)         | §1156-1183, §2044-2085 | `src/pipeline/reindex.ts`                                                                   | `reindex-options.test.ts`                               |
| Per-namespace provider drives indexing / reindexing                                                 | §1252-1257, §2279      | `TemporalStore` `indexAssertion`/`indexBatch`/`reindexNamespace` via `getNamespaceProvider` | `r7-conformance.test.ts`                                |
| Hybrid Step-3 BM25 re-scores vector-selected candidates only                                        | §2581-2582, §2661-2665 | `src/pipeline/retrieve.ts` candidate-set assembly                                           | `r7-conformance.test.ts`                                |
| `explain()` models Step-0 provider routing                                                          | §2232-2245             | `TemporalStore.explain`                                                                     | `r7-conformance.test.ts`, `store-lifecycle.test.ts`     |
| `rebuildFts()` preserves the stored tokenizer                                                       | §2088-2099, §2350-2355 | `TemporalStore.rebuildFts` + `readStoredTokenizer`                                          | `r7-conformance.test.ts`                                |
| `getStats()` emits `TRGT_STATS_VEC_NOT_INTROSPECTED`                                                | §2133, §2404           | `TemporalStore.getStats`                                                                    | `r7-conformance.test.ts`                                |
| Vectorless reopen throws `NamespaceDimensionMismatchError`                                          | §1685-1687, §2287-2289 | `NamespaceRepository.upsert`                                                                | `store-lifecycle.test.ts`                               |
| Debug hook logs a stable code, never a raw message                                                  | §2733                  | `src/pipeline/retrieve.ts` `debugStep` + `errorCodeOf`                                      | `r7-conformance.test.ts`                                |
| Step-0 provider failures propagate as `EmbeddingProviderError`                                      | §2569, §2589           | `TemporalStore.resolveQueryEmbedding`                                                       | `r7-conformance.test.ts`                                |
| `assembleContext()` validates `tokenBudget`                                                         | §200-202               | `src/pipeline/assemble.ts`                                                                  | `r7-conformance.test.ts`                                |
| `maxDepth: 0` valid + zero-hop graph behavior                                                       | §2029, §2805           | `retrieve.ts` guard + `CTEGraphAdapter` short-circuit                                       | `retrieve-validation.test.ts`, `r7-conformance.test.ts` |
| `indexBatch`/reindex skip `errorCode` derives from the thrown error (`UNKNOWN` for a plain `Error`) | §1143-1147, §2074-2078 | `errorCodeOf`                                                                               | `store-operations.test.ts`, `r7-conformance.test.ts`    |
| `namespaceColumn` identifier validation                                                             | §1044-1046             | `SchemaExtensionApplier.validate`                                                           | `r7-conformance.test.ts`                                |
| Internal-invariant guards throw `TragetiError`                                                      | §2821-2824             | `ErrorCode.INTERNAL_INVARIANT` in store + repositories                                      | defensive (unreachable)                                 |

## R8 — follow-up review conformance fixes

| Finding                                                                                                                                      | Spec                   | Implementation                                                                  | Tests                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| `reindexNamespace()` never converts a vectorless namespace (upgrade is exclusive to `upgradeNamespaceToVector()`)                            | §1681, §2296           | `src/pipeline/reindex.ts` vectorless guard                                      | `r7-conformance.test.ts`                    |
| Dimension / provider agreement validated at registration & upgrade; invalid dimensions rejected; provider-only upgrade derives the dimension | §1254-1257, §2146-2168 | `TemporalStore.resolveVectorDimension`; `UpgradeNamespaceToVectorOptions` union | `r7-conformance.test.ts`                    |
| Provider error messages omit the raw cause (no content / secret leak)                                                                        | §2817                  | `EmbeddingProviderError` / `ReindexError` use `errorCodeOf(cause)`              | `r7-conformance.test.ts`, `reindex.test.ts` |

## R9 — API-conformance remediation

Reconciles the implementation with the spec; recorded in the dated **R9
amendment** of `trageti-spec-v0.3.md`.

| Finding                                                                                                                                | Spec (amended)    | Implementation                                                                         | Tests                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Citation-excerpt policy enforced in `writeAssertion()` — a custom `validators` array cannot bypass it                                  | R9 §1             | `TemporalStore.enforceCitationExcerptPolicy`; `DefaultAssertionValidator` opt-out flag | `r9-conformance.test.ts`                                 |
| `retrieve()` returns the version valid AT the anchor, including mid-chain; no spurious supersede filter                                | R9 §5             | `src/pipeline/retrieve.ts` `runStep1` temporal-window clause                           | `r9-conformance.test.ts`                                 |
| `reindexNamespace({ newDimension })` validated before vec0 DDL                                                                         | §2805             | `assertValidDimension` shared helper                                                   | `r9-conformance.test.ts`                                 |
| Graph option types split: store-facing `TraversalOptions`/`PathOptions`, adapter-facing `GraphAdapterTraversalOptions`                 | R9 §2             | `src/domain/types.ts`; `pipeline/graph.ts`; `CTEGraphAdapter`                          | `r9d-conformance.test.ts` (compile fixture)              |
| `getTemporalSnapshot(options)` canonical object form; `TemporalSnapshotOptions` exported                                               | R9 §1             | `TemporalStore.getTemporalSnapshot`; `src/pipeline/snapshot.ts`                        | `r9d-conformance.test.ts`, `snapshot.test.ts`            |
| `includeSuperseded` honored by graph traversal + `findPath` `linkTypes` filter; Step-6 propagation                                     | R9 §2, §5         | `CTEGraphAdapter`; `retrieve.ts` Step-6                                                | `r9-conformance.test.ts`                                 |
| `MigrationDescriptor.appliedAt` (+ additive `name`/`description`/`requiresForeignKeyToggle`)                                           | R9 §3             | `MigrationRunner.getAppliedVersions`; `TemporalStore.getMigrations`                    | `r9-conformance.test.ts`                                 |
| FTS5 `trustedCustomTokenizer`; `validateTokenizer` context-typed errors + spec arg regex                                               | R9 §6             | `src/internal/tokenizer.ts`                                                            | `r9-conformance.test.ts`, `providers-tokenizer.test.ts`  |
| New `RetrievalInputError` codes (`INVALID_TEMPORAL_WINDOW`/`INVALID_CONFIDENCE`/`INVALID_TOKEN_BUDGET`/`SCORER_BATCH_LENGTH_MISMATCH`) | R9 §4             | `src/errors/index.ts`; `retrieve.ts`; `assemble.ts`                                    | `r9-conformance.test.ts`                                 |
| Tokenizer change on reopen never silently ignored (fail-closed when populated; rebuild when empty)                                     | R9 §6, §2348      | `TemporalStore.reconcileFtsTokenizer`                                                  | `r9-conformance.test.ts`                                 |
| Typed debug/explain steps (`RetrievalStep`/`RetrievalStepInfo`); steps `semantic`/`keyword`                                            | R9 §1             | `src/domain/types.ts`; `retrieve.ts` `debugStep`                                       | `retrieve-validation.test.ts`, `r9d-conformance.test.ts` |
| `FormattedContext.includedAssertions` — `AssembledContext.assertions` matches rendered text                                            | §200-202          | three built-in formatters; `assemble.ts` fallback                                      | `r9-conformance.test.ts`                                 |
| `RetrievalMeta.queryTextMode` is `QueryTextMode \| null` (null when no `queryText`)                                                    | R9 §8             | `retrieve.ts` `buildMeta`                                                              | `r9d-conformance.test.ts`                                |
| Typed required-field validation in `writeEpisode()`/`writeLink()` before SQLite                                                        | R9 §4             | `validateEpisodeInput` / `validateLinkInput`                                           | `r9d-conformance.test.ts`                                |
| Extension column / `namespaceColumn` reserved-keyword rejection removed (quoted in DDL)                                                | §1044-1046, R9 §7 | `src/db/schema/extensions.ts`                                                          | `schema-extensions.test.ts`, `r7-conformance.test.ts`    |

## Retrieval & graph polish (2026-05-21)

Recorded in the dated **Retrieval & graph polish** amendment of `trageti-spec-v0.3.md`.

| Finding                                                                                                       | Spec (amended) | Implementation                                                               | Tests                                           |
| ------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| `getTemporalSnapshot({ includeSuperseded: true })` returns rows closed before `atPosition`; default unchanged | Polish §2      | `AssertionRepository.query` (`validAt` + `includeSuperseded`)                | `v03-polish.test.ts`                            |
| Malformed `queryTextMode: 'fts5'` text → `RETRIEVAL_INVALID_QUERY_TEXT`; generic, non-leaking message         | Polish §1      | `src/pipeline/retrieve.ts` Step-3 catch; `src/errors/index.ts`               | `v03-polish.test.ts`                            |
| `rank` debug/explain step emitted after `score`, before `graph-expand` / `trajectory-expand`                  | Polish §3      | `retrieve.ts` `debugStep` order; `TemporalStore.explain`                     | `v03-polish.test.ts`, `r9d-conformance.test.ts` |
| Named shared defaults (retrieval limit 10, oversample ×3, assembly limit 100, graph depths 3/5)               | Polish §4      | `src/internal/retrieval-defaults.ts`; `retrieve.ts`/`assemble.ts`/`graph.ts` | `v03-polish.test.ts` (via behavior)             |
| Deterministic `CTEGraphAdapter.findConnected` order (depth, link `created_at`, `id`)                          | Polish §5      | `src/defaults/graph/CTEGraphAdapter.ts`                                      | `v03-polish.test.ts`                            |

## Documentation

| Spec requirement                             | File                                                         |
| -------------------------------------------- | ------------------------------------------------------------ |
| v0.2 migration note (obsolete pre-beta path) | [../migration-v0.2-to-v0.3.md](../migration-v0.2-to-v0.3.md) |
| Release notes / breaking changes             | [../../CHANGELOG.md](../../CHANGELOG.md)                     |
| Quick-start (v0.3 surface)                   | [../../README.md](../../README.md)                           |
| Developer / contributor guide                | [../dev/README.md](../dev/README.md)                         |
| Spec amendments (table-naming, R9)           | trageti-spec-v0.3.md — dated "v0.3 Amendment" entries        |
| Spec verification matrix                     | this file                                                    |

## Documented deviations

The implementation matches the spec **as amended**. The 2026-06-01 baseline
migration reset intentionally removes the pre-beta v001-v005 upgrade chain from
the active contract; v0.2 prototype database migration is not supported because
there are no known consumers on v0.2.x or earlier.

The pre-R9 matrix listed `getTemporalSnapshot` as an "additive superset"
deviation. That framing was inaccurate; the R9 amendment makes the object form
canonical, so it is no longer a deviation.

## Allowed residual `trl_` references

These are expected, not gaps. Every other `trl_` in active `src/` code or non-historical tests is a real miss.

- Historical sections of `CHANGELOG.md`, v0.1/v0.2 specs, and older demo source documents that intentionally describe prior implementation history.
- The captured steady-state fixture name `schema-v001-v005-steady-state.ts`; it contains only `trageti_` schema objects.
- The obsolete v0.2 migration note, which now says automatic v0.2 prototype migration is unsupported.
