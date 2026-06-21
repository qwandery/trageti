# Trageti v0.4 Alpha.0 Code Review - API Surface and Mechanics

Date: 2026-06-21

Scope: current checked-out `trageti` source, focused on the public API surface and the storage, write, retrieval, indexing, migration, and formatting mechanics behind it. This review cross-checks Codex findings and the attached Claude Code review. Findings below are included only where the current source substantiates the risk.

Verdict: request changes before a wider alpha/beta cut.

## Summary

The implementation is generally well factored for a small library, but several API paths do not preserve the invariants implied by the public surface. The highest-risk issues are inconsistent middleware/query-embedding ordering, bundle writes bypassing validators, unguarded supersession closes, reindex/write races, and namespace leakage in indexing introspection. Claude's review also identified several verified hardening, performance, and DX issues; some are lower priority because they require trusted configuration or unusually large/corrupt data, but they are still worth tracking.

## Findings

| Priority | Finding | Location |
| --- | --- | --- |
| P1 | `RetrievalMiddleware.before()` runs after provider-derived query embedding, so middleware can change the query while vector search still uses the old embedding. | `src/store/TragetiStore.ts:902`, `src/pipeline/middleware.ts:20` |
| P1 | `writeEpisodeBundle()` bypasses configured `AssertionValidator`s, unlike `writeAssertion()`. | `src/store/TragetiStore.ts:363`, `src/store/TragetiStore.ts:454` |
| P1 | Supersession closes are unconditional, allowing duplicate bundle replacements or cross-connection races to overwrite a predecessor's `valid_until`. | `src/store/TragetiStore.ts:421`, `src/db/repositories/AssertionRepository.ts:70` |
| P1 | Staging-swap reindex can omit assertions written or indexed while provider calls are in flight, then swap to an index missing those rows. | `src/pipeline/reindex.ts:110`, `src/pipeline/reindex.ts:250` |
| P1 | `getMissingIndexing(namespace, ids)` can return assertion content from another namespace. | `src/store/TragetiStore.ts:1078`, `src/db/repositories/EmbeddingRepository.ts:111` |
| P2 | `trustedCustomTokenizer: true` permits raw tokenizer strings to be interpolated into FTS DDL. | `src/internal/tokenizer.ts:30`, `src/store/TragetiStore.ts:1280`, `src/store/TragetiStore.ts:1757`, `src/db/migrations/v001_baseline.ts:115` |
| P2 | `prepareDatabase({ pragmas })` interpolates custom PRAGMA keys and values without validation. | `src/defaults/connection/prepareDatabase.ts:20` |
| P2 | `assembleContext().coverage.positionRange` is computed from all retrieved assertions, not the assertions actually rendered after formatter truncation/reordering. | `src/pipeline/assemble.ts:48`, `src/pipeline/assemble.ts:51` |
| P2 | `getConnected()` hydrates connected assertions with an N+1 query pattern instead of the existing batched repository method. | `src/pipeline/graph.ts:57` |
| P2 | Vector-readiness routing is inconsistent for vector-configured namespaces whose vec0 table is missing. | `src/store/TragetiStore.ts:943`, `src/store/TragetiStore.ts:1642`, `src/pipeline/retrieve.ts:214` |
| P2 | `LinearScorer.score()` and `LinearScorer.scoreBatch()` normalize BM25 differently, so the public convenience method can disagree with pipeline scoring. | `src/defaults/scoring/LinearScorer.ts:56`, `src/defaults/scoring/LinearScorer.ts:78` |
| P2 | Supersession recursive CTEs have no explicit depth guard or cycle detection. | `src/db/repositories/AssertionRepository.ts:151`, `src/db/repositories/AssertionRepository.ts:199`, `src/db/repositories/AssertionRepository.ts:226` |
| P2 | `getTemporalSnapshot()` applies array filters in JavaScript after hydrating all temporal candidates and citations. | `src/pipeline/snapshot.ts:10`, `src/pipeline/snapshot.ts:17` |
| P2 | `assembleContext()` does not expose or propagate several key retrieval filters. | `src/domain/types.ts:352`, `src/pipeline/assemble.ts:21` |
| P2 | `writeEpisodeBundle()` silently allows cross-namespace existing link endpoints without the warning emitted by `writeLink()`. | `src/store/TragetiStore.ts:403`, `src/store/TragetiStore.ts:560` |
| P3 | The default scorers' recency terms are monotonic by assertion position but not distance-sensitive to `temporalAnchor`. | `src/defaults/scoring/RRFScorer.ts:46`, `src/defaults/scoring/LinearScorer.ts:24` |
| P3 | `embeddingTableCache` is written and deleted but never read. | `src/store/TragetiStore.ts:185`, `src/store/TragetiStore.ts:1659`, `src/store/TragetiStore.ts:1699` |
| P3 | Store construction mutates a process-global default logger. | `src/store/TragetiStore.ts:231`, `src/internal/logger.ts:103` |
| P3 | `isSqliteVecLoaded()` executes `SELECT vec_version()` repeatedly instead of caching connection-level capability. | `src/store/TragetiStore.ts:1209`, `src/store/TragetiStore.ts:1704` |
| P3 | `deleteNamespace()` uses a broad `OR` delete with multiple subqueries for cross-namespace cleanup; this should be benchmarked or split for large link tables. | `src/store/TragetiStore.ts:1119` |

