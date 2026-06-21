# Trageti v0.4 Alpha.0 Code Review - API Surface and Mechanics

Date: 2026-06-21

Scope: current checked-out `trageti` source, focused on the public API surface and the storage, write, retrieval, indexing, migration, and formatting mechanics behind it. This review cross-checks Codex findings and the attached Claude Code review. Findings below are included only where the current source substantiates the risk.

Verdict: request changes before a wider alpha/beta cut.

## Summary

The implementation is generally well factored for a small library, but several API paths do not preserve the invariants implied by the public surface. The highest-risk issues are inconsistent middleware/query-embedding ordering, bundle writes bypassing validators, unguarded supersession closes, reindex/write races, and namespace leakage in indexing introspection. Claude's review also identified several verified hardening, performance, and DX issues; some are lower priority because they require trusted configuration or unusually large/corrupt data, but they are still worth tracking.

This expanded revision adds concrete remediation proposals, alternatives, trade-offs, and focused test guidance for each finding.

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

Primary proposal:

- Split middleware application into `applyBeforeMiddleware()` and `applyAfterMiddleware()`.
- In `TragetiStore.retrieve()`, run `before` hooks first, then call `requireNamespaceInit()` and `validateRetrievalQuery()` on the transformed query, then call `resolveQueryEmbedding()` on that transformed query.
- Pass the already-routed query into a retrieval core that no longer invokes `before` hooks internally.
- Run `after` hooks after ranking/decoration and preserve the meta envelope. If `after` changes result length, decide whether `candidateCount` remains pre-after or add `postMiddlewareCount`.

Sketch:

```ts
const pre = applyBeforeMiddleware(this.options.middleware, query.middleware ?? [], query);
this.requireNamespaceInit(pre.namespace);
validateRetrievalQuery(pre);
const { query: routed, skipReason } = await this.resolveQueryEmbedding(pre);
const result = retrieveCoreWithAfterMiddleware(this.db, ctx, routed, middleware);
```

Alternative A: move `resolveQueryEmbedding()` into `retrieveCore()` after `applyMiddleware()` runs. This keeps middleware orchestration in the pipeline but requires passing provider resolution and store-specific vector checks into the pipeline context. Trade-off: fewer phases in `TragetiStore`, but more store responsibilities leak into `pipeline/retrieve.ts`.

Alternative B: document that middleware must not alter `queryText`, `queryEmbedding`, `namespace`, or `retrievalStrategy`. This is lower effort but leaves an unsafe footgun in a public extension point and makes middleware much less useful.

Tests:

- A `before()` hook rewrites `queryText` from `"old"` to `"new"`; a fake provider records input and must receive `"new"`.
- A `before()` hook changes namespace to an uninitialized namespace; retrieval must fail on the transformed namespace.
- A `before()` hook injects `retrievalStrategy: 'bm25'`; provider must not be called.

### P1: Bundle writes bypass configured validators

`writeAssertion()` normalizes, enforces structural invariants, enforces citation policy, and then runs every configured `AssertionValidator`. `writeEpisodeBundle()` normalizes and enforces structural/citation checks but never runs `this.options.validators`.

That gives callers a bypass for any domain policy implemented as a validator: assertion type allow-lists, regulated content checks, custom citation policy, entity requirements, etc. Because bundle writing is part of the public API, this is not only a DX inconsistency; it can produce data that the single-assertion writer would reject.

Primary proposal:

- Extract the shared assertion validation path into a private helper, for example `validateAssertionForWrite(assertion, context)`.
- Let the helper accept `inFlightEpisodeIds` and `collectErrors`, so single writes and bundle writes can share structural, citation-policy, and custom-validator logic without duplicating code.
- Prefix custom-validator errors in bundle mode with assertion id, for example `assertion "a-2": <validator message>`, so aggregate bundle errors remain actionable.

Sketch:

```ts
private validateAssertionForWrite(
  assertion: NormalizedNewAssertion,
  options: { inFlightEpisodeIds?: ReadonlySet<string>; collectErrors?: string[] } = {},
): void {
  this.enforceStructuralInvariants(assertion, options);
  this.enforceCitationExcerptPolicy(assertion);
  const errors = options.collectErrors ?? [];
  for (const validator of this.options.validators) {
    const result = validator.validate(assertion);
    if (!result.valid) errors.push(...result.errors.map((e) => `assertion "${assertion.id}": ${e}`));
  }
  if (!options.collectErrors && errors.length > 0) throw new ValidationError(errors, 'Assertion');
}
```

