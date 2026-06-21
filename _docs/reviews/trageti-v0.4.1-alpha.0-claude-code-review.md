# Trageti v0.4.1-alpha.0 — Code Review: API Surface & Underlying Mechanics

**Date:** 2026-06-21
**Reviewer:** Claude Opus 4.6 (via Claude Code)
**Scope:** Public API surface and the storage, validation, indexing, scoring, graph, retrieval, reindex, and migration mechanics. Focused on genuine correctness/data-integrity flaws, retrieval accuracy risks, significant DX obstacles, and security vulnerabilities.
**Verdict:** Request changes before promoting this alpha.

---

## Executive Summary

The library is architecturally sound: temporal semantics are well-modeled, the retrieval pipeline has clear separation of concerns, SQL injection surfaces are systematically guarded, and error codes are stable. However, several issues remain that can silently corrupt retrieval results, cause data loss during lifecycle transitions, or leak raw database errors to callers.

The three highest-impact findings are:

1. **In-flight operations are rejected mid-execution during `close()`**, violating the documented "wait for in-flight" contract and risking partial writes.
2. **Duplicate caller-provided IDs surface as raw SQLite constraint errors** rather than typed `ValidationError`s, breaking programmatic error handling.
3. **Scorer position normalization uses only active assertions**, distorting recency scoring for namespaces with substantial supersession history.

---

## Findings Summary

| # | Sev | Finding | Primary Location |
|---|-----|---------|-----------------|
| 1 | P1 | `close()` rejects in-flight operations mid-execution | `TragetiStore.ts:1429,1601,618` |
| 2 | P1 | Duplicate caller IDs produce raw SQLite errors, not typed errors | `AssertionRepository.ts:48`, `EpisodeRepository.ts:43`, `LinkRepository.ts:49` |
| 3 | P1 | `close()` leaves store in limbo if middleware `dispose()` throws | `TragetiStore.ts:1427-1439` |
| 4 | P2 | `getPositionRange` scoped to active assertions distorts scorer recency | `NamespaceRepository.ts:117-125` |
| 5 | P2 | `resolveQueryEmbedding` dimension mismatch surfaces as misleading "queryEmbedding" error | `TragetiStore.ts:1004,retrieve.ts:276-283` |
| 6 | P2 | `reindexNamespace` indexes all assertions; `getPendingIndexing` reports only active — inconsistent contract | `reindex.ts:121`, `EmbeddingRepository.ts:74-83` |
| 7 | P2 | `getMissingIndexing` throws on vectorless namespaces; `getPendingIndexing` returns `[]` — inconsistent degradation | `TragetiStore.ts:1088` vs `866-893` |
| 8 | P2 | Stale vec0 embeddings for superseded assertions are never cleaned | `AssertionRepository.ts:75-79`, `EmbeddingRepository.ts:49-53` |
| 9 | P3 | `deleteNamespace` has redundant link-deletion queries | `TragetiStore.ts:1127-1136` |
| 10 | P3 | `getSupersessionChain(s)` has no namespace constraint (relies on write-time validation) | `AssertionRepository.ts:220-235,249-263` |
| 11 | P3 | `json_each` candidate serialization has no size guard for large namespaces | `candidates.ts:9`, `retrieve.ts:308,339` |
| 12 | P3 | `isSqliteVecLoaded()` caches result permanently — no recovery if extension loaded later | `TragetiStore.ts:1832-1841` |
| 13 | Sec | Schema extension `createSQL` executes arbitrary caller SQL without content validation | `extensions.ts:74` |
| 14 | Sec | FTS5 tokenizer args and vec0 dimension interpolated into DDL (safe but not defense-in-depth) | `v001_baseline.ts:122`, `EmbeddingRepository.ts:22,43` |

---

## Detailed Findings

### F1 [P1]: `close()` rejects in-flight operations mid-execution — violates "wait for in-flight" contract