## Details

### P1: Middleware can desynchronize query text and query embedding

`TragetiStore.retrieve()` calls `resolveQueryEmbedding(query)` before entering the retrieval pipeline. The retrieval pipeline then calls `applyMiddleware()`, and `before()` hooks can mutate the query passed to `retrieveCore()`. If a hook rewrites `queryText`, changes `namespace`, injects filters, or changes strategy, `query.queryEmbedding` may still be the embedding generated from the pre-middleware query.

This is a correctness problem for query expansion, tenant routing, synonym replacement, and any other middleware that changes retrieval intent. The vector branch can rank by one query while the BM25 branch and metadata describe another.

Suggested fix: split middleware into explicit phases, run all `before()` hooks before provider-derived query embedding, then validate and resolve embeddings against the final query. Keep `after()` around final results only.

### P1: Bundle writes bypass configured validators

`writeAssertion()` normalizes, enforces structural invariants, enforces citation policy, and then runs every configured `AssertionValidator`. `writeEpisodeBundle()` normalizes and enforces structural/citation checks but never runs `this.options.validators`.

That gives callers a bypass for any domain policy implemented as a validator: assertion type allow-lists, regulated content checks, custom citation policy, entity requirements, etc. Because bundle writing is part of the public API, this is not only a DX inconsistency; it can produce data that the single-assertion writer would reject.

Suggested fix: run the same validator block inside the bundle assertion loop and collect errors with assertion ids in the `EpisodeBundle` validation error.

### P1: Supersession close updates can overwrite `valid_until`

The repository close operation is:

```sql
UPDATE trageti_assertions SET valid_until = ? WHERE id = ?
```

Single-write validation checks the predecessor before the transaction, but the update itself does not require `valid_until IS NULL`. In a bundle, two new assertions can both supersede the same predecessor: both validate against the same open row, then both updates run, and the later update wins. With multiple database connections, the same check-then-update race can happen across stores.

This can corrupt lineage windows and make retrieval at historical anchors return incorrect versions.

Suggested fix:

```sql
UPDATE trageti_assertions
SET valid_until = ?
WHERE id = ? AND valid_until IS NULL
```

Then check `changes === 1`; otherwise throw and roll back. Also reject duplicate non-null `supersedesId` values inside a bundle before any write.

### P1: Staging-swap reindex is not isolated from writes

`reindexNamespace()` computes `MAX(rowid)` and iterates rows up to that snapshot while awaiting provider calls. During those awaits, other public methods can write assertions or index assertions in the same process or through another connection. The final staging swap repoints `trageti_namespaces.embedding_table` and drops the old table. Rows written after the rowid snapshot are absent from staging; embeddings inserted into the old table during the run are dropped with that table.

The current per-namespace reindex lock blocks only another `reindexNamespace()` on the same store instance. It does not block `writeAssertion()`, `writeEpisodeBundle()`, `indexAssertion()`, `indexBatch()`, `deleteNamespace()`, or other connections.

Suggested fix: add a namespace write/index/reindex lock around the swap-sensitive operations, or add a catch-up phase that re-reads rows inserted after the initial high-water mark and validates no live embeddings were lost before dropping the old table. For multi-connection correctness, use a database-level guard or transaction protocol, not just an in-memory set.

### P1: `getMissingIndexing()` can leak cross-namespace content

`getMissingIndexing(namespace, assertionIds)` checks the supplied ids against the namespace's embedding table, but then hydrates missing ids with `assertionRepo.getByIds(missingIds)`, which queries by global assertion id only. If a caller passes an id from namespace B to `getMissingIndexing('A', [idFromB])`, the method can return namespace B's assertion content as missing for namespace A.

Suggested fix: filter hydrated assertions by `assertion.namespace === namespace`, or better, push namespace into the SQL by joining `trageti_assertions` in `EmbeddingRepository.getMissingIndexingByIds()`.

### P2: Trusted tokenizer config can inject FTS DDL