Alternative A: call `this.writeAssertion()` inside `writeEpisodeBundle()` after inserting the episode. This reuses validation, but it creates nested transactions and does not naturally handle bundled links or all-or-nothing failure across multiple assertions unless refactored carefully.

Alternative B: keep validators out of bundles and document the difference. This is not recommended because it makes the bundle API a validation bypass by design.

Tests:

- Register a validator that rejects `type: 'blocked'`; verify `writeAssertion()` and `writeEpisodeBundle()` both reject and no episode/assertions are committed.
- Verify the default validator still runs once, not twice, when no validators are supplied.
- Verify bundle errors include enough assertion identity to debug which assertion failed.

### P1: Supersession close updates can overwrite `valid_until`

The repository close operation is:

```sql
UPDATE trageti_assertions SET valid_until = ? WHERE id = ?
```

Single-write validation checks the predecessor before the transaction, but the update itself does not require `valid_until IS NULL`. In a bundle, two new assertions can both supersede the same predecessor: both validate against the same open row, then both updates run, and the later update wins. With multiple database connections, the same check-then-update race can happen across stores.

This can corrupt lineage windows and make retrieval at historical anchors return incorrect versions.

Primary proposal:

- Change `AssertionRepository.supersedeAssertion()` to return a boolean or throw on failed close.
- Use a guarded update:

```sql
UPDATE trageti_assertions
SET valid_until = ?
WHERE id = ? AND valid_until IS NULL
```

- Check `info.changes === 1`. If not, throw a typed `ValidationError` or `TragetiError` that says the predecessor was already closed or missing.
- Add bundle pre-validation that rejects duplicate non-null `supersedesId` values before opening the transaction.

Sketch:

```ts
supersedeAssertion(assertionId: string, validUntil: number): void {
  const info = this.db
    .prepare('UPDATE trageti_assertions SET valid_until = ? WHERE id = ? AND valid_until IS NULL')
    .run(validUntil, assertionId);
  if (info.changes !== 1) {
    throw new ValidationError([`predecessor "${assertionId}" is not open`], 'Assertion');
  }
}
```

Alternative A: enforce a partial uniqueness rule in schema so only one live successor can point at a predecessor. SQLite cannot express "only one successor whose predecessor is still open" cleanly with current columns, but a unique index on `supersedes_id` where not null would prevent branching replacements entirely. Trade-off: this may forbid legitimate branch histories if the library ever wants them.

Alternative B: use `BEGIN IMMEDIATE` around the whole validation/write transaction to reduce cross-connection races. This improves isolation but does not replace the guarded update, because stale pre-validation can still exist inside one bundle.

Tests:

- Bundle with two assertions superseding the same predecessor must reject before write.
- Two stores sharing a file database attempt competing supersessions; only one should commit and the other should fail typed.
- The rejected path must not leave the new assertion inserted without a valid predecessor close.

### P1: Staging-swap reindex is not isolated from writes

`reindexNamespace()` computes `MAX(rowid)` and iterates rows up to that snapshot while awaiting provider calls. During those awaits, other public methods can write assertions or index assertions in the same process or through another connection. The final staging swap repoints `trageti_namespaces.embedding_table` and drops the old table. Rows written after the rowid snapshot are absent from staging; embeddings inserted into the old table during the run are dropped with that table.

The current per-namespace reindex lock blocks only another `reindexNamespace()` on the same store instance. It does not block `writeAssertion()`, `writeEpisodeBundle()`, `indexAssertion()`, `indexBatch()`, `deleteNamespace()`, or other connections.

Primary proposal:

- Introduce a persisted namespace operation lock, not only an in-memory `Set`.
- A practical SQLite-native option is a table such as `trageti_namespace_locks(namespace TEXT PRIMARY KEY, operation TEXT, owner TEXT, acquired_at TEXT)`.
- `reindexNamespace()` acquires an exclusive namespace lock before the row snapshot and releases it after swap/drop.
- Write/index/delete operations that affect the namespace check for the lock and either wait, fail with a typed error, or accept an explicit option like `{ waitForReindex: true }`.
- For file-backed multi-connection use, acquire the lock inside an immediate transaction or use a unique insert and busy timeout semantics.

