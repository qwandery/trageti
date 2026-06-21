# Trageti v0.4-alpha.0 — Cross-Verified Code Review

**Reviewers:** Claude Code (Opus 4.6) primary review, Codex cross-review  
**Date:** 2026-06-21  
**Scope:** API surface, write/retrieval mechanics, data integrity, security, DX  
**Branch:** `develop-v0.4.0-alpha.0` at `e8908df`  
**Verdict:** REQUEST CHANGES  
**Confidence:** HIGH

---

## Methodology

Claude Code performed a full source-level review of every TypeScript file in `src/`.
Codex performed an independent static API/mechanics review. This document
cross-verifies every finding from both reviews against the source code, merges
them into a unified assessment, and marks each finding's verification status.

---

## Summary Table

| # | Priority | Finding | Source | Verified |
|---|----------|---------|--------|----------|
| 1 | P1 | Middleware desynchronizes query text and query embedding | Codex | YES |
| 2 | P1 | `writeEpisodeBundle()` bypasses configured assertion validators | Codex | YES |
| 3 | P1 | Supersession close updates are unconditional; duplicate `supersedesId` in bundle corrupts chains | Codex | YES |
| 4 | P1 | Staging-swap reindex loses embeddings written during the reindex window | Codex | YES |
| 5 | P1 | `getMissingIndexing` can return assertion content from another namespace | Codex | YES |
| 6 | P1 | SQL injection via `trustedCustomTokenizer` FTS5 DDL interpolation | Claude Code | YES |
| 7 | P2 | Vector-ready routing gap: provider called and embedding silently discarded when vec0 table absent | Codex + Claude Code | YES |
| 8 | P2 | `assembleContext` `coverage.positionRange` computed from full retrieval set, not rendered subset | Claude Code | YES |
| 9 | P2 | N+1 query pattern in `getConnected` graph traversal | Claude Code | YES |
| 10 | P2 | Neither default scorer uses temporal anchor for scoring — temporally blind ranking | Claude Code | YES |
| 11 | P2 | `LinearScorer.score()` vs `scoreBatch()` use different BM25 normalization | Claude Code | YES |
| 12 | P2 | Unbounded recursion in supersession chain CTEs | Claude Code | YES |
| 13 | P2 | `setDefaultLogger` is a global side effect — multi-store corruption | Claude Code | YES |
| 14 | P2 | `getTemporalSnapshot` filters `entityTypes`/`assertionTypes` in JS after full fetch | Claude Code | YES |
| 15 | P2 | `assembleContext` doesn't propagate `entityTypes`, `assertionTypes`, `minConfidence`, `temporalWindow` to retrieval | Claude Code | YES |
| 16 | P3 | Pragma key/value injection in `prepareDatabase` | Claude Code | YES |
| 17 | P3 | `writeEpisodeBundle` silently allows cross-namespace link targets (no warning unlike `writeLink`) | Claude Code | YES |
| 18 | P3 | `embeddingTableCache` maintained but never read — dead code | Claude Code | YES |
| 19 | P3 | `isSqliteVecLoaded()` executes SQL query on every call, not cached | Claude Code | YES |
| 20 | P3 | `deleteNamespace` link query uses four OR'd correlated subqueries | Claude Code | YES |

---

## P1 — Critical / Must Fix

### 1. Middleware Desynchronizes Query Text and Query Embedding

**Source:** Codex &bull; **Verified:** YES