The tokenizer config is interpolated into DDL as:

```ts
tokenize='${tokenizeArg}'
```

`validateTokenizer()` skips all checks when `trustedCustomTokenizer: true`. The public type comment says the caller must fully trust the tokenizer and notes that the library interpolates it without checks, so this is not an undocumented remote vulnerability. It is still a dangerous API footgun: any application that loads tokenizer config from JSON/env/admin UI can turn this into arbitrary DDL execution during init/rebuild.

Suggested fix: even for trusted custom tokenizer names, quote single quotes in the assembled tokenize string or keep the tokenizer name custom while still validating/escaping arguments. At minimum, make the public warning explicit in README/API docs, not only in the type comment.

### P2: Custom PRAGMAs are unvalidated SQL fragments

`prepareDatabase()` forwards arbitrary custom pragmas with:

```ts
db.pragma(`${key} = ${String(value)}`);
```

This makes `key` and `value` a developer-facing SQL fragment API. That may be acceptable as an advanced escape hatch, but it is not validated or documented as such. If any caller wires external configuration into `PrepareDatabaseOptions.pragmas`, this becomes an injection surface or at least a way to apply unsafe connection settings.

Suggested fix: either restrict custom pragma keys to a known-safe identifier pattern and primitive values, or rename/document the option as trusted raw pragma configuration.

### P2: `assembleContext` coverage can report unrendered positions

`assembleContext()` lets formatters truncate or reorder output. It correctly uses `formatted.includedAssertions` or the included prefix for `AssembledContext.assertions`, but it computes coverage position range from the full retrieved array:

```ts
const positions = assertions.map((a) => a.validFrom);
```

If a formatter includes only a subset due to token budget, or reorders/regroups and returns `includedAssertions`, `coverage.positionRange` can claim coverage for positions that are not present in the returned context text.

Suggested fix: compute coverage from `renderedAssertions`, not `assertions`.

### P2: `getConnected()` has an N+1 hydration path

`getConnected()` collects connected ids and then calls `assertionRepo.getById()` for each id. Each assertion hydration also fetches citations. `AssertionRepository.getByIds()` already provides batched assertion and citation hydration.

Suggested fix: replace the per-id map with `assertionRepo.getByIds(ids)`, preserving the adapter's deterministic id order if that is part of the API contract.

### P2: Missing vector table routing is inconsistent

For vector-configured namespaces, `ensureVectorReadable()` returns `null` when the stored vec0 table does not exist. With explicit `queryEmbedding` and `retrievalStrategy: 'vector'`, retrieval can return an empty result rather than creating the table, warning, or throwing. With hybrid text-only retrieval and a provider, Step 0 can derive a query embedding, but if the vec table is missing later, the pipeline falls back to BM25 without the `TRGT_RETRIEVE_VECTOR_SKIPPED` warning that `resolveQueryEmbedding()` emits for other hybrid degradations.

Suggested fix: decide whether a missing vec table means "valid empty index", "index not ready", or "create on read", and make `retrieve()`, `explain()`, and warnings agree.

### P2: `LinearScorer.score()` disagrees with `scoreBatch()`

The public `score()` convenience method normalizes BM25 from a single raw value using `1 - 1 / (1 + abs(score))`. `scoreBatch()` normalizes BM25 across the candidate set with min-max normalization. The retrieval pipeline uses only `scoreBatch()`, so callers who manually score candidates with `score()` can get rankings that do not match retrieval.

Suggested fix: either remove/deprecate the single-candidate helper, document that it is intentionally not pipeline-equivalent for BM25, or expose a batch-only scorer surface for consistency.

### P2: Supersession recursive CTEs are unbounded

The write path normally prevents cycles by requiring a replacement's `validFrom` to be greater than its predecessor's `validFrom`. The schema does not enforce that rule, and direct database manipulation, import bugs, or historical migrations can create cycles or very deep chains. The recursive CTEs for entity trajectory and supersession chains do not cap depth or detect cycles.

Suggested fix: add a conservative depth bound and, where possible, visited-id cycle checks. Convert recursion-limit failures into a typed library error with namespace/assertion context.

### P2: Temporal snapshot filters hydrate too much data

`getTemporalSnapshot()` fetches every assertion valid at the position and hydrates citations, then filters `entityTypes` and `assertionTypes` arrays in JavaScript. On large namespaces, a selective snapshot can still read and allocate the whole temporal candidate set.

Suggested fix: add array-filter support to `AssertionRepository.query()` and push the filters into SQL before citation hydration.

### P2: `assembleContext()` cannot express common retrieval filters