Alternative A: catch-up strategy. Reindex snapshots `highWaterRowid`, builds staging, then before swap repeatedly indexes rows with `rowid > highWaterRowid` until no new rows appear. Trade-off: it avoids blocking writes, but if writes continue steadily the catch-up may starve or require a cutoff policy. It also does not preserve embeddings written manually to the old vec table unless the catch-up regenerates them from provider.

Alternative B: copy old-table rows for late writes into staging immediately before dropping old table. Trade-off: this preserves embeddings that were inserted during reindex, but it cannot handle new assertions without embeddings, dimension changes, provider-derived embeddings with new dimensions, or old-table embeddings whose dimension differs from `newDimension`.

Alternative C: document reindex as requiring an application-level write pause. This is acceptable for a low-level maintenance command only if the API surfaces the risk prominently and refuses concurrent same-store writes. It is not enough for a library that advertises staging-swap safety.

Tests:

- A delayed provider pauses reindex after the row snapshot; write and index a new assertion before swap; verify the new assertion is pending or indexed correctly after swap, never silently lost.
- Same scenario across two `TragetiStore` instances on one file database.
- `deleteNamespace()` during reindex must block or fail typed.

### P1: `getMissingIndexing()` can leak cross-namespace content

`getMissingIndexing(namespace, assertionIds)` checks the supplied ids against the namespace's embedding table, but then hydrates missing ids with `assertionRepo.getByIds(missingIds)`, which queries by global assertion id only. If a caller passes an id from namespace B to `getMissingIndexing('A', [idFromB])`, the method can return namespace B's assertion content as missing for namespace A.

Primary proposal:

- Push namespace filtering into `EmbeddingRepository.getMissingIndexingByIds()`.
- Change the signature to `getMissingIndexingByIds(tableName, namespace, assertionIds)`.
- Join `trageti_assertions` so only ids that belong to the requested namespace can be returned.

Sketch:

```sql
SELECT input.value AS id
FROM json_each(?) input
JOIN trageti_assertions a ON a.id = input.value AND a.namespace = ?
LEFT JOIN "embedding_table" e ON e.assertion_id = a.id
WHERE e.assertion_id IS NULL
```

Alternative A: keep repository method as-is and filter after hydration:

```ts
return assertion && assertion.namespace === namespace ? [{ id, content: assertion.content }] : [];
```

Trade-off: this is a small local fix but still asks the embedding repository the wrong question and can create confusing intermediate "missing" ids.

Alternative B: make assertion ids namespace-scoped instead of globally primary-keyed. This is a major schema change and not appropriate as a narrow fix.

Tests:

- Namespace A and B each initialized; pass B's assertion id to `getMissingIndexing('A', ...)`; result must be empty.
- Include a mix of A ids and B ids; only A ids should be considered.
- Vectorless namespace behavior should remain unchanged or explicitly reject ids outside the namespace.

### P2: Trusted tokenizer config can inject FTS DDL

The tokenizer config is interpolated into DDL as:

```ts
tokenize='${tokenizeArg}'
```

`validateTokenizer()` skips all checks when `trustedCustomTokenizer: true`. The public type comment says the caller must fully trust the tokenizer and notes that the library interpolates it without checks, so this is not an undocumented remote vulnerability. It is still a dangerous API footgun: any application that loads tokenizer config from JSON/env/admin UI can turn this into arbitrary DDL execution during init/rebuild.

Primary proposal:

- Keep `trustedCustomTokenizer` only as an escape hatch for tokenizer names, not arbitrary tokenizer argument text.
- Validate every tokenizer argument with the existing `SAFE_ARG` regex even when `trustedCustomTokenizer` is true.
- Validate trusted tokenizer names with a conservative identifier regex, for example `/^[A-Za-z_][A-Za-z0-9_]*$/`, unless SQLite FTS5 permits a broader safe set that is explicitly quoted.
- Centralize DDL rendering in a helper such as `formatFts5TokenizeArg(config)`, and use it in baseline migration creation, `rebuildFts()`, and `applyFtsTokenizer()`.

Alternative A: SQL-escape single quotes in the final tokenize string. Trade-off: this addresses string-literal breakout but still allows unsupported or malformed tokenizer args to fail later with raw SQLite errors. It also does not make the accepted grammar explicit.

Alternative B: provide two APIs: safe `fts5Tokenizer` with validation and advanced `trustedRawFts5Tokenize: string`. Trade-off: this is honest about raw SQL semantics but expands public API and requires strong docs.