**Location:** [TragetiStore.ts:1427-1439](src/store/TragetiStore.ts#L1427-L1439), [TragetiStore.ts:1600-1602](src/store/TragetiStore.ts#L1600-L1602)

**Problem:**
`close()` sets `this.closing = true` (line 1429) before calling `waitForInFlightOperations()` (line 1430). The `requireNotClosed()` guard (line 1601) checks `this.closed || this.closing`. This means an already-in-flight operation (e.g., `indexAssertion`) that calls `requireNotClosed()` internally after an `await` boundary (e.g., after `provider.embed()` at line 618) will be rejected with `StoreClosedError` — even though `close()` is supposed to wait for it to complete.

Concrete scenario:
1. `indexAssertion()` is called → enters `trackOperation`, increments `inFlightOperations`
2. `provider.embed()` yields (async)
3. `close()` is called → sets `closing = true`, begins waiting for in-flight ops
4. `provider.embed()` resolves → `indexAssertion` resumes
5. `this.requireNotClosed('indexAssertion')` at line 618 sees `closing === true` → throws
6. The embedding was computed but never persisted; the work is wasted
7. `trackOperation` decrements counter, resolves the waiter
8. `close()` finishes, believing in-flight ops completed "successfully"

**Impact:** Silent data loss — a computed embedding (potentially expensive) is discarded. The caller receives `StoreClosedError` from an operation they believed was already accepted. The `close()` caller has no visibility into the rejection.

**Proposed Resolution:**
Introduce a `draining` state distinct from `closing`. During drain, already-in-flight operations are allowed to run through their internal `requireNotClosed` checks, but new operations are rejected:

```typescript
private requireNotClosed(operation?: string): void {
  if (this.closed) throw new StoreClosedError(operation);
  // During drain, only reject NEW operations (not already-tracked ones)
  if (this.closing && !this.isInFlightCaller()) throw new StoreClosedError(operation);
}
```

**Alternative A:** Remove the internal `requireNotClosed` calls from within async operation bodies (lines 618, 797, 906, etc.). These checks were presumably added as safety guards, but they create the contradictory behavior. **Trade-off:** removes a safety net against use-after-close for the in-flight operation's writes. **Mitigation:** the SQLite `Database` handle itself is only closed after `waitForInFlightOperations` resolves, so sync DB writes within the operation body will still succeed.

**Alternative B:** Have `close()` set `closing = true` only *after* `waitForInFlightOperations()` resolves. **Trade-off:** new operations can still start while close is draining, creating a livelock risk. **Mitigation:** use a two-phase approach — first reject new operations, then wait for existing ones without rejecting their continuations.

---

### F2 [P1]: Duplicate caller-provided IDs produce raw SQLite constraint errors

**Location:** [AssertionRepository.ts:48-67](src/db/repositories/AssertionRepository.ts#L48-L67), [EpisodeRepository.ts:43-55](src/db/repositories/EpisodeRepository.ts#L43-L55), [LinkRepository.ts:49-68](src/db/repositories/LinkRepository.ts#L49-L68), [CitationRepository.ts:53-66](src/db/repositories/CitationRepository.ts#L53-L66)

**Problem:**
All IDs (assertion, episode, link, citation) are caller-provided with no uniqueness pre-check. The database enforces uniqueness via `PRIMARY KEY`, but a duplicate insert throws a raw `better-sqlite3` `SqliteError` with a constraint-violation message rather than a typed `ValidationError` or `TragetiError`. Callers performing programmatic error handling (e.g., retry logic, error routing) must catch and parse SQLite-specific errors that are not part of the public contract.

Within `writeEpisodeBundle`, intra-bundle duplicates are validated (lines 383, 393, 404), but a duplicate against an *existing* database row is not caught — it surfaces as a raw constraint error.

**Impact:** Breaks typed error handling. Error messages expose SQLite internals (constraint names, table names) which may leak schema information. Inconsistent with the library's otherwise comprehensive typed error model.

**Proposed Resolution:**
Add a pre-insert existence check for the primary ID (single-row lookup by PK is O(1) in SQLite) and throw a `ValidationError` with a clear message:

```typescript
// In AssertionRepository.insert():
const existing = this.db.prepare('SELECT 1 FROM trageti_assertions WHERE id = ?').get(assertion.id);
if (existing) throw new ValidationError([`Assertion ID "${assertion.id}" already exists`], 'Assertion');
```

Apply the same pattern to episodes, links, and citations. For `writeEpisodeBundle`, the existing intra-bundle check handles the bundle-internal case; the per-item pre-insert check handles the cross-bundle/database case.

**Alternative A:** Wrap the INSERT in a try/catch and reclassify `SqliteError` with `SQLITE_CONSTRAINT_PRIMARYKEY` code into `ValidationError`. **Trade-off:** more brittle (depends on better-sqlite3 error shape), but avoids the extra SELECT. **Mitigation:** test against the specific error code `SQLITE_CONSTRAINT_PRIMARYKEY` rather than message parsing.

**Alternative B:** Document that duplicate IDs produce untyped errors and are the caller's responsibility. **Trade-off:** weakens the error contract significantly. **Not recommended** — every other invalid input produces a typed error.

---

### F3 [P1]: `close()` leaves store in limbo if middleware `dispose()` throws

**Location:** [TragetiStore.ts:1427-1439](src/store/TragetiStore.ts#L1427-L1439)

**Problem:**
```typescript
async close(): Promise<void> {
  if (this.closed) return;           // line 1428
  this.closing = true;               // line 1429
  await this.waitForInFlightOperations();
  for (const middleware of this.options.middleware) {
    await middleware.dispose?.();     // line 1432 — can throw
  }
  await this.options.logger.flush?.(); // line 1434 — can throw
  if (this.closeDatabaseOnStoreClose) {
    this.db.close();                 // line 1436
  }
  this.closed = true;                // line 1438
}
```

If any `middleware.dispose()` or `logger.flush()` throws, execution exits before `this.closed = true`. The store is now in a `closing = true` but `closed = false` state:
- All new operations are rejected (`requireNotClosed` sees `closing`)
- A subsequent `close()` call doesn't hit the early return (line 1428) because `closed` is false
- It re-attempts disposal, which may throw again → infinite retry loop
- The database handle is never closed → resource leak

**Impact:** Resource leak (database handle, file descriptors). If the process continues, the store is permanently unusable — neither operable nor closeable.

**Proposed Resolution:**
Ensure `closed` is set in a `finally` block, and catch disposal errors individually:

```typescript
async close(): Promise<void> {
  if (this.closed) return;
  this.closing = true;
  try {
    await this.waitForInFlightOperations();
    for (const middleware of this.options.middleware) {
      try { await middleware.dispose?.(); } catch (err) {
        this.options.logger.warn('TRGT_MIDDLEWARE_DISPOSE_ERROR', { error: errorCodeOf(err) });
      }
    }
    try { await this.options.logger.flush?.(); } catch { /* swallow */ }
  } finally {
    if (this.closeDatabaseOnStoreClose) {
      try { this.db.close(); } catch { /* swallow */ }
    }
    this.closed = true;
  }
}
```

**Alternative:** Re-throw the first disposal error after marking the store as closed and closing the DB handle. **Trade-off:** callers see the error but the store is safely closed. This is preferable to the current behavior in all cases.

---

### F4 [P2]: `getPositionRange` scoped to active assertions distorts scorer recency

**Location:** [NamespaceRepository.ts:117-125](src/db/repositories/NamespaceRepository.ts#L117-L125)

**Problem:**
`getPositionRange` queries `MIN(valid_from)` and `MAX(valid_from)` from assertions where `valid_until IS NULL` — only *active* (non-superseded) assertions. This range is passed to scorers via `ScoringContext.namespacePositionRange`.

`LinearScorer.namespaceRecency` normalizes candidate positions to [0, 1] using: `(candidate.position - min) / (max - min)`. If a namespace has heavy supersession activity, the active range may be much narrower than the full position history. Example:

- Full assertion positions: [1, 2, 3, ..., 100] (positions 1–90 superseded, 91–100 active)
- Active range: [91, 100]
- A candidate at position 95 gets recency `(95 - 91) / (100 - 91) = 0.44`
- But it's actually near the "latest" end of the full namespace history

This distortion makes recency scoring unreliable for namespaces with significant supersession, and causes instability when assertions are superseded (the range jumps).

**Impact:** Degraded retrieval ranking quality. The recency signal becomes noisy in proportion to the supersession rate.

**Proposed Resolution:**
Change `getPositionRange` to include all assertions (remove the `valid_until IS NULL` filter):

```sql
SELECT MIN(valid_from) AS min, MAX(valid_from) AS max
FROM trageti_assertions WHERE namespace = ?
```

This gives scorers the full temporal range of the namespace. Active-only filtering happens in Step 1 (temporal filter), which is the appropriate place for it.

**Alternative A:** Expose two ranges: `allPositionRange` and `activePositionRange`, and let scorers choose. **Trade-off:** broader API surface. **Mitigation:** default scorers use the full range; custom scorers can opt into active-only.

**Alternative B:** Use episode position range instead, since episodes are never superseded and positions are monotonically increasing. **Trade-off:** decouples recency from assertion positions, which may be semantically different. **Mitigation:** for most use cases, assertion validFrom tracks episode positions closely.

---

### F5 [P2]: Provider-derived query embedding dimension mismatch surfaces with misleading error

**Location:** [TragetiStore.ts:1000-1011](src/store/TragetiStore.ts#L1000-L1011), [retrieve.ts:276-283](src/pipeline/retrieve.ts#L276-L283)

**Problem:**
In `resolveQueryEmbedding`, when the embedding provider returns a vector, its dimension is not validated against the namespace's configured dimension. The mismatch is only caught later in `retrieveCore` (line 276-283), where the error says:

> `queryEmbedding length X does not match namespace dimension Y`

This implies the *caller* supplied a wrong-sized embedding, when in fact the *provider* returned one. The caller has no `queryEmbedding` in their input — they provided `queryText` and the provider derived the embedding.

**Impact:** Debugging misdirection. The caller investigates their non-existent `queryEmbedding` input instead of the provider configuration.

**Proposed Resolution:**
Add a dimension check immediately after `provider.embed()` in `resolveQueryEmbedding`, with a provider-specific error message:

```typescript
if (vec && dim !== null && vec.length !== dim) {
  throw new EmbeddingProviderError(
    provider.name, 0,
    `query embedding dimension ${vec.length} does not match namespace dimension ${dim}`
  );
}
```

**Alternative:** Enhance the existing `RETRIEVAL_DIMENSION_MISMATCH` error at line 280 to distinguish provider-derived vs. caller-supplied embeddings. **Trade-off:** requires carrying provenance metadata through the query object.

---

### F6 [P2]: `reindexNamespace` indexes all assertions; `getPendingIndexing` reports only active

**Location:** [reindex.ts:119-129](src/pipeline/reindex.ts#L119-L129), [EmbeddingRepository.ts:74-83](src/db/repositories/EmbeddingRepository.ts#L74-L83)

**Problem:**
The reindex pipeline iterates `trageti_assertions WHERE namespace = ?` with no `valid_until` filter — it re-embeds every assertion, including superseded ones. But `getPendingIndexing` only reports assertions where `valid_until IS NULL`. This asymmetry creates two issues:

1. After reindex, `getPendingIndexing` reports nothing pending, even though superseded assertions were just indexed — correct but semantically confusing.
2. After a supersession (validUntil set), the newly-superseded assertion's embedding remains in the vec0 table. A new call to `indexBatch` after `getPendingIndexing` skips it because it's no longer "pending." If the vec0 table is rebuilt by reindex, superseded embeddings are recomputed — wasting provider API calls and storage.

**Impact:** Wasted embedding provider costs (reindex re-embeds closed assertions that will never appear in retrieval results). Inconsistent mental model between "what is indexed" vs. "what is pending."

**Proposed Resolution:**
Filter reindex to active assertions only:
```sql
WHERE namespace = ? AND valid_until IS NULL AND rowid > ? AND rowid <= ?
```

This aligns reindex with `getPendingIndexing` and avoids re-embedding assertions that can never affect retrieval.

**Alternative A:** Keep reindexing all assertions (for time-travel use cases where `includeSuperseded: true` is used with vector search). **Trade-off:** correct for those use cases, but wasteful for the common case. **Mitigation:** add an option `includeSuperseded: boolean` on `ReindexOptions` defaulting to `false`.

**Alternative B:** Document the current behavior explicitly and add a `getIndexedAssertionIds()` utility so callers can reason about the full indexed set. **Trade-off:** doesn't reduce cost, but improves observability.

---

### F7 [P2]: `getMissingIndexing` throws on vectorless namespaces; `getPendingIndexing` degrades gracefully

**Location:** [TragetiStore.ts:1085-1097](src/store/TragetiStore.ts#L1085-L1097) vs. [TragetiStore.ts:866-893](src/store/TragetiStore.ts#L866-L893)

**Problem:**
`getPendingIndexing` on a vectorless namespace logs a debug message and returns `[]`. `getMissingIndexing` on a vectorless namespace calls `ensureVectorReadable`, which throws `RetrievalInputError` with code `RETRIEVAL_NAMESPACE_VECTORLESS`. The error code is retrieval-specific, but `getMissingIndexing` is a utility method unrelated to retrieval.

A caller using both methods to manage indexing state would need inconsistent error-handling strategies for the same condition (vectorless namespace).

**Impact:** DX obstacle — inconsistent behavior for the same condition across related methods. Retrieval-specific error code on a non-retrieval method.

**Proposed Resolution:**
Mirror `getPendingIndexing`'s behavior: return all requested IDs as "missing" (since none can be indexed) or return `[]` (since vectorless namespaces have no indexing concept):

```typescript
async getMissingIndexing(namespace: string, assertionIds: readonly string[]): Promise<...> {
  this.requireNamespaceInit(namespace);
  if (assertionIds.length === 0) return [];
  const config = this.namespaceRepo.get(namespace);
  if (!config || config.embeddingDimension === null) return []; // vectorless: nothing can be indexed
  // ... existing logic
}
```

---

### F8 [P2]: Stale vec0 embeddings for superseded assertions are never cleaned

**Location:** [AssertionRepository.ts:75-79](src/db/repositories/AssertionRepository.ts#L75-L79), [EmbeddingRepository.ts:49-53](src/db/repositories/EmbeddingRepository.ts#L49-L53)

**Problem:**
When `supersedeAssertion()` sets `valid_until` on a predecessor, the predecessor's embedding row in the vec0 table remains. There is no mechanism to delete it. Over time, for namespaces with frequent supersession, the vec0 table grows unboundedly with stale rows that will never appear in retrieval results (Step 1 temporal filter excludes them).

While `reindexNamespace` rebuilds the vec0 table, it also re-embeds superseded assertions (see F6), so it doesn't help with cleanup either.

**Impact:** Monotonically growing vec0 table size. Increased I/O for vector distance calculations (sqlite-vec scans all rows matching the IN clause, including stale ones — though they're filtered by the candidate list). Storage waste proportional to the supersession rate × embedding dimension.

**Proposed Resolution:**
Add a `DELETE` from the vec0 table when closing an assertion via supersession:

```typescript
// In closeSupersededAssertion or supersedeAssertion:
if (table) {
  this.embeddingRepo.delete(table, assertionId);
}
```

Add an `EmbeddingRepository.delete(tableName, assertionId)` method:
```typescript
delete(tableName: string, assertionId: string): void {
  this.db.prepare(`DELETE FROM ${quoteIdent(tableName)} WHERE assertion_id = ?`).run(assertionId);
}
```

**Alternative A:** Add a periodic `vacuumEmbeddings(namespace)` method that deletes embeddings for all superseded assertions. **Trade-off:** less write-path overhead, but requires the caller to invoke it. **Mitigation:** can be called from `reindexNamespace` or a maintenance schedule.

**Alternative B:** Accept the growth and document it. For most use cases, the vec0 table size is bounded by the total assertion count, which grows linearly. **Trade-off:** simpler, but doesn't address the cost of re-embedding superseded assertions during reindex.

---

### F9 [P3]: `deleteNamespace` has redundant link-deletion queries

**Location:** [TragetiStore.ts:1127-1136](src/store/TragetiStore.ts#L1127-L1136)

**Problem:**
Four separate `DELETE` statements target `trageti_links`:
1. `DELETE FROM trageti_links WHERE namespace = ?` — deletes same-namespace links
2. `DELETE FROM trageti_links WHERE from_id IN (SELECT id FROM trageti_assertions WHERE namespace = ?)` — deletes cross-namespace links by from_id
3. `DELETE FROM trageti_links WHERE to_id IN (SELECT id FROM trageti_assertions WHERE namespace = ?)` — deletes cross-namespace links by to_id
4. `DELETE FROM trageti_links WHERE source_episode_id IN (SELECT id FROM trageti_episodes WHERE namespace = ?)` — deletes by source episode

Statement (1) already deletes all links whose `namespace` column matches. Statements (2–4) handle edges where a link in namespace B references an assertion or episode in namespace A (the one being deleted). While this is correct for cross-namespace link cleanup, the semantics are subtle and the four-statement pattern is fragile.

**Impact:** Performance overhead (4 separate subquery scans), maintenance risk (easy to break ordering or miss a case).

**Proposed Resolution:**
Consolidate into two statements — one for same-namespace, one for cross-namespace references:

```sql
-- Same-namespace links
DELETE FROM trageti_links WHERE namespace = ?;
-- Cross-namespace links referencing this namespace's assertions or episodes
DELETE FROM trageti_links
WHERE namespace != ?
  AND (from_id IN (SELECT id FROM trageti_assertions WHERE namespace = ?)
    OR to_id IN (SELECT id FROM trageti_assertions WHERE namespace = ?)
    OR source_episode_id IN (SELECT id FROM trageti_episodes WHERE namespace = ?));
```

Add a comment explaining the cross-namespace case.

---

### F10 [P3]: `getSupersessionChain(s)` has no namespace constraint

**Location:** [AssertionRepository.ts:220-235](src/db/repositories/AssertionRepository.ts#L220-L235), [AssertionRepository.ts:249-263](src/db/repositories/AssertionRepository.ts#L249-L263)

**Problem:**
The recursive CTEs in `getSupersessionChain` and `getSupersessionChains` walk `supersedes_id` backward with no namespace filter. If the database ever contains a cross-namespace supersession link (prevented by write validation but possible via direct DB manipulation or a future validation bug), the chain would silently cross namespace boundaries.

By contrast, `getEntityTrajectory` (line 195) constrains every recursive step to `a.namespace = ? AND a.entity_id = ?`.

**Impact:** Low in practice (write validation prevents the condition), but defense-in-depth is violated. A direct DB insert bypassing the API could create unexpected chain behavior.

**Proposed Resolution:**
Add `AND a.namespace = (SELECT namespace FROM trageti_assertions WHERE id = ?)` to the recursive step, or pass the namespace as a parameter. Since the initial assertion's namespace is known, this is a cheap constant-time check per recursive step.

**Alternative:** Add a database-level `CHECK` constraint or trigger preventing cross-namespace supersession. **Trade-off:** schema change requires a migration. **Mitigation:** can be added as a v003 migration.

---

### F11 [P3]: `json_each` candidate serialization has no size guard

**Location:** [candidates.ts:9](src/db/candidates.ts#L9), [retrieve.ts:308](src/pipeline/retrieve.ts#L308)

**Problem:**
`buildCandidateJson` serializes all candidate IDs into a JSON array string. For large namespaces (100K+ active assertions at a given temporal anchor), this produces a multi-megabyte string that must be:
1. Allocated and serialized in JS
2. Bound as a parameter to SQLite
3. Parsed by `json_each()` inside SQLite for every query that uses it

Step 1 materializes the full temporal candidate set and passes it to Step 2 as JSON. The optimization (`useFtsBoundedTemporalSelection`) only applies to the BM25-only path; the vector path always materializes.

**Impact:** Memory pressure and query latency proportional to the temporal candidate set size. For namespaces with 100K+ active assertions, this can dominate retrieval wall time.

**Proposed Resolution:**
For the vector path, avoid materializing the full candidate set in JS. Instead, use a subquery directly in the vec0 query:

```sql
SELECT ae.assertion_id, vec_distance_cosine(ae.embedding, ?) AS semantic_distance
FROM <vec0_table> ae
WHERE ae.assertion_id IN (
  SELECT a.id FROM trageti_assertions a
  WHERE a.namespace = ? AND a.valid_from <= ?
    AND (a.valid_until IS NULL OR a.valid_until > ?)
)
ORDER BY semantic_distance ASC
LIMIT ?
```

This pushes the temporal filter into the vec0 query, avoiding the JS-side JSON serialization entirely.

**Alternative A:** Use a temporary table for candidate IDs instead of JSON. **Trade-off:** requires temp table creation/cleanup, but performs better for large sets.

**Alternative B:** Cap the JSON candidate set at a reasonable maximum (e.g., 10K) with a warning. **Trade-off:** may miss relevant assertions beyond the cap. **Mitigation:** the cap would be a soft limit with a documented `RetrievalWarning`.

---

### F12 [P3]: `isSqliteVecLoaded()` caches result permanently

**Location:** [TragetiStore.ts:1832-1841](src/store/TragetiStore.ts#L1832-L1841)

**Problem:**
The result of the `vec_version()` probe is cached in `this.sqliteVecLoaded` after the first call. If the extension is loaded dynamically after store creation (e.g., a manual `db.loadExtension()` call), the cached `false` is never cleared. All subsequent vector operations will fail with `MissingPeerDependencyError` even though the extension is available.

**Impact:** Low — dynamic extension loading after store creation is an edge case. But the caching behavior is not documented, and the error message directs the user to install the extension when it may already be loaded.

**Proposed Resolution:**
Add a `clearVecCache()` method or check lazily when the cached value is `false`:

```typescript
private isSqliteVecLoaded(): boolean {
  if (this.sqliteVecLoaded === true) return true;
  // Re-probe on each call when previously false, in case the extension was loaded dynamically
  try {
    this.db.prepare('SELECT vec_version() AS v').get();
    this.sqliteVecLoaded = true;
  } catch {
    this.sqliteVecLoaded = false;
  }
  return this.sqliteVecLoaded;
}
```

**Alternative:** Document that sqlite-vec must be loaded before `TragetiStore.create()` / `init()` and remove the cache entirely (probe every time). **Trade-off:** adds a SQL call to every vector-touching path. **Mitigation:** the probe is very cheap (no I/O).

---

### F13 [Sec]: Schema extension `createSQL` executes arbitrary SQL without content validation

**Location:** [extensions.ts:74](src/db/schema/extensions.ts#L74)

**Problem:**
`SchemaExtensionApplier.apply` executes `db.exec(tbl.createSQL)` directly. The only validation is that the table name doesn't start with `trageti_`. A `createSQL` value could contain:
- `DROP TABLE` statements for library tables
- `INSERT`/`UPDATE`/`DELETE` on library data
- Multiple statements (SQLite's `exec` runs all statements in the string)
- Pragmas that disable safety checks

While the caller is the application developer (trusted), this is a supply-chain risk: if extension configs are loaded from user-provided config files, external plugins, or dependencies, the SQL is executed with full database access.

**Impact:** In the current single-developer-app model, low. In a plugin or config-from-file model, this is a code execution vulnerability.

**Proposed Resolution:**
Add a `CREATE TABLE` / `CREATE INDEX` whitelist parser or a simpler check that the SQL only contains DDL:

```typescript
// Rough safety check — reject DML and dangerous DDL
const normalized = createSQL.trim().toUpperCase();
if (!normalized.startsWith('CREATE ')) {
  throw new SchemaExtensionError([`createSQL must be a CREATE statement, got: ${normalized.slice(0, 50)}...`]);
}
if (/\b(DROP|DELETE|INSERT|UPDATE|ALTER|ATTACH|DETACH|PRAGMA)\b/i.test(createSQL)) {
  throw new SchemaExtensionError([`createSQL contains forbidden DDL/DML keywords`]);
}
```

**Alternative A:** Require extension tables to be created by the caller before `init()`, and only validate their existence. **Trade-off:** shifts DDL responsibility to the caller, simplifying the trust boundary. The library only reads from extension tables, never creates them.

**Alternative B:** Run `createSQL` inside a `SAVEPOINT` and validate post-conditions (only new tables created, library tables untouched). **Trade-off:** complex, may not catch all side effects.

---

### F14 [Sec]: DDL string interpolation for tokenizer args and vec0 dimension

**Location:** [v001_baseline.ts:115-122](src/db/migrations/v001_baseline.ts#L115-L122), [EmbeddingRepository.ts:22-23](src/db/repositories/EmbeddingRepository.ts#L22-L23), [TragetiStore.ts:1285](src/store/TragetiStore.ts#L1285)

**Problem:**
Three values are interpolated into DDL strings rather than passed as parameters:
1. **FTS5 tokenizer config:** `tokenize='${tokenizeArg}'` — validated by `validateTokenizer()` against `SAFE_TOKENIZER_NAME` and `SAFE_ARG` regexes.
2. **Vec0 dimension:** `embedding FLOAT[${dimension}]` — validated by `assertValidDimension()` as a positive integer.
3. **Tokenizer in `rebuildFts`/`applyFtsTokenizer`:** same as (1).

All three are currently safe because the validation is thorough and happens before interpolation. However, this pattern violates defense-in-depth: if a future refactor separates the validation from the interpolation call site, or if the validation is weakened, the DDL becomes vulnerable.

**Impact:** Currently none. Future risk is moderate — the gap between validation and use creates a "time-of-check time-of-use" window in the code structure (not runtime).

**Proposed Resolution:**
Add assertions immediately before interpolation:

```typescript
// In EmbeddingRepository.ensureVec0Table:
if (!Number.isInteger(dimension) || dimension <= 0) {
  throw new Error(`INTERNAL: invalid dimension ${dimension} reached DDL generation`);
}
```

```typescript
// Before tokenize interpolation:
if (!SAFE_TOKENIZER_NAME.test(tokenizer)) {
  throw new Error(`INTERNAL: invalid tokenizer "${tokenizer}" reached DDL generation`);
}
```

These are invariant-guarding assertions (like `INTERNAL_INVARIANT` errors elsewhere) that catch bugs in the validation pipeline without relying on the validation having already run.

---

## Additional Observations (Non-Finding)

### Duplicate validation in store.reindexNamespace and pipeline/reindex.ts

`TragetiStore.reindexNamespace` (lines 1148-1162) validates `batchSize`, `strategy`, and `mode` before calling `doReindex` from `pipeline/reindex.ts`, which validates the same options again (lines 44-60). This is harmless but wasteful. Consider removing the duplicate validation from one location (preferably the pipeline, since the store is the public entry point).

### Retrieval `explain()` accurately mirrors Step 0 logic

The `explain()` method (lines 1352-1425) correctly models the `resolveQueryEmbedding` decision tree without executing it. This is well-implemented and provides genuine value for debugging retrieval behavior.

### Error code sanitization is thorough

`errorCodeOf()` (line 319-327) strips non-alphanumeric characters and caps length at 64. This correctly prevents injection through error codes in log messages and skip entries. The consistent use of stable error codes rather than raw error messages throughout the skip/warning surfaces is a strong security practice.

---

## Suggested Prioritization

1. **F1 + F3 (close lifecycle):** Fix together — both relate to the close() contract. High impact, low effort.
2. **F2 (duplicate ID errors):** Straightforward to add pre-insert checks. High DX impact.
3. **F4 (position range):** Simple query change with significant scoring quality improvement.
4. **F5 (dimension mismatch error):** Small change, proportionate DX benefit.
5. **F6 + F8 (embedding lifecycle):** Address together — reindex scope and stale embedding cleanup are related.
6. **F7 (getMissingIndexing):** Quick consistency fix.
7. **F9–F12 (P3 items):** Address opportunistically.
8. **F13–F14 (security):** Add guard assertions for defense-in-depth.