`ContextAssemblyOptions` includes query text/embedding, strategy, graph expansion, mode, scorer, middleware, formatter, debug, and signal. It does not include `entityTypes`, `assertionTypes`, `minConfidence`, `includeSuperseded`, or `temporalWindow`, even though `retrieve()` supports them. The only current workaround is middleware that injects missing fields into the synthesized `RetrievalQuery`.

Suggested fix: extend `ContextAssemblyOptions` with the retrieval filters that context assembly should support, and copy them into the synthesized query.

### P2: Bundle link endpoint validation omits cross-namespace warning

Standalone `writeLink()` allows cross-namespace links but emits `TRGT_CROSS_NAMESPACE_LINK` when endpoint assertions are in different namespaces. `writeEpisodeBundle()` only checks that endpoints are bundled or globally existing; for existing endpoints, it does not inspect namespaces or emit the warning.

Suggested fix: reuse the endpoint validation/warning logic from `writeLink()` inside the bundle path, or document that bundle link warning semantics differ.

### P3: Default recency scoring is not distance-sensitive to `temporalAnchor`

`RRFScorer` ignores `ScoringContext` entirely and ranks recency by candidate position descending. `LinearScorer` normalizes position inside the active namespace range. Because retrieval already filters candidates to `validFrom <= temporalAnchor`, descending position is often equivalent to "closest before anchor" for ordering. However, score magnitudes do not reflect how far the anchor is from the newest candidate, so stale snapshots can receive the same recency contribution as fresh snapshots.

This is a design limitation rather than a direct correctness bug. It should be documented, or the scorer options should offer an anchor-distance decay.

### P3: `embeddingTableCache` is dead state

The cache is set after vector readiness, reindex, and namespace upgrade, and deleted on namespace deletion. No code reads it. The effective source of truth is always `trageti_namespaces.embedding_table`.

Suggested fix: remove the cache, or wire it into a carefully invalidated lookup path. Given the persisted table name is authoritative and can be changed by other connections, removal may be safer.

### P3: Store construction mutates global logger fallback

Every `TragetiStore` constructor calls `setDefaultLogger(this.options.logger)`. Internal comments state this is intended only for standalone default components and does not affect store-plumbed calls. That limits severity, but multi-store applications can still have standalone `DefaultAssertionValidator`, `DefaultConnectionVerifier`, or `MockEmbeddingProvider` messages routed to whichever store was constructed most recently.

Suggested fix: avoid changing process-global fallback from store construction, or document the fallback as process-global and not store-scoped.

### P3: sqlite-vec capability is repeatedly probed

`isSqliteVecLoaded()` runs `SELECT vec_version()` each time. It is called from stats, explain, provider query routing, vector readiness, and pending-indexing paths. Extension availability is connection-level and should be stable after initialization.

Suggested fix: cache the result after init/first probe, with a narrow invalidation path only if the library explicitly supports loading sqlite-vec after store construction.

### P3: Namespace deletion link cleanup may be costly on large link tables

`deleteNamespace()` deletes links with a broad `OR` predicate that includes namespace and three subqueries for cross-namespace references. The subqueries are not correlated per row, but the `OR` shape can still make planning less predictable on large link tables.

Suggested fix: benchmark with a large link table. If it regresses, split into separate indexed deletes for same-namespace links, assertion endpoint references, and source-episode references.

## Reviewed Claude Findings Not Carried As Higher Severity

- "Scorers ignore temporal anchor" is verified in the narrow sense that the default scorers do not use anchor distance. It is recorded as P3 because filtering already constrains candidates relative to the anchor, and descending `validFrom` is equivalent to closest-before-anchor ordering for most snapshot retrievals.
- "`deleteNamespace` uses correlated subqueries" is not exactly correct; the subqueries are uncorrelated `IN` subqueries. A performance concern remains, but it should be benchmarked before prioritizing.
- `trustedCustomTokenizer` is not an undocumented vulnerability in the type surface: `FTS5TokenizerConfig` explicitly says the caller fully trusts the tokenizer and that the library interpolates it without checks. The risk is still real enough to document as a P2 API footgun.

## Suggested Regression Coverage

- Middleware `before()` that rewrites `queryText` before provider embedding; assert the provider sees rewritten text.
- Bundle writer with a custom validator that rejects a specific assertion; assert bundle rolls back.
- Bundle writer with two assertions superseding the same predecessor; assert rejection before write.
- Reindex with a delayed provider while writing/indexing a new assertion before swap; assert no embedding is lost or operation is blocked.
- `getMissingIndexing('A', [idFromB])`; assert no cross-namespace content is returned.
- `assembleContext()` with a truncating/reordering formatter; assert `coverage.positionRange` matches rendered assertions.
- `getConnected()` on many links; assert batched hydration or bound query count.