Alternative C: document the existing flag more loudly and leave behavior unchanged. Trade-off: lowest churn, but any config-driven application remains one mistake away from DDL injection.

Tests:

- Trusted custom tokenizer with safe name and safe args is accepted.
- Trusted tokenizer with an arg containing a quote, semicolon, whitespace, or parenthesis is rejected before DDL.
- Baseline migration, `rebuildFts()`, and empty-db tokenizer reconciliation all use the same validation helper.

### P2: Custom PRAGMAs are unvalidated SQL fragments

`prepareDatabase()` forwards arbitrary custom pragmas with:

```ts
db.pragma(`${key} = ${String(value)}`);
```

This makes `key` and `value` a developer-facing SQL fragment API. That may be acceptable as an advanced escape hatch, but it is not validated or documented as such. If any caller wires external configuration into `PrepareDatabaseOptions.pragmas`, this becomes an injection surface or at least a way to apply unsafe connection settings.

Primary proposal:

- Restrict `options.pragmas` to safe pragma identifiers and primitive values.
- Validate keys with `/^[A-Za-z_][A-Za-z0-9_]*$/`.
- Validate values by type:
  - numbers must be finite;
  - strings must match a conservative token regex such as `/^[A-Za-z0-9_./:-]+$/`, or be selected from per-pragma allow-lists for known pragmas.
- Reject `foreign_keys` in custom pragmas or apply it last to guarantee library FK enforcement remains on.

Alternative A: replace `pragmas?: Record<string, string | number>` with `trustedPragmas?: string[]`. Trade-off: honest raw SQL escape hatch, but breaking API and more dangerous if used casually.

Alternative B: only allow a curated set of custom pragmas, for example `cache_size`, `mmap_size`, `synchronous`, and `wal_autocheckpoint`. Trade-off: safest and easiest to document, but less flexible for advanced SQLite tuning.

Alternative C: leave behavior but document that `pragmas` is trusted raw connection configuration. Trade-off: no breakage, weaker safety.

Tests:

- Unsafe key with whitespace, semicolon, or equals is rejected.
- Unsafe string value with quote or semicolon is rejected.
- `foreign_keys: 'OFF'` cannot override the library's FK requirement.

### P2: `assembleContext` coverage can report unrendered positions

`assembleContext()` lets formatters truncate or reorder output. It correctly uses `formatted.includedAssertions` or the included prefix for `AssembledContext.assertions`, but it computes coverage position range from the full retrieved array:

```ts
const positions = assertions.map((a) => a.validFrom);
```

If a formatter includes only a subset due to token budget, or reorders/regroups and returns `includedAssertions`, `coverage.positionRange` can claim coverage for positions that are not present in the returned context text.

Primary proposal:

- Compute `coverage.positionRange` from `renderedAssertions`.
- Keep `coverage.totalAssertions` as the full retrieval result count.
- Keep `coverage.includedAssertions` from the formatter, but clamp or validate it against `renderedAssertions.length` if third-party formatters return inconsistent data.

Sketch:

```ts
const renderedPositions = renderedAssertions.map((a) => a.validFrom);
const from = renderedPositions.length > 0 ? Math.min(...renderedPositions) : options.temporalAnchor;
const to = renderedPositions.length > 0 ? Math.max(...renderedPositions) : options.temporalAnchor;
```

Alternative A: expose both `retrievedPositionRange` and `renderedPositionRange`. Trade-off: richer metadata but a breaking or additive API shape change. If callers currently interpret `positionRange` as retrieval coverage, renaming may be cleaner.

Alternative B: leave `positionRange` as retrieved range and add docs. Trade-off: preserves current tests but keeps misleading metadata for the primary LLM context output.

Tests:

- Formatter truncates to one assertion while retrieval returns many; range equals the rendered assertion.
- Formatter returns `includedAssertions` in a different order; range follows those assertions, not input prefix.
- Empty rendered set falls back to `temporalAnchor`.

### P2: `getConnected()` has an N+1 hydration path

`getConnected()` collects connected ids and then calls `assertionRepo.getById()` for each id. Each assertion hydration also fetches citations. `AssertionRepository.getByIds()` already provides batched assertion and citation hydration.

Primary proposal:

- Replace per-id hydration with `assertionRepo.getByIds(ids)`.
- Preserve traversal order by ordering the returned assertions according to the `ids` array, because SQL `IN` order is not guaranteed.