**Location:** [TragetiStore.ts:909](src/store/TragetiStore.ts#L909), [middleware.ts:20](src/pipeline/middleware.ts#L20), [retrieve.ts:155-157](src/pipeline/retrieve.ts#L155-L157)

**Trace:**
1. `TragetiStore.retrieve()` calls `resolveQueryEmbedding(query)` at line 909 — the embedding is derived from `query.queryText`.
2. The routed query (now carrying `queryEmbedding`) is passed to the pipeline `retrieve()`.
3. Inside the pipeline, `applyMiddleware()` runs `before()` hooks which can modify the query — including `queryText`, `namespace`, or `retrievalStrategy`.
4. `retrieveCore()` runs with the post-middleware query: BM25 uses the **new** `queryText`, but the vector branch uses the **old** `queryEmbedding` derived from the pre-middleware text.

**Impact:** Any query-expansion, synonym-injection, or namespace-routing middleware silently produces incoherent hybrid results — the vector and BM25 branches search for different things.

#### Proposal

**Recommended: Move `before()` hooks into `TragetiStore.retrieve()`, before Step 0.**

In `TragetiStore.retrieve()`, apply global+call middleware `before()` hooks to the raw query *first*, then pass the post-middleware query to `resolveQueryEmbedding()`. The pipeline `retrieve()` function would skip `before()` and only apply `after()` hooks around `retrieveCore()`.

```
retrieve(query):
  q = applyBeforeMiddleware(globalMiddleware, callMiddleware, query)
  { query: routed, skipReason } = resolveQueryEmbedding(q)
  result = pipeline.retrieve(db, ctx, routed)          // only runs after() hooks
  return result
```

**Changes required:**
- `TragetiStore.retrieve()`: run `before()` before `resolveQueryEmbedding()`.
- `applyMiddleware()` in `middleware.ts`: split into `applyBeforeHooks(mw, query)` and `applyAfterHooks(mw, results, query)`, or add a flag to skip `before()` when called from the pipeline.
- `retrieve()` in `retrieve.ts`: only apply `after()` hooks (since `before()` already ran).

**Trade-offs:**
- (+) Clean fix: embedding always matches the text that middleware settled on.
- (+) No middleware API change — `before()` and `after()` signatures stay the same.
- (-) Middleware `before()` now runs in `TragetiStore` (facade layer) rather than the pipeline. If middleware expects access to pipeline-internal state this could matter — but `before()` only receives a `RetrievalQuery`, so there is no coupling today.
- (-) Must keep the `before()` ordering contract (global then call-level) consistent across the split.

**Alternative A: Re-embed after middleware.**

Keep `before()` inside the pipeline. After `applyMiddleware()` runs `before()`, check whether `queryText` changed; if so, call `resolveQueryEmbedding()` again to refresh the embedding.

- (+) No structural change to middleware.ts or retrieve.ts.
- (-) Requires threading the embedding provider + config into the pipeline (currently only `TragetiStore` has access). This widens the pipeline's dependency surface.
- (-) The re-embed is async; the pipeline's `retrieve()` is currently synchronous. Making it async is a larger change.
- (-) Double-embeds when queryText hasn't changed (unless you compare, adding complexity).

**Alternative B: Freeze queryText in middleware contract.**

Document that `before()` hooks must not modify `queryText` or `queryEmbedding` — only metadata fields (`namespace`, `retrievalStrategy`, `limit`, filters). Enforce with a runtime assertion.

- (+) Zero structural change.
- (-) Severely limits middleware utility. Query expansion is the primary use case for `before()` hooks.
- (-) Relies on documentation + runtime checks rather than making the wrong thing impossible.

**Verdict:** The recommended approach is the cleanest. It makes the correct ordering structural rather than relying on re-checks or documentation.

---

### 2. `writeEpisodeBundle()` Bypasses Configured Assertion Validators

**Source:** Codex &bull; **Verified:** YES

**Location:** [TragetiStore.ts:385-389](src/store/TragetiStore.ts#L385-L389) (bundle path), [TragetiStore.ts:452-458](src/store/TragetiStore.ts#L452-L458) (writeAssertion path)

**Evidence:** `writeAssertion()` runs the validator loop at lines 453-458:
```ts
for (const validator of this.options.validators) {
  const result = validator.validate(assertion);
  if (!result.valid) errors.push(...result.errors);
}
```
`writeEpisodeBundle()` calls `enforceStructuralInvariants()` and `enforceCitationExcerptPolicy()` but **never** invokes `this.options.validators`. Searched the bundle method exhaustively — no validator call exists.

**Impact:** Any domain constraints, content policy, assertion-type restrictions, or custom validation rules enforced via the `validators` array are silently bypassed by using the bundle write API. This is a security and data-integrity bypass.

#### Proposal

**Recommended: Run validators in the bundle pre-validation loop.**

In the existing `for (const assertion of assertions)` loop (lines 372-389), add the validator pass after `enforceCitationExcerptPolicy()`:

```ts
// In writeEpisodeBundle(), after line 389:
for (const validator of this.options.validators) {
  const result = validator.validate(assertion);
  if (!result.valid) {
    errors.push(...result.errors.map(e => `assertion "${assertion.id}": ${e}`));
  }
}
```

Key detail: prefix each error with the assertion ID so the caller can identify which assertion in the bundle failed. This parallels how existing bundle errors (lines 374-378) identify the offending assertion.

**Trade-offs:**
- (+) Straightforward: reuses the exact same validator interface.
- (+) Errors are collected into the same `errors[]` array and thrown as a single `ValidationError` at line 413, so one failing assertion doesn't prevent the caller from seeing all validation errors.
- (+) No API change; no new types.
- (-) Validators run once per assertion in the bundle, so a slow custom validator multiplies by bundle size. Acceptable — bundles are typically small (one episode's assertions), and the alternative (no validation) is worse.

**Alternative: Extract a shared `runValidators()` helper.**

Factor the validator loop into a private method `runValidators(assertion: NormalizedNewAssertion): string[]` and call it from both `writeAssertion()` and `writeEpisodeBundle()`. This avoids duplicating the loop but adds a method.

- (+) Single source of truth for validator execution.
- (-) Marginal improvement — the loop is 4 lines and unlikely to diverge.

Either approach is fine; the important thing is that validators run. The recommended inline addition is simpler and lower-risk.

---

### 3. Supersession Close Updates Are Unconditional; Duplicate `supersedesId` in Bundle

**Source:** Codex &bull; **Verified:** YES

**Location:** [AssertionRepository.ts:70-71](src/db/repositories/AssertionRepository.ts#L70-L71), [TragetiStore.ts:418-422](src/store/TragetiStore.ts#L418-L422)

**Evidence:** The repository method is:
```ts
supersedeAssertion(assertionId: string, validUntil: number): void {
  this.db.prepare('UPDATE trageti_assertions SET valid_until = ? WHERE id = ?').run(validUntil, assertionId);
}
```
This unconditionally overwrites `valid_until`. There is no `WHERE valid_until IS NULL` guard and no check for `.changes`.

**Bundle scenario verified:** In `writeEpisodeBundle()`, the pre-validation loop at lines 372-390 reads each predecessor via `enforceStructuralInvariants()`. The predecessor checks (lines 1518-1538) pass if the predecessor is open. But there is **no check for duplicate `supersedesId` values** across assertions in the same bundle. Grepped the entire codebase — no such check exists.

If bundle assertions A1 (`supersedesId: "pred", validFrom: 10`) and A2 (`supersedesId: "pred", validFrom: 20`) both pass pre-validation (predecessor is open at validation time), then in the transaction:
- A1's insert closes pred with `valid_until = 10`
- A2's insert overwrites pred to `valid_until = 20`

Now A1 claims to supersede pred starting at position 10, but pred shows `valid_until = 20` — the supersession chain is semantically broken.

#### Proposal

This is two distinct bugs that both need fixing:

**Part A — Conditional close in `supersedeAssertion()`.**

Change the repository method to guard against double-close:

```ts
supersedeAssertion(assertionId: string, validUntil: number): void {
  const result = this.db
    .prepare('UPDATE trageti_assertions SET valid_until = ? WHERE id = ? AND valid_until IS NULL')
    .run(validUntil, assertionId);
  if (result.changes === 0) {
    throw new TragetiError(
      ErrorCode.INTERNAL_INVARIANT,
      `Cannot supersede assertion "${assertionId}": already closed or does not exist`,
    );
  }
}
```

**Trade-offs:**
- (+) Makes it structurally impossible to silently overwrite a `valid_until`. The bad state cannot exist.
- (+) The existing `enforceStructuralInvariants` check (line 1532) catches *already-closed* predecessors in the validation phase, but this is a belt-and-suspenders guard for the transactional phase where race conditions or bundle ordering could bypass the pre-check.
- (-) The `AND valid_until IS NULL` guard means the existing validation check at line 1532 (`if (pred.validUntil !== null && pred.validUntil !== assertion.validFrom)`) becomes partially redundant. Keep both: the validation gives a descriptive user-facing error; the guard makes the database-level operation safe.
- (-) If a future use case legitimately needs to re-close (e.g., adjusting a close position), this guard would need an explicit override. That seems correct — re-closing should be intentional, not accidental.

**Part B — Reject duplicate `supersedesId` in bundle pre-validation.**

In `writeEpisodeBundle()`'s pre-validation loop, track which predecessors have been claimed:

```ts
const claimedPredecessors = new Set<string>();
for (const assertion of assertions) {
  // ... existing checks ...
  if (assertion.supersedesId !== null) {
    if (claimedPredecessors.has(assertion.supersedesId)) {
      errors.push(
        `assertion "${assertion.id}" supersedesId "${assertion.supersedesId}" ` +
        `is already claimed by another assertion in this bundle`,
      );
    }
    claimedPredecessors.add(assertion.supersedesId);
  }
}
```

**Trade-offs:**
- (+) Catches the problem before the transaction, with a clear user-facing error.
- (+) No performance cost — it's a Set lookup per assertion.
- (-) None. This check has no legitimate reason to be absent.

Both parts should be implemented together. Part A protects against any path (including future ones) that might attempt a double-close. Part B gives the user a clear error message when the input is invalid.

---

### 4. Staging-Swap Reindex Loses Embeddings Written During the Reindex Window

**Source:** Codex &bull; **Verified:** YES

**Location:** [reindex.ts:110-130](src/pipeline/reindex.ts#L110-L130) (rowid snapshot), [reindex.ts:250-255](src/pipeline/reindex.ts#L250-L255) (swap + drop)

**Trace:**
1. Reindex snapshots `MAX(rowid)` at line 113 and iterates rows up to that point.
2. Meanwhile, `indexAssertion()` and `indexBatch()` resolve the table name via `ensureVectorReady()`, which calls `namespaceRepo.getEmbeddingTable()` — this returns the **old** (live) table because the swap hasn't happened yet.
3. New embeddings are inserted into the **old** table.
4. At line 252, reindex atomically repoints `embedding_table` to the staging table.
5. At line 255, `embeddingRepo.dropTable(oldTable)` drops the old table — destroying any embeddings written during the reindex window.

The `reindexLocks` set (line 196) only prevents concurrent reindex calls. `indexAssertion`, `indexBatch`, `writeAssertion` and `writeEpisodeBundle` are not blocked. New assertions written after the rowid snapshot are also absent from the staging table.

**Impact:** In any system doing continuous writes alongside a reindex operation, recently indexed embeddings are silently and permanently lost.

#### Proposal

**Recommended: Catch-up pass before swap.**

After the main iteration loop completes, perform a "catch-up" pass that copies any embeddings inserted into the *old* table during the reindex window into the *staging* table before the swap:

```ts
// After the main loop, before the swap:
// Catch-up: copy embeddings written to the old table during the reindex window.
// These are assertions with rowid > maxRowid (i.e., written after the snapshot).
if (oldTable && oldTable !== targetTable) {
  const catchupSql = `
    SELECT e.assertion_id, e.embedding
    FROM ${quoteIdent(oldTable)} e
    JOIN trageti_assertions a ON a.id = e.assertion_id
    WHERE a.namespace = ? AND a.rowid > ?
  `;
  const catchupRows = db.prepare(catchupSql).all(namespace, maxRowid);
  for (const row of catchupRows) {
    embeddingRepo.insert(targetTable, row.assertion_id, row.embedding);
  }
}
// Then proceed with the swap + drop.
```

**Trade-offs:**
- (+) No locking required. The catch-up is a read from the old table and a write to the staging table — both are safe operations under WAL mode.
- (+) Handles both new assertions written during reindex AND embeddings re-indexed for existing assertions.
- (-) There is a small race window between the catch-up read and the swap+drop: an embedding could be written to the old table *after* the catch-up but *before* the drop. This window is much smaller than the full reindex window (milliseconds vs. seconds/minutes), but it's not zero.
- (-) If the reindex changed dimensions (`newDimension`), the catch-up would copy old-dimension vectors. Must skip catch-up when `newDimension !== oldDimension` — those assertions need re-embedding with the new provider anyway.

**Alternative A: Namespace-level indexing lock.**

Add a `reindexIndexingLocks` set (or extend `reindexLocks`). When a reindex is active for namespace N, `indexAssertion()` and `indexBatch()` for namespace N either:
- (a) Block until reindex completes (requires async coordination since better-sqlite3 is sync), or
- (b) Write to a deferred queue that the reindex catch-up drains, or
- (c) Throw/skip with a warning.

```ts
// In indexAssertion() / indexBatch():
if (this.reindexLocks.has(namespace)) {
  this.options.logger.warn('TRGT_INDEX_DURING_REINDEX', { namespace });
  return; // skip — reindex will re-embed all active assertions anyway
}
```

**Trade-offs:**
- (+) Eliminates the race entirely — no concurrent writes to the old table.
- (+) Simple to implement if "skip" is acceptable.
- (-) "Skip" means embeddings for assertions written during reindex are deferred until the reindex processes them (they'll be in the staging table if their rowid ≤ maxRowid, or missing if rowid > maxRowid). This requires the catch-up pass anyway to be complete.
- (-) "Block" is architecturally difficult with synchronous better-sqlite3.
- (-) "Queue" adds significant complexity.

**Alternative B: Transfer from old to staging before drop.**

Instead of dropping the old table immediately after the swap, transfer all rows from the old table that don't exist in the staging table:

```ts
// After swap, before drop:
const transferSql = `
  INSERT OR IGNORE INTO ${quoteIdent(targetTable)} (assertion_id, embedding)
  SELECT assertion_id, embedding FROM ${quoteIdent(oldTable)}
  WHERE assertion_id NOT IN (SELECT assertion_id FROM ${quoteIdent(targetTable)})
`;
db.exec(transferSql);
embeddingRepo.dropTable(oldTable);
```

**Trade-offs:**
- (+) Catches everything — any embedding in the old table that's missing from staging is transferred.
- (+) No timing races since it runs after the swap, within the same synchronous flow.
- (-) Transfers ALL missing embeddings, including those intentionally excluded by the reindex (e.g., if `newDimension` changed, old-dimension vectors would be transferred — wrong dimension). This makes it unsuitable for dimension-change reindex.
- (-) `INSERT OR IGNORE` into a vec0 table may have sqlite-vec compatibility concerns.

**Verdict:** The catch-up pass (recommended) is the best balance. Combine it with Alternative A's "skip" behavior for `indexAssertion`/`indexBatch` to shrink the race window further: during an active reindex, concurrent index operations skip (they'll be caught up), and the catch-up pass handles stragglers. Document that a tiny race window remains and can be closed by running `indexBatch` for pending assertions after reindex completes.

---

### 5. `getMissingIndexing` Cross-Namespace Data Leak

**Source:** Codex &bull; **Verified:** YES

**Location:** [TragetiStore.ts:1078-1090](src/store/TragetiStore.ts#L1078-L1090), [EmbeddingRepository.ts:111-119](src/db/repositories/EmbeddingRepository.ts#L111-L119)

**Trace:**
1. `getMissingIndexingByIds()` checks input IDs against the specified namespace's vec0 table — no namespace filter on the assertion side.
2. An ID from namespace B that happens to be absent from namespace A's vec0 table is returned as "missing."
3. `assertionRepo.getByIds()` fetches by ID globally (no namespace filter).
4. The content of an assertion from namespace B is returned to the caller who asked about namespace A.

**Verified:** `getMissingIndexingByIds` SQL is:
```sql
SELECT value AS id FROM json_each(?)
LEFT JOIN "embedding_table" e ON value = e.assertion_id
WHERE e.assertion_id IS NULL
```
No `JOIN trageti_assertions` or `WHERE namespace = ?` clause.

**Impact:** Namespace boundary violation — callers can extract assertion content from namespaces they should not have access to. In multi-tenant scenarios this is a data leak.

#### Proposal

**Recommended: Filter after hydration (minimal change, no SQL change).**

In `TragetiStore.getMissingIndexing()` (line 1085), filter the hydrated assertions by namespace:

```ts
const assertionsById = new Map(
  this.assertionRepo.getByIds(missingIds)
    .filter(a => a.namespace === namespace)  // ← namespace guard
    .map((assertion) => [assertion.id, assertion])
);
```

**Trade-offs:**
- (+) One-line fix. No SQL change, no repository signature change.
- (+) Guards the public boundary — no cross-namespace content is ever returned.
- (-) The `getMissingIndexingByIds` SQL still returns IDs from other namespaces as "missing." This is semantically wrong (they aren't "missing from namespace A" — they don't belong to namespace A). The returned `missingIds` list is slightly inflated, but since we filter after hydration, no content leaks.

**Alternative: Fix the SQL to join on `trageti_assertions`.**

Change `EmbeddingRepository.getMissingIndexingByIds()` to include a namespace filter:

```ts
getMissingIndexingByIds(tableName: string, namespace: string, assertionIds: readonly string[]): string[] {
  const sql = `
    SELECT a.id
    FROM trageti_assertions a
    WHERE a.id IN (SELECT value FROM json_each(?))
      AND a.namespace = ?
      AND a.id NOT IN (SELECT assertion_id FROM ${quoteIdent(tableName)})
  `;
  return this.db.prepare<[string, string], { id: string }>(sql)
    .all(buildCandidateJson(assertionIds), namespace)
    .map(row => row.id);
}
```

**Trade-offs:**
- (+) Semantically correct at the SQL level — only returns IDs that actually belong to the namespace AND are missing from the index.
- (+) Filters at the database, avoiding unnecessary hydration of cross-namespace rows.
- (-) Changes the repository method signature (adds `namespace` parameter). Requires updating all call sites.
- (-) The `JOIN` adds a small amount of SQL complexity, though it's negligible on indexed columns.

**Verdict:** The SQL fix is more correct, but the hydration filter is lower-risk for a P1 hotfix. Both should be considered. For maximum safety, apply both — the hydration filter as a defense-in-depth guard even after the SQL is fixed.

---

### 6. SQL Injection via `trustedCustomTokenizer` FTS5 DDL Interpolation

**Source:** Claude Code &bull; **Verified:** YES

**Location:** [TragetiStore.ts:1280-1287](src/store/TragetiStore.ts#L1280-L1287) (`rebuildFts`), [TragetiStore.ts:1757-1764](src/store/TragetiStore.ts#L1757-L1764) (`applyFtsTokenizer`)

**Evidence:** Both methods build DDL as:
```ts
const tokenizeArg = [tokenizer.tokenizer, ...(tokenizer.tokenizerArgs ?? [])].join(' ');
// ...
this.db.exec(`CREATE VIRTUAL TABLE trageti_fulltext USING fts5(
  ...
  tokenize='${tokenizeArg}'
);`);
```

When `trustedCustomTokenizer: true` is set, `validateTokenizer()` ([tokenizer.ts:33](src/internal/tokenizer.ts#L33)) returns without any validation — no allow-list check, no character-class check on arguments.

A caller passing `{ tokenizer: "unicode61", tokenizerArgs: ["x'); DROP TABLE trageti_assertions; --"], trustedCustomTokenizer: true }` breaks out of the FTS5 DDL string. The `trustedCustomTokenizer` flag's name implies "I'm using a custom tokenizer name" — not "I accept arbitrary SQL injection via tokenizer arguments."

**Impact:** High if tokenizer config comes from any external source (config files, API parameters). Low if only hardcoded.

#### Proposal

**Recommended: Always validate arguments; only skip the name allow-list for trusted tokenizers.**

In `validateTokenizer()` ([tokenizer.ts:30-56](src/internal/tokenizer.ts#L30-L56)), change the early return:

```ts
export function validateTokenizer(config: FTS5TokenizerConfig, context: TokenizerValidationContext): void {
  // Trusted custom tokenizer — skip the tokenizer NAME allow-list (the caller
  // is using a non-built-in tokenizer like a custom C extension). But still
  // validate arguments against the safe character class.
  if (config.trustedCustomTokenizer === true) {
    for (const arg of config.tokenizerArgs ?? []) {
      if (!SAFE_ARG.test(arg)) {
        const reject = (message: string, details: Record<string, unknown>): never => {
          if (context === 'init') throw new SchemaExtensionError([message]);
          throw new MigrationCompatibilityError('fts-tokenizer', message, details);
        };
        reject(
          `FTS5 tokenizer argument "${arg}" contains characters that are not safe to embed in DDL. ` +
          `Only alphanumerics, underscores, equals, and hyphens are allowed.`,
          { tokenizer: config.tokenizer, arg },
        );
      }
    }
    return;
  }
  // ... rest of existing validation ...
}
```

**Trade-offs:**
- (+) Closes the injection vector completely. `SAFE_ARG` (`/^[A-Za-z0-9_=-]+$/`) allows all legitimate FTS5 tokenizer arguments (e.g., `remove_diacritics=1`, `separators=_`).
- (+) Does not break any existing user who passes safe arguments.
- (+) The `trustedCustomTokenizer` flag retains its purpose: "I'm using a custom tokenizer name that isn't on the built-in list."
- (-) Could break a user with a legitimate but unusual tokenizer argument containing spaces or special characters. FTS5 tokenizer arguments are space-separated within the `tokenize=` clause; individual args should not contain spaces. The risk is minimal.

**Alternative: Escape single quotes in the interpolated string.**

Instead of validation, escape the tokenizer string before interpolation:

```ts
const tokenizeArg = [tokenizer.tokenizer, ...(tokenizer.tokenizerArgs ?? [])]
  .map(s => s.replace(/'/g, "''"))
  .join(' ');
```

**Trade-offs:**
- (+) Handles arbitrary input without rejecting anything.
- (-) FTS5's `tokenize=` clause has its own parsing rules. Escaping single quotes may not be sufficient — the tokenizer name and args are space-delimited within the `tokenize='...'` string, so other metacharacters could still cause issues.
- (-) Defense-in-depth is weaker: we're trying to make dangerous input safe rather than rejecting it.

**Verdict:** Validation (recommended) is the stronger approach. FTS5 tokenizer arguments have a well-defined, restrictive format — anything that fails `SAFE_ARG` is either malicious or a bug.

---

## P2 — Significant / Should Fix

### 7. Vector-Ready Routing Gap: Provider Called, Embedding Silently Discarded

**Source:** Codex + Claude Code &bull; **Verified:** YES

**Location:** [TragetiStore.ts:943-1004](src/store/TragetiStore.ts#L943-L1004) (`resolveQueryEmbedding`), [TragetiStore.ts:1642-1661](src/store/TragetiStore.ts#L1642-L1661) (`ensureVectorReadable`)

**Scenario:** Namespace is vector-configured (dimension set), provider exists, sqlite-vec loaded, but the vec0 table has not been lazily created yet (no assertions indexed).

1. `resolveQueryEmbedding` passes all pre-checks (lines 963-986) — namespace not vectorless, provider exists, sqlite-vec loaded — and calls `provider.embed()`. Returns the query with the derived `queryEmbedding`. No skip reason.
2. In `retrieveCore`, `ctx.getEmbeddingTable()` → `ensureVectorReadable()` checks `embeddingRepo.tableExists(table)` → **false** → returns `null`.
3. `vectorCanRun = false`. The embedding is silently discarded. No warning is added to `result.meta.warnings`.
4. `meta.vectorApplied = false` but no explanation of why.

**Impact:** The provider is called (potentially incurring cost and latency), and the result is silently thrown away. Under hybrid strategy, the user gets BM25-only results with no indication that vector was skipped or why.

**Note:** `resolveQueryEmbedding` checks dimension, provider, and sqlite-vec, but does NOT check whether the physical vec0 table exists. The `ensureVectorReadable` function (retrieval path) returns null for a missing table rather than creating it. The `ensureVectorReady` function (indexing path) lazily creates the table. This asymmetry creates the gap.

#### Proposal

**Recommended: Add table-existence check to `resolveQueryEmbedding` and degrade with a skip reason.**

In `resolveQueryEmbedding()`, after the sqlite-vec check (line 981-986), add:

```ts
const table = this.namespaceRepo.getEmbeddingTable(query.namespace);
if (table && !this.embeddingRepo.tableExists(table)) {
  if (strategy === 'vector') {
    throw new RetrievalInputError(
      ErrorCode.RETRIEVAL_NO_INDEXED_ASSERTIONS,
      `Namespace "${query.namespace}" has no indexed assertions; index at least one assertion before using 'vector' strategy`,
    );
  }
  return degrade('NO_INDEXED_ASSERTIONS');
}
```

**Trade-offs:**
- (+) The provider is never called when there's nothing to search against. No wasted cost or latency.
- (+) The skip reason appears in `result.meta.warnings` via the existing `skipReason` plumbing (lines 927-932).
- (+) Consistent with the other degrade paths (NO_PROVIDER, NO_SQLITE_VEC, NAMESPACE_VECTORLESS).
- (-) Adds one `sqlite_master` query per retrieval call when the table doesn't exist. Acceptable — this is a transient state (table is created on first indexing).
- (-) Requires a new `ErrorCode` (`RETRIEVAL_NO_INDEXED_ASSERTIONS`). Follow the existing pattern for adding error codes.

**Alternative: Surface a warning from `ensureVectorReadable` instead of returning `null` silently.**

Keep `resolveQueryEmbedding` as-is but add a warning to `result.meta.warnings` in the pipeline when `ensureVectorReadable` returns null:

```ts
// In retrieveCore(), where vectorCanRun is determined:
if (!embeddingTable) {
  result.meta.warnings.push({
    code: 'TRGT_RETRIEVE_VECTOR_TABLE_MISSING',
    message: `vec0 table for namespace "${query.namespace}" does not exist; vector search skipped`,
  });
}
```

**Trade-offs:**
- (+) No change to `resolveQueryEmbedding` flow.
- (-) The provider is still called unnecessarily — this only fixes the observability, not the waste.

**Verdict:** The recommended approach is better — it prevents the unnecessary provider call entirely and surfaces the reason through the existing warning mechanism.

---

### 8. `assembleContext` `coverage.positionRange` Computed From Wrong Set

**Source:** Claude Code &bull; **Verified:** YES

**Location:** [assemble.ts:51-53](src/pipeline/assemble.ts#L51-L53)

```ts
const positions = assertions.map((a) => a.validFrom);  // ← full retrieval results (up to 100)
const from = positions.length > 0 ? Math.min(...positions) : options.temporalAnchor;
```

`assertions` is `retrieval.results` (up to `DEFAULT_ASSEMBLY_RETRIEVAL_LIMIT = 100`). The formatter truncates this to fit the token budget, producing `renderedAssertions` (which is correctly used for `AssembledContext.assertions`). But `coverage.positionRange` uses the full set.

If 100 assertions spanning positions 1-100 are retrieved but only 5 (positions 80-100) fit the token budget, `positionRange` reports `{from: 1, to: 100}` when the actual formatted context only covers 80-100.

#### Proposal

**Recommended: Use `renderedAssertions` for position range.**

Change line 51:

```ts
const positions = renderedAssertions.map((a) => a.validFrom);
```

No alternatives needed — this is a clear one-line bug fix. The `coverage` object should describe what's *in the assembled context*, which is `renderedAssertions`.

**Trade-off consideration:** If a caller was relying on `positionRange` to know the *available* temporal range (not just the rendered one), this changes behavior. However, `coverage.totalAssertions` already reports the full retrieval count for that purpose, and the field name `positionRange` clearly implies "range of what's included."

---

### 9. N+1 Query Pattern in `getConnected`

**Source:** Claude Code &bull; **Verified:** YES

**Location:** [graph.ts:59](src/pipeline/graph.ts#L59)

```ts
return ids.map((id) => assertionRepo.getById(id)).filter((a): a is Assertion => a !== null);
```

Each `getById` call executes one SQL query for the assertion and one for its citations (via `CitationRepository.getByAssertionId`). For a graph traversal returning N connected assertions, this is 2N queries. `AssertionRepository.getByIds` exists and batches both into 2 total queries.

#### Proposal

**Recommended: Replace with `getByIds`.**

```ts
return assertionRepo.getByIds(ids);
```

No alternatives needed — `getByIds` already exists, handles empty input, batches citation hydration, and returns in arbitrary order (which is acceptable here since graph traversal order is already determined by the CTE's `ORDER BY`).

Note: `getByIds` returns only assertions that exist, so the `.filter` for null is implicit. No behavior change.

---

### 10. Default Scorers Are Temporally Blind

**Source:** Claude Code &bull; **Verified:** YES

**Location:** [RRFScorer.ts:46](src/defaults/scoring/RRFScorer.ts#L46) (`_context` unused), [LinearScorer.ts:24-27](src/defaults/scoring/LinearScorer.ts#L24-L27)

**RRFScorer:** The `_context: ScoringContext` parameter (which carries `temporalAnchor` and `namespacePositionRange`) is entirely ignored. The recency signal ranks candidates by their `position` relative to *each other* only. A candidate at position 100 gets the same recency contribution whether the temporal anchor is 101 or 10,000.

**LinearScorer:** The `recency()` function normalizes position within the namespace range: `(candidate.position - min) / (max - min)`. This measures "how far through the namespace timeline" — not "how close to the query's temporal anchor." A candidate at position 50 in namespace [0, 100] gets recency 0.5 regardless of the temporal anchor.

**Impact:** For a library whose core differentiator is temporal-aware retrieval, neither default scorer uses temporal proximity as a scoring signal. The temporal anchor is used for *filtering* (Step 1) but never for *ranking*. Callers who expect "assertions near my query time rank higher" will get surprising results.

#### Proposal

This is a design decision rather than a clear bug — the current behavior is internally consistent, just potentially surprising. Three approaches:

**Option A (Recommended): Anchor-relative proximity scoring.**

Replace the recency function with one that scores based on distance from the temporal anchor:

```ts
// LinearScorer:
function recency(candidate: ScoredCandidate, context: ScoringContext): number {
  const { min, max } = context.namespacePositionRange;
  if (min === null || max === null || max <= min) return 1;
  const range = max - min;
  const distance = Math.abs(candidate.position - context.temporalAnchor);
  return Math.max(0, 1 - distance / range);
}

// RRFScorer: rank by proximity to anchor instead of raw position
const recencyRanks = this.includeRecency
  ? rankBy(
      candidates,
      (c) => Math.abs(c.position - context.temporalAnchor),
      'asc', // closer to anchor = better = rank 1
    )
  : null;
```

**Trade-offs:**
- (+) "Recency" now means "temporal proximity to the query" — the most intuitive interpretation for a temporal RAG system.
- (+) Uses the `ScoringContext` that's already being passed but ignored.
- (-) **Breaking change** for anyone relying on the current scoring behavior. Candidates that are temporally close to the anchor but far from the "end" of the namespace would score differently.
- (-) May not be the right default for all use cases. Some callers want "most recent overall" (current behavior); others want "closest to my query time" (proposed).

**Option B: Add a `temporalProximity` signal alongside `recency`.**

Keep the existing `recency` as-is (namespace-relative position) and add a new `temporalProximity` weight:

```ts
// LinearScorer weights:
interface LinearScorerWeights {
  semantic: number;
  keyword: number;
  recency: number;          // existing: namespace-relative position
  temporalProximity: number; // new: distance from anchor
}
const DEFAULT_WEIGHTS = {
  semantic: 0.5,
  keyword: 0.25,
  recency: 0.05,
  temporalProximity: 0.2,
};
```

**Trade-offs:**
- (+) Non-breaking — existing weight configs continue to work (new weight defaults to a value, existing weights can be re-tuned).
- (+) Callers can set `temporalProximity: 0` to opt out.
- (-) Adds a fourth dimension to scoring, increasing complexity.
- (-) Default weight rebalancing could still change rankings for existing users.

**Option C: Document current behavior; no code change.**

Document that "recency" means "position in namespace timeline" and that temporal proximity to the anchor is achieved through temporal window filtering (Step 1), not scoring. Add a cookbook example showing how to write a custom scorer with anchor-relative proximity.

**Trade-offs:**
- (+) No code change; no risk.
- (-) The library's value proposition is temporal-aware retrieval. Having no temporal proximity scoring in either default scorer undermines this.

**Verdict:** Option A is the most aligned with the library's purpose, but it's a breaking change that should be gated behind a version bump or a constructor option. Option B is safer for a minor release. Option C is the minimum — at least make the behavior explicit.

---

### 11. `LinearScorer.score()` vs `scoreBatch()` Use Different BM25 Normalization

**Source:** Claude Code &bull; **Verified:** YES

**Location:** [LinearScorer.ts:60-63](src/defaults/scoring/LinearScorer.ts#L60-L63) vs [LinearScorer.ts:87-93](src/defaults/scoring/LinearScorer.ts#L87-L93)

- `score()` (single-item): `keyword = 1 - 1 / (1 + Math.abs(bm25Score))` — a per-item sigmoid transform.
- `scoreBatch()`: cross-candidate min-max normalization: `1 - (x.score - minRaw) / range`.

These produce different scores for the same inputs. The retrieval pipeline uses `scoreBatch()`, but `score()` is public and documented as a "convenience scorer for callers that want to score one candidate directly." A developer using `score()` for manual scoring, testing, or debugging will get results that don't match the pipeline's rankings.

#### Proposal

**Option A (Recommended): Keep both normalizations, document the difference.**

The per-item sigmoid in `score()` is actually the *correct* normalization for a single candidate — you can't do cross-candidate min-max normalization with only one candidate. The issue is that the two methods claim to be the same scorer but produce different values.

Add JSDoc to `score()` clarifying it uses per-item normalization and will not match `scoreBatch()` rankings:

```ts
/**
 * Score a single candidate using per-item sigmoid normalization for BM25.
 * Note: this method uses a different BM25 normalization than scoreBatch()
 * (sigmoid vs. cross-candidate min-max), so scores are not directly
 * comparable to pipeline rankings. Use scoreBatch() for pipeline-consistent
 * ranking.
 */
score(candidate: ScoredCandidate, context: ScoringContext): number { ... }
```

**Trade-offs:**
- (+) No behavioral change.
- (-) The API surface has a "gotcha" that documentation mitigates but doesn't eliminate.

**Option B: Deprecate `score()` in favor of `scoreBatch()` with a single-element array.**

```ts
/** @deprecated Use scoreBatch([candidate], context)[0] for pipeline-consistent scoring. */
score(candidate: ScoredCandidate, context: ScoringContext): number { ... }
```

**Trade-offs:**
- (+) Pushes users toward the method that matches the pipeline.
- (-) `scoreBatch([x], context)` with one element always produces `keyword = 1` (since `minRaw === maxRaw`, `range = 0`, default is 1). This is useless for single-item scoring.

**Option C: Make `score()` call `scoreBatch()` internally.**

```ts
score(candidate: ScoredCandidate, context: ScoringContext): number {
  return this.scoreBatch([candidate], context)[0]!;
}
```

**Trade-offs:**
- (+) Single source of truth.
- (-) As noted above, `scoreBatch` with one element produces degenerate BM25 normalization. The single-item sigmoid is actually more useful for standalone use.

**Verdict:** Option A (document) is the safest. The methods serve genuinely different use cases (standalone evaluation vs. cross-candidate ranking). The real fix is making the documentation honest about the difference.

---

### 12. Unbounded Recursion in Supersession Chain CTEs

**Source:** Claude Code &bull; **Verified:** YES

**Location:** [AssertionRepository.ts:158-192](src/db/repositories/AssertionRepository.ts#L158-L192) (`getEntityTrajectory`), [lines 200-218](src/db/repositories/AssertionRepository.ts#L200-L218) (`getSupersessionChain`), [lines 224-253](src/db/repositories/AssertionRepository.ts#L224-L253) (`getSupersessionChains`)

All three recursive CTEs have no depth guard. The write-time validation (`new.validFrom > predecessor.validFrom`) prevents circular chains under normal usage, but:
- Direct database manipulation can create cycles.
- Corrupt imports or migrations from older schemas could introduce them.
- SQLite's default recursion limit (1000 rows) would eventually stop execution, but the resulting error is an opaque SQLite error, not a library-typed `TragetiError`.

#### Proposal

**Recommended: Add depth guard to each CTE and wrap SQLite errors.**

Add `AND c.depth < ?` (bound to a constant, e.g., `1000`) to the recursive term of each CTE:

For `getSupersessionChain` (line 206):
```sql
WHERE a.supersedes_id IS NOT NULL
  AND c.depth < ?   -- ← add this
```

For `getEntityTrajectory` (line 175):
```sql
WHERE a.supersedes_id IS NOT NULL
  AND a.namespace = ? AND a.entity_id IS NOT NULL AND a.entity_id = ?
  AND c.depth < ?   -- ← add this
```

For `getSupersessionChains` (line 234):
```sql
WHERE a.supersedes_id IS NOT NULL
  AND c.depth < ?   -- ← add this
```

Define a constant:
```ts
const MAX_SUPERSESSION_DEPTH = 1000;
```

Additionally, if the result reaches the depth limit, log a warning:
```ts
if (rows.some(r => r._depth >= MAX_SUPERSESSION_DEPTH - 1)) {
  // Log TRGT_SUPERSESSION_DEPTH_LIMIT_REACHED
}
```

**Trade-offs:**
- (+) The failure mode becomes a controlled, logged warning instead of an opaque SQLite error.
- (+) Prevents runaway queries from consuming unbounded resources.
- (+) `1000` is generous — real supersession chains should be in the tens, not hundreds.
- (-) Adds one more parameter to each query. Negligible cost.

No meaningful alternatives — depth guards on recursive CTEs are standard practice.

---

### 13. `setDefaultLogger` Is a Global Side Effect

**Source:** Claude Code &bull; **Verified:** YES

**Location:** [TragetiStore.ts:231](src/store/TragetiStore.ts#L231)

```ts
setDefaultLogger(this.options.logger);
```

Called in the constructor. Multiple `TragetiStore` instances with different loggers overwrite the process-global default. The `DefaultAssertionValidator` (when constructed directly), `MockEmbeddingProvider`, and `DefaultConnectionVerifier` all call `getDefaultLogger()` — they silently route to whichever store was constructed last.

#### Proposal

**Recommended: Thread the logger explicitly; deprecate `setDefaultLogger`.**

The audit note at [logger.ts:88-101](src/internal/logger.ts#L88-L101) already acknowledges this as a known limitation. The real fix is removing the dependency on the global:

1. `DefaultAssertionValidator` already accepts `{ logger }` in its constructor options. Document that standalone construction should pass a logger.
2. `DefaultConnectionVerifier` already accepts `logger` as a parameter to `verify()`. No change needed.
3. `MockEmbeddingProvider`: change its one-shot `TRGT_MOCK_PROVIDER_NON_PRODUCTION` warning to accept an optional logger parameter, or make it fire lazily on first `embed()` call (where a logger could be threaded via `EmbedOptions`).
4. Remove `setDefaultLogger(this.options.logger)` from the `TragetiStore` constructor.
5. Deprecate `setDefaultLogger` and `getDefaultLogger` with a warning.

**Trade-offs:**
- (+) Eliminates the global state entirely.
- (+) Multi-store scenarios work correctly.
- (-) Standalone construction of `DefaultAssertionValidator` without a logger falls back to `ConsoleLogger` — which is fine, it's the same behavior as the current default.
- (-) `MockEmbeddingProvider` needs a small API change for its warning path.

**Alternative: Make `setDefaultLogger` set-once (first store wins).**

```ts
let defaultLoggerSet = false;
export function setDefaultLogger(logger: Logger): void {
  if (defaultLoggerSet) return;
  defaultLogger = logger;
  defaultLoggerSet = true;
}
```

**Trade-offs:**
- (+) Multi-store doesn't overwrite — the first logger sticks.
- (-) Surprises callers who create a "real" store after a test store — the test store's logger wins.
- (-) Doesn't solve the fundamental problem of global state.

**Verdict:** Thread the logger explicitly. The global was always a shim.

---

### 14. `getTemporalSnapshot` Filters in JS After Full Fetch

**Source:** Claude Code &bull; **Verified:** YES

**Location:** [snapshot.ts:17-24](src/pipeline/snapshot.ts#L17-L24)

```ts
if (options.entityTypes && options.entityTypes.length > 0) {
  const set = new Set(options.entityTypes);
  results = results.filter((a) => a.entityType !== null && set.has(a.entityType));
}
```

The `entityTypes` and `assertionTypes` filters are applied in JavaScript after fetching ALL matching assertions (plus their citations) from the database. `AssertionRepository.query()` only supports singular `entityType` and `type` filters, not arrays. For a namespace with 100k assertions filtered to one entity type, this fetches and hydrates all 100k assertions just to discard most of them.

#### Proposal

**Recommended: Extend `AssertionRepository.query()` to support array filters.**

Add `entityTypes?: string[]` and `types?: string[]` (array variants) to `AssertionQueryOptions`:

```ts
// In query():
if (options.entityTypes && options.entityTypes.length > 0) {
  const placeholders = options.entityTypes.map(() => '?').join(',');
  conditions.push(`entity_type IN (${placeholders})`);
  params.push(...options.entityTypes);
} else if (options.entityType !== undefined) {
  conditions.push('entity_type = ?');
  params.push(options.entityType);
}

// Same pattern for types / assertionTypes
```

Then update `getTemporalSnapshot` to pass arrays down:

```ts
let results = assertionRepo.query(options.namespace, {
  validAt: options.atPosition,
  ...(options.includeSuperseded !== undefined && { includeSuperseded: options.includeSuperseded }),
  ...(options.entityTypes && { entityTypes: options.entityTypes }),
  ...(options.assertionTypes && { types: options.assertionTypes }),
});
// No JS filtering needed
```

**Trade-offs:**
- (+) Filtering happens at the database level — dramatically better for large namespaces.
- (+) `entity_type` and `type` columns are indexed (via the baseline migration), so `IN (...)` is efficient.
- (+) Backward compatible — the existing singular `entityType` and `type` options still work.
- (-) Slightly more complex `query()` method with two paths per filter. Acceptable.

**Alternative: Use `json_each` for array matching.**

```sql
AND entity_type IN (SELECT value FROM json_each(?))
```

**Trade-offs:**
- (+) Single parameter regardless of array size.
- (-) `json_each` may not use the index as effectively as `IN (...)` for small arrays. For the typical case (1-5 entity types), `IN (...)` with direct parameters is simpler and more plan-friendly.

**Verdict:** Direct `IN (...)` with spread parameters is the better choice for the typical array sizes here.

---

### 15. `assembleContext` Doesn't Propagate Key Retrieval Filters

**Source:** Claude Code &bull; **Verified:** YES

**Location:** [assemble.ts:21-37](src/pipeline/assemble.ts#L21-L37)

`ContextAssemblyOptions` doesn't include `entityTypes`, `assertionTypes`, `minConfidence`, `includeSuperseded`, or `temporalWindow`. These are all standard `RetrievalQuery` fields. The only workaround is a `before` middleware, which is non-obvious.

Since `assembleContext` is the primary high-level API for LLM integration, this forces users to either drop to `retrieve()` + manual formatting, or use middleware, for common filtering patterns.

#### Proposal

**Recommended: Add the missing fields to `ContextAssemblyOptions` and propagate them.**

In `domain/types.ts`, extend `ContextAssemblyOptions`:

```ts
export interface ContextAssemblyOptions {
  // ... existing fields ...
  entityTypes?: string[];
  assertionTypes?: string[];
  minConfidence?: number;
  includeSuperseded?: boolean;
  temporalWindow?: { from?: number; to?: number };
}
```

In `assemble.ts`, propagate them to the retrieval query:

```ts
const query: RetrievalQuery = {
  namespace: options.namespace,
  temporalAnchor: options.temporalAnchor,
  limit: DEFAULT_ASSEMBLY_RETRIEVAL_LIMIT,
};
// ... existing propagations ...
if (options.entityTypes !== undefined) query.entityTypes = options.entityTypes;
if (options.assertionTypes !== undefined) query.assertionTypes = options.assertionTypes;
if (options.minConfidence !== undefined) query.minConfidence = options.minConfidence;
if (options.includeSuperseded !== undefined) query.includeSuperseded = options.includeSuperseded;
if (options.temporalWindow !== undefined) query.temporalWindow = options.temporalWindow;
```

**Trade-offs:**
- (+) The high-level API gains the same filtering power as the retrieval API.
- (+) Purely additive — all new fields are optional.
- (+) No middleware workaround needed for common filtering patterns.
- (-) `ContextAssemblyOptions` grows. This is acceptable — it's a "gather all the relevant knobs" options type.

No meaningful alternatives. The middleware workaround is a leaky abstraction, not a real alternative.

---

## P3 — Low Priority / Should Track

### 16. Pragma Key/Value Injection in `prepareDatabase`

**Source:** Claude Code &bull; **Verified:** YES

**Location:** [prepareDatabase.ts:20-22](src/defaults/connection/prepareDatabase.ts#L20-L22)

Pragma keys and values from `options.pragmas` are interpolated into `db.pragma()` without sanitization. This is developer-facing config (not user input), so it is a defense-in-depth concern. A simple allow-list or key-format check would close the gap.

#### Proposal

**Recommended: Validate pragma keys against a safe character class.**

```ts
const SAFE_PRAGMA_KEY = /^[a-z_]+$/;

for (const [key, value] of Object.entries(options.pragmas ?? {})) {
  if (!SAFE_PRAGMA_KEY.test(key)) {
    throw new Error(`Invalid pragma key: "${key}". Keys must be lowercase alphanumeric with underscores.`);
  }
  db.pragma(`${key} = ${String(value)}`);
}
```

**Trade-offs:**
- (+) Closes the defense-in-depth gap.
- (+) All legitimate SQLite pragma names match `[a-z_]+`.
- (-) Pragma values can still be arbitrary strings. Full value sanitization is harder since pragma values can be strings, numbers, or identifiers depending on the pragma. However, `better-sqlite3`'s `db.pragma()` handles the SQL execution, limiting the blast radius.

**Alternative:** Accept only known pragma names from a curated allow-list (e.g., `cache_size`, `mmap_size`, `synchronous`). This is more restrictive but prevents any unknown pragma from being set.

---

### 17. `writeEpisodeBundle` Cross-Namespace Link Targets: No Warning

**Source:** Claude Code &bull; **Verified:** YES

**Location:** [TragetiStore.ts:403-409](src/store/TragetiStore.ts#L403-L409) vs [TragetiStore.ts:560-571](src/store/TragetiStore.ts#L560-L571)

The standalone `writeLink()` emits `TRGT_CROSS_NAMESPACE_LINK` when `fromId` and `toId` are in different namespaces. The bundle path checks that link endpoints exist but performs no namespace check and emits no warning for cross-namespace links.

#### Proposal

**Recommended: Add the same namespace check to the bundle link validation loop.**

In the bundle link validation loop (lines 393-411), after verifying that endpoints exist, check their namespaces:

```ts
for (const [endpoint, label] of [
  [link.fromId, 'fromId'],
  [link.toId, 'toId'],
] as const) {
  if (!assertionIds.has(endpoint)) {
    const existing = this.assertionRepo.getById(endpoint);
    if (!existing) {
      errors.push(`link.${label} "${endpoint}" does not reference an existing or bundled assertion`);
    } else if (existing.namespace !== input.episode.namespace) {
      this.options.logger.warn('TRGT_CROSS_NAMESPACE_LINK', {
        linkId: link.id,
        [label]: endpoint,
        linkNamespace: link.namespace,
        targetNamespace: existing.namespace,
      });
    }
  }
}
```

**Trade-offs:**
- (+) Parity with `writeLink()`.
- (+) No behavior change — it's a warning, not an error.
- (-) The `getById` call is already happening (line 407) — this adds a namespace check on the result, not a new query.

---

### 18. `embeddingTableCache` Maintained But Never Read

**Source:** Claude Code &bull; **Verified:** YES

**Location:** [TragetiStore.ts:185](src/store/TragetiStore.ts#L185)

The cache is `.set()` in five locations and `.delete()` in one, but `.get()` is never called anywhere in the codebase (confirmed via grep). Every method that needs the embedding table name calls `namespaceRepo.getEmbeddingTable()` — a database roundtrip. The cache is dead code that adds maintenance burden and misleads readers into thinking table lookups are cached.

#### Proposal

**Option A: Wire the cache into the read path.**

The cache was clearly intended to avoid repeated `namespaceRepo.getEmbeddingTable()` calls. Complete the implementation by reading from the cache before falling through to the DB:

```ts
private getEmbeddingTableCached(namespace: string): string | null {
  const cached = this.embeddingTableCache.get(namespace);
  if (cached !== undefined) return cached;
  const table = this.namespaceRepo.getEmbeddingTable(namespace);
  if (table) this.embeddingTableCache.set(namespace, table);
  return table;
}
```

Then replace `this.namespaceRepo.getEmbeddingTable(namespace)` calls with `this.getEmbeddingTableCached(namespace)` in `ensureVectorReady`, `ensureVectorReadable`, and other callers.

**Trade-offs:**
- (+) Realizes the original design intent. Eliminates redundant DB reads during hot retrieval paths.
- (-) Must ensure cache invalidation is correct. Currently `.delete()` is called in `deleteNamespace` and `.set()` is called after reindex swap — these cover the mutation paths.

**Option B (Recommended): Remove the cache entirely.**

Delete `embeddingTableCache`, all `.set()` calls, and the `.delete()` call. The DB roundtrip via `namespaceRepo.getEmbeddingTable()` is cheap (single-row lookup by primary key) and always correct.

**Trade-offs:**
- (+) Eliminates dead code and potential cache-staleness bugs.
- (+) Simpler codebase.
- (-) Slightly more DB roundtrips on hot paths. Negligible for better-sqlite3 (synchronous, in-process, cached by SQLite's page cache).

**Verdict:** Option B (remove) is safer unless profiling shows the DB lookup is a bottleneck. Dead caches that nobody reads are a liability.

---

### 19. `isSqliteVecLoaded()` Not Cached

**Source:** Claude Code &bull; **Verified:** YES

**Location:** [TragetiStore.ts:1704-1711](src/store/TragetiStore.ts#L1704-L1711)

Executes `SELECT vec_version()` inside a try/catch on every call. Called from `ensureVectorReady`, `ensureVectorReadable`, `getStats`, `explain`, `resolveQueryEmbedding`, and `getPendingIndexing`. The result is deterministic for the database connection's lifetime. Should be computed once at `init()` and cached.

#### Proposal

**Recommended: Cache the result as a private field, computed once.**

```ts
private sqliteVecLoaded: boolean | null = null;

private isSqliteVecLoaded(): boolean {
  if (this.sqliteVecLoaded !== null) return this.sqliteVecLoaded;
  try {
    this.db.prepare('SELECT vec_version() AS v').get();
    this.sqliteVecLoaded = true;
  } catch {
    this.sqliteVecLoaded = false;
  }
  return this.sqliteVecLoaded;
}
```

**Trade-offs:**
- (+) Eliminates repeated `SELECT vec_version()` calls. On a hot retrieval path, this removes one SQL roundtrip per `retrieve()` call.
- (+) Correct — sqlite-vec cannot be loaded or unloaded after `prepareDatabase()` runs.
- (-) If someone externally loads sqlite-vec after store construction (unlikely but technically possible), the cached value would be stale. This is not a realistic concern — `prepareDatabase()` loads it at construction time.

No alternatives needed — this is a straightforward memoization.

---

### 20. `deleteNamespace` Expensive Link Deletion Query

**Source:** Claude Code &bull; **Verified:** YES

**Location:** [TragetiStore.ts:1121-1125](src/store/TragetiStore.ts#L1121-L1125)

```sql
DELETE FROM trageti_links
WHERE namespace = ?
   OR from_id IN (SELECT id FROM trageti_assertions WHERE namespace = ?)
   OR to_id IN (SELECT id FROM trageti_assertions WHERE namespace = ?)
   OR source_episode_id IN (SELECT id FROM trageti_episodes WHERE namespace = ?)
```

The `OR` with three `IN (SELECT ...)` subqueries prevents SQLite from using any single index. The `namespace = ?` clause already catches same-namespace links; the subqueries exist for cross-namespace orphan cleanup but make the common case expensive.

#### Proposal

**Recommended: Split into two DELETE statements.**

```ts
// Step 1: Delete same-namespace links (covers the common case, uses the namespace index)
this.db.prepare('DELETE FROM trageti_links WHERE namespace = ?').run(namespace);

// Step 2: Delete orphaned cross-namespace links (rare case)
this.db.prepare(`
  DELETE FROM trageti_links
  WHERE from_id IN (SELECT id FROM trageti_assertions WHERE namespace = ?)
     OR to_id IN (SELECT id FROM trageti_assertions WHERE namespace = ?)
     OR source_episode_id IN (SELECT id FROM trageti_episodes WHERE namespace = ?)
`).run(namespace, namespace, namespace);
```

**Trade-offs:**
- (+) The common case (step 1) is a simple indexed delete.
- (+) The rare case (step 2) only runs the expensive OR'd subqueries on the remaining rows (after step 1 removed the bulk).
- (-) Two statements instead of one. Both run within the existing transaction, so atomicity is preserved.

**Alternative: Use UNION of subqueries instead of OR.**

```sql
DELETE FROM trageti_links WHERE id IN (
  SELECT id FROM trageti_links WHERE namespace = ?
  UNION
  SELECT l.id FROM trageti_links l
    JOIN trageti_assertions a ON l.from_id = a.id OR l.to_id = a.id
    WHERE a.namespace = ?
  UNION
  SELECT l.id FROM trageti_links l
    JOIN trageti_episodes e ON l.source_episode_id = e.id
    WHERE e.namespace = ?
)
```

**Trade-offs:**
- (+) Single statement.
- (-) More complex SQL. The `UNION` approach still requires scanning for cross-namespace links. The two-statement approach is simpler and likely faster due to the reduced working set for step 2.

---

## Codex Findings Cross-Verification Notes

All six Codex findings were verified as correct:

- **P1 Middleware desync:** Confirmed by tracing from `TragetiStore.retrieve()` → `resolveQueryEmbedding()` → `retrieve()` → `applyMiddleware()` → `retrieveCore()`. The embedding is frozen before middleware runs.
- **P1 Bundle validator bypass:** Confirmed by exhaustive search — no `this.options.validators` call exists in `writeEpisodeBundle()`.
- **P1 Supersession guard:** Confirmed — `supersedeAssertion()` is an unconditional UPDATE with no `WHERE valid_until IS NULL`. Confirmed no duplicate-supersedesId check in bundle validation.
- **P1 Reindex isolation:** Confirmed by tracing `indexAssertion()`'s table resolution during an active reindex — it writes to the old table which is later dropped.
- **P1 Cross-namespace leak:** Confirmed — `getMissingIndexingByIds` has no namespace filter, `getByIds` is global.
- **P2 Vector routing gap:** Confirmed — `resolveQueryEmbedding` doesn't check vec0 table existence; `ensureVectorReadable` returns null for missing table; no warning surfaced.

---

## Recommended Fix Priority

**Immediate (P1s) — estimated effort:**
1. Bundle validator bypass (#2) — ~10 lines, low risk
2. Supersession guard (#3) — ~25 lines across two locations, low risk
3. `getMissingIndexing` namespace filter (#5) — ~3 lines, low risk
4. FTS5 DDL injection (#6) — ~15 lines in tokenizer.ts, low risk
5. Middleware ordering (#1) — ~50 lines refactor across TragetiStore/middleware/retrieve, moderate risk
6. Reindex isolation (#4) — ~30 lines + design decision on lock vs. catch-up, moderate risk

**Next (P2s):**
7. `assembleContext` positionRange (#8) — 1 line
8. `getConnected` N+1 (#9) — 1 line
9. Vector routing warning gap (#7) — ~10 lines
10. `assembleContext` filter propagation (#15) — ~15 lines in types + assemble
11. Snapshot SQL filtering (#14) — ~20 lines in AssertionRepository.query()
12. CTE depth guards (#12) — ~10 lines mechanical
13. `LinearScorer.score()` mismatch (#11) — documentation update
14. Global logger (#13) — ~20 lines refactor
15. Scorer temporal awareness (#10) — design decision + implementation

**Track (P3s):**
16–20: Address during routine maintenance, ~5-15 lines each.