Sketch:

```ts
const hydrated = assertionRepo.getByIds(ids);
const byId = new Map(hydrated.map((a) => [a.id, a]));
return ids.flatMap((id) => {
  const assertion = byId.get(id);
  return assertion ? [assertion] : [];
});
```

Alternative A: add `getByIdsPreservingOrder(ids)` to `AssertionRepository`. Trade-off: cleaner call sites if this pattern appears elsewhere, but adds API surface to an internal repository.

Alternative B: keep N+1 because default `maxDepth` is small. Trade-off: this assumes sparse graphs and makes the public graph API perform poorly exactly when graph expansion is valuable.

Tests:

- Connected assertions return in the same deterministic order as before.
- Query-count regression using a small spy wrapper or instrumentation, if feasible.
- Citations remain populated for batched results.

### P2: Missing vector table routing is inconsistent

For vector-configured namespaces, `ensureVectorReadable()` returns `null` when the stored vec0 table does not exist. With explicit `queryEmbedding` and `retrievalStrategy: 'vector'`, retrieval can return an empty result rather than creating the table, warning, or throwing. With hybrid text-only retrieval and a provider, Step 0 can derive a query embedding, but if the vec table is missing later, the pipeline falls back to BM25 without the `TRGT_RETRIEVE_VECTOR_SKIPPED` warning that `resolveQueryEmbedding()` emits for other hybrid degradations.

Primary proposal:

- Define the missing vec0 table as "vector index not built yet", not a valid empty vector result.
- Make Step 0 check table existence before deriving provider embeddings for hybrid text-only retrieval.
- For `retrievalStrategy: 'vector'`, throw a typed `RetrievalInputError` such as `RETRIEVAL_VECTOR_INDEX_NOT_READY` when the namespace is vector-configured but the physical table is missing.
- For `hybrid`, skip vector before provider work and add the same warning envelope used for `NO_PROVIDER`, `NO_SQLITE_VEC`, and `NAMESPACE_VECTORLESS`.

Alternative A: lazily create the vec0 table on retrieval. Trade-off: avoids the missing-table state, but retrieval becomes a schema-mutating operation and can still return zero vector hits. It may surprise read-only users and fail under read-only database handles.

Alternative B: treat missing table as a valid empty vector index. Trade-off: simple, but provider calls can be wasted and callers receive no actionable signal that indexing has never happened.

Alternative C: create vec0 table during namespace initialization/upgrade. Trade-off: makes vector readiness explicit earlier but requires sqlite-vec at init for all vector namespaces, reducing the current vectorless/BM25 fallback flexibility.

Tests:

- Vector strategy with missing vec0 table throws typed.
- Hybrid text-only with provider and missing vec0 table does not call provider and emits `TRGT_RETRIEVE_VECTOR_SKIPPED` with a new or documented reason.
- `explain()` reports the same would-apply decision as `retrieve()`.

### P2: `LinearScorer.score()` disagrees with `scoreBatch()`

The public `score()` convenience method normalizes BM25 from a single raw value using `1 - 1 / (1 + abs(score))`. `scoreBatch()` normalizes BM25 across the candidate set with min-max normalization. The retrieval pipeline uses only `scoreBatch()`, so callers who manually score candidates with `score()` can get rankings that do not match retrieval.

Primary proposal:

- Deprecate `LinearScorer.score()` in docs and JSDoc, and state that pipeline-equivalent scoring requires `scoreBatch()`.
- If keeping it, restrict `score()` to semantic-only or vector-only use where no cross-candidate normalization is needed, and throw or warn when `bm25Score !== null`.
- Update README examples to use `scoreBatch()` only.

Alternative A: make `score()` call `scoreBatch([candidate], context)[0]`. Trade-off: simple consistency for one-candidate batches, but it still will not match scoring the same candidate inside a larger candidate set because BM25 min-max normalization is inherently batch-relative.

Alternative B: change `scoreBatch()` to use the same absolute BM25 transform as `score()`. Trade-off: makes single and batch scoring consistent, but changes retrieval ranking behavior and may regress existing tests that expect relative BM25 normalization.

Alternative C: add `scoreSingle()` as explicitly non-pipeline-equivalent and remove `score()` in the next major version. Trade-off: clearer API, breaking or deprecating existing convenience use.

Tests:

- JSDoc/API export tests are not needed, but unit tests should lock the chosen behavior.
- If `score()` throws on BM25, add tests for semantic-only success and BM25 rejection.
- If `scoreBatch()` changes normalization, add ranking regression tests for BM25-only and hybrid candidates.

### P2: Supersession recursive CTEs are unbounded

The write path normally prevents cycles by requiring a replacement's `validFrom` to be greater than its predecessor's `validFrom`. The schema does not enforce that rule, and direct database manipulation, import bugs, or historical migrations can create cycles or very deep chains. The recursive CTEs for entity trajectory and supersession chains do not cap depth or detect cycles.

Primary proposal:

- Add a shared constant such as `MAX_SUPERSESSION_CHAIN_DEPTH = 1000`.
- Add depth predicates to all recursive terms.
- Add visited-id cycle protection to CTEs where practical.
- After query completion, detect truncated chains by checking whether the terminal row still has a non-null `supersedes_id` at the max depth, and throw a typed error rather than silently returning a partial chain.

Alternative A: rely on SQLite recursion limits. Trade-off: no code change, but failures are opaque and may do unnecessary work before failing.

Alternative B: validate chain acyclicity during every write by walking the predecessor chain. Trade-off: protects normal writes and lets reads stay simpler, but does not protect against direct DB corruption and adds write cost proportional to chain depth.

Alternative C: add database triggers to enforce increasing `valid_from` or prevent cycles. Trade-off: stronger integrity at the DB layer, but SQLite recursive trigger logic is harder to maintain and may complicate migrations.

Tests:

- Manually corrupt a test DB to create a cycle; `getSupersessionChain()` and `getEntityTrajectory()` should fail typed or stop safely.
- Create a chain at the max depth boundary; verify expected success/failure behavior.
- Normal trajectory tests should remain unchanged.

### P2: Temporal snapshot filters hydrate too much data

`getTemporalSnapshot()` fetches every assertion valid at the position and hydrates citations, then filters `entityTypes` and `assertionTypes` arrays in JavaScript. On large namespaces, a selective snapshot can still read and allocate the whole temporal candidate set.

Primary proposal:

- Extend `AssertionRepository.query()` to accept array filters: `entityTypes?: string[]`, `types?: string[]`.
- Generate `IN (?, ?, ...)` clauses in SQL before fetching rows and citations.
- Have `getTemporalSnapshot()` pass those arrays directly rather than post-filtering.

Alternative A: keep repository single-value filters and loop per requested type. Trade-off: easier incremental change but can duplicate rows when both entity and assertion type arrays are supplied, and requires merge/dedup logic.

Alternative B: leave JS filtering for small datasets and document it. Trade-off: easy, but temporal snapshot is a public API likely to be used for broad namespace views, so scaling surprises remain.

Tests:

- Snapshot with `entityTypes` and `assertionTypes` returns the same rows as current behavior.
- Empty filter arrays mean no filter, matching current behavior.
- Citations are loaded only for matched rows; this can be tested indirectly by row counts or with query instrumentation.

### P2: `assembleContext()` cannot express common retrieval filters

`ContextAssemblyOptions` includes query text/embedding, strategy, graph expansion, mode, scorer, middleware, formatter, debug, and signal. It does not include `entityTypes`, `assertionTypes`, `minConfidence`, `includeSuperseded`, or `temporalWindow`, even though `retrieve()` supports them. The only current workaround is middleware that injects missing fields into the synthesized `RetrievalQuery`.

Primary proposal:

- Add retrieval filter fields to `ContextAssemblyOptions`:

```ts
temporalWindow?: { from?: number; to?: number };
entityTypes?: string[];
assertionTypes?: string[];
minConfidence?: number;
includeSuperseded?: boolean;
```

- Copy those fields into the synthesized `RetrievalQuery` in `assembleContext()`.
- Let existing `validateRetrievalQuery()` handle validation after `store.retrieve()` is called, or pre-validate in `assembleContext()` only where needed for earlier errors.

Alternative A: add a `retrieval?: Omit<RetrievalQuery, 'namespace' | 'temporalAnchor' | 'limit'>` sub-object. Trade-off: avoids continuously mirroring retrieval fields, but creates a nested API and potential precedence questions with existing top-level fields.

Alternative B: add `query?: Partial<RetrievalQuery>`. Trade-off: flexible, but too easy for callers to override `namespace`, `temporalAnchor`, or `limit` in ways that conflict with assembly semantics.

Alternative C: document middleware as the official extension mechanism. Trade-off: no type changes, but poor ergonomics for the primary high-level LLM API.

Tests:

- `assembleContext({ entityTypes, assertionTypes, minConfidence, temporalWindow })` returns the same assertion ids as `retrieve()` with equivalent options.
- `includeSuperseded` propagates into retrieval and graph expansion.
- Invalid `minConfidence` or temporal window fails with the same typed errors as `retrieve()`.

### P2: Bundle link endpoint validation omits cross-namespace warning

Standalone `writeLink()` allows cross-namespace links but emits `TRGT_CROSS_NAMESPACE_LINK` when endpoint assertions are in different namespaces. `writeEpisodeBundle()` only checks that endpoints are bundled or globally existing; for existing endpoints, it does not inspect namespaces or emit the warning.

Primary proposal:

- Extract link endpoint validation into a helper used by both `writeLink()` and `writeEpisodeBundle()`.
- The helper should resolve endpoint assertions from bundled assertions first, then from the repository.
- It should emit the same `TRGT_CROSS_NAMESPACE_LINK` warning whenever both endpoints are known and namespaces differ.
- It should also decide whether a link in namespace A may point to an existing assertion in namespace B when only one endpoint is bundled.

Alternative A: reject cross-namespace links in bundles even though `writeLink()` allows them. Trade-off: stricter and safer, but inconsistent unless `writeLink()` changes too.

Alternative B: keep allowing silently and document that bundle writes skip the warning. Trade-off: preserves behavior but undermines log-based detection of cross-namespace graph edges.

Tests:

- Bundle link with cross-namespace existing endpoint emits `TRGT_CROSS_NAMESPACE_LINK`.
- Bundle link between two bundled same-namespace assertions emits no warning.
- Bundle link between bundled assertion and missing endpoint still rejects.

### P3: Default recency scoring is not distance-sensitive to `temporalAnchor`

`RRFScorer` ignores `ScoringContext` entirely and ranks recency by candidate position descending. `LinearScorer` normalizes position inside the active namespace range. Because retrieval already filters candidates to `validFrom <= temporalAnchor`, descending position is often equivalent to "closest before anchor" for ordering. However, score magnitudes do not reflect how far the anchor is from the newest candidate, so stale snapshots can receive the same recency contribution as fresh snapshots.

This is a design limitation rather than a direct correctness bug. It should be documented, or the scorer options should offer an anchor-distance decay.

Primary proposal:

- Keep the current default ordering semantics for compatibility, but rename/document the signal as "latest valid assertion" rather than "temporal proximity".
- Add an optional anchor-distance recency mode:

```ts
new RRFScorer({ recencyMode: 'position-rank' | 'anchor-distance' })
new LinearScorer({ recencyMode: 'namespace-position' | 'anchor-distance' })
```

- For anchor-distance, score candidates by `1 / (1 + max(0, temporalAnchor - candidate.position))`, optionally normalized within the candidate set.

Alternative A: switch the default scorer to anchor-distance. Trade-off: more temporally intuitive, but changes existing rankings and may surprise users relying on current latest-first bias.

Alternative B: leave scorers unchanged and document custom scorer examples. Trade-off: least risky for compatibility, but weakens the library's temporal-awareness story.

Tests:

- Existing scorer tests preserve default ranking.
- New anchor-distance mode gives lower recency score as distance from anchor increases.
- Candidate with `position > temporalAnchor` should not occur after filtering, but scorer should clamp gracefully if called directly.

### P3: `embeddingTableCache` is dead state

The cache is set after vector readiness, reindex, and namespace upgrade, and deleted on namespace deletion. No code reads it. The effective source of truth is always `trageti_namespaces.embedding_table`.

Primary proposal:

- Remove `embeddingTableCache` entirely.
- Continue reading `embedding_table` from `trageti_namespaces`, which is the documented database-authoritative source and handles cross-connection reindex swaps correctly.

Alternative A: wire the cache into `getEmbeddingTable()` calls. Trade-off: saves a small DB lookup but creates invalidation complexity across multiple store instances and after external DB changes. This is risky because reindex intentionally changes the stored table name.

Alternative B: keep it as future scaffolding with a comment. Trade-off: preserves dead state and ongoing confusion.

Tests:

- Existing namespace/reindex tests should pass unchanged after removal.
- Multi-store reindex/read test should confirm the reader sees the persisted table name without cache staleness.

### P3: Store construction mutates global logger fallback

Every `TragetiStore` constructor calls `setDefaultLogger(this.options.logger)`. Internal comments state this is intended only for standalone default components and does not affect store-plumbed calls. That limits severity, but multi-store applications can still have standalone `DefaultAssertionValidator`, `DefaultConnectionVerifier`, or `MockEmbeddingProvider` messages routed to whichever store was constructed most recently.

Primary proposal:

- Stop calling `setDefaultLogger()` from the store constructor.
- Store-internal defaults should continue receiving `this.options.logger` explicitly.
- Standalone default components should use their own default `ConsoleLogger` unless caller passes a logger.

Alternative A: keep process-global fallback but expose it as an explicit API, for example `setTragetiDefaultLogger(logger)`. Trade-off: clearer ownership, but still global.

Alternative B: make default logger async-local or store-contextual. Trade-off: over-engineered for current use and not needed if store internals are already plumbed.

Alternative C: leave current behavior because comments label it acceptable. Trade-off: surprising multi-instance side effect remains.

Tests:

- Construct store A with logger A, store B with logger B, then run store A validation warning; it should use logger A.
- Standalone `DefaultAssertionValidator` without logger should use a predictable default, not whichever store was most recently constructed.

### P3: sqlite-vec capability is repeatedly probed

`isSqliteVecLoaded()` runs `SELECT vec_version()` each time. It is called from stats, explain, provider query routing, vector readiness, and pending-indexing paths. Extension availability is connection-level and should be stable after initialization.

Primary proposal:

- Add a private `sqliteVecLoaded: boolean | null = null`.
- Initialize it during `init()` after connection verification, or lazily cache the first probe result.
- If the library supports callers loading sqlite-vec after store init, expose a method like `refreshConnectionCapabilities()`; otherwise document that extension loading must happen before store initialization.

Alternative A: cache only positive results. Trade-off: supports late extension loading because a prior negative can later become positive, but repeated negative paths still pay query cost.

Alternative B: leave uncached because the query is cheap. Trade-off: simplest but noisy and repeated on hot retrieval/status paths.

Tests:

- Repeated `getStats()` or `explain()` calls should not repeatedly invoke `vec_version()` if instrumentation is feasible.
- `loadSqliteVec: false` vectorless workflows still behave correctly with cached false.

### P3: Namespace deletion link cleanup may be costly on large link tables

`deleteNamespace()` deletes links with a broad `OR` predicate that includes namespace and three subqueries for cross-namespace references. The subqueries are not correlated per row, but the `OR` shape can still make planning less predictable on large link tables.

Primary proposal:

- Split cleanup into separate statements:

```sql
DELETE FROM trageti_links WHERE namespace = ?;
DELETE FROM trageti_links WHERE from_id IN (...assertions...);
DELETE FROM trageti_links WHERE to_id IN (...assertions...);
DELETE FROM trageti_links WHERE source_episode_id IN (...episodes...);
```

- Run all deletes inside the existing namespace-delete transaction.
- Keep indexes on `namespace`, `from_id`, `to_id`, and `source_episode_id` useful independently.

Alternative A: materialize ids into temporary tables and delete with joins/`EXISTS`. Trade-off: better for very large namespaces, more DDL and temp-table complexity.

Alternative B: keep the current query until benchmarks show a problem. Trade-off: reasonable for small data, but the library already permits cross-namespace links, so delete performance can degrade as graph size grows.

Tests:

- Existing cross-namespace cleanup tests must continue passing.
- Add a query-plan or benchmark-style test only if the project already accepts performance tests; otherwise keep this as implementation guidance.

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

## Suggested Implementation Order

1. Fix the validation and namespace-boundary defects first: bundle validator parity, guarded supersession close, duplicate `supersedesId` detection, and `getMissingIndexing()` namespace filtering.
2. Fix retrieval correctness next: middleware ordering and vector-readiness warning/throw semantics.
3. Fix context metadata and graph hydration performance; both are small, low-risk patches.
4. Decide reindex isolation deliberately. This is the broadest fix and should be designed once with multi-connection behavior in mind.
5. Harden trusted configuration surfaces: tokenizer rendering and custom pragmas.
6. Address P3 cleanup and documentation improvements during routine maintenance.
