# Code Review: Trageti 0.3.0 Full Review

**Verdict**: REQUEST CHANGES  
**Confidence**: HIGH  
**Review date**: 2026-06-01  
**Scope**: Current `develop-v0.3-demos` branch, including the v0.3 library redesign, retrieval/indexing pipelines, demos, docs, and tests. Migration findings are treated as low priority because there are no known consuming applications on v0.2.x or earlier, and the project may flatten migrations before beta/release.

## Summary

The v0.3 branch is broad and generally well-structured, but this review found release-blocking issues in reindexing, namespace cleanup, validation, and async lifecycle behavior. The most urgent fixes are the vector-index data loss path for invalid `batchSize`, unchecked non-terminating loops, and cross-namespace link cleanup/integrity gaps.

This document consolidates the initial comprehensive review and a second verification pass using the Code Review workflow. I verified findings against the current code and rejected or narrowed items that did not hold after reading the implementation.

## Findings

| Priority | Issue | Location |
|----------|-------|----------|
| P0 | `reindexNamespace({ strategy: 'staging-swap', batchSize: 0 })` can replace a complete vector index with an empty vec0 table and drop the old index. | `src/pipeline/reindex.ts:49` |
| P1 | `indexBatch(..., { onProviderError: 'fail-fast', batchSize: 0 })` can hang forever. | `src/store/TemporalStore.ts:687` |
| P1 | `rebuildFts({ batchSize: 0 })` can enter a non-terminating transaction loop after dropping/recreating FTS. | `src/store/TemporalStore.ts:1116` |
| P1 | Reindex staging table names use only `Date.now()` and are blindly dropped before creation, so same-ms/concurrent runs can collide destructively. | `src/pipeline/reindex.ts:71` |
| P1 | `deleteNamespace()` deletes only links owned by the namespace, leaving permitted cross-namespace link FKs that can block deletion. | `src/store/TemporalStore.ts:1005` |
| P1 | `writeLink()` does not enforce that `sourceEpisodeId` belongs to the link namespace. | `src/store/TemporalStore.ts:487` |
| P1 | `reindexNamespace()` bypasses the vec0 readiness guard, so missing `sqlite-vec` can surface raw SQLite errors instead of the typed peer-dependency path. | `src/pipeline/reindex.ts:73` |
| P1 | Direct `DefaultScorer.score()` inverts raw negative BM25 relevance, ranking weaker keyword matches above stronger ones when `scoreBatch()` is bypassed. | `src/defaults/scoring/DefaultScorer.ts:51` |
| P1 | Async provider-backed operations can resume after `close()` has marked the store closed and closed the owned database. | `src/store/TemporalStore.ts:535`, `src/store/TemporalStore.ts:1278` |
| P2 | Retrieval calls `ensureVectorReady()` through `getEmbeddingTable`, allowing a read path to create vec0 tables. | `src/store/TemporalStore.ts:1454` |
| P2 | `assembleContext()` accepts fractional `tokenBudget` values despite the public positive-integer contract. | `src/pipeline/assemble.ts:23` |
| P2 | `getConnected()` and `findPath()` pass invalid `maxDepth` values directly to the graph adapter; only `retrieve()` validates `maxDepth`. | `src/pipeline/graph.ts:23` |
| P2 | Retrieval accepts non-finite `minConfidence` and temporal-window endpoints because it checks only range/order, not finiteness. | `src/pipeline/retrieve.ts:204`, `src/pipeline/retrieve.ts:214` |
| P2 | Runtime type validation for public assertion/citation fields is incomplete, leading to raw `TypeError`s or database constraint errors instead of typed validation errors. | `src/defaults/validation/DefaultAssertionValidator.ts:56`, `src/store/TemporalStore.ts:1304` |
| P2 | BM25-only retrieval materializes all temporal candidates into JS/JSON before FTS narrows the result set. | `src/pipeline/retrieve.ts:267` |
| P2 | Trajectory retrieval performs one recursive supersession-chain query per result. | `src/pipeline/retrieve.ts:454` |
| P2 | `findPath()` materializes all matching paths before choosing the shortest deterministic result. | `src/defaults/graph/CTEGraphAdapter.ts:194` |
| P2 | Reindex uses `LIMIT/OFFSET` pagination across awaited provider calls, causing superlinear scans and unstable traversal under concurrent writes. | `src/pipeline/reindex.ts:108` |
| P2 | Reindex skip mode embeds one assertion per provider call, defeating the batch-oriented provider contract. | `src/pipeline/reindex.ts:142` |
| P2 | Demo provider errors include raw upstream response bodies in thrown errors. | `demos/shared/providers.ts:485` |
| P2 | Demo embedding providers accept `EmbedOptions` but do not pass abort signals to `fetch()`. | `demos/shared/providers.ts:179`, `demos/shared/providers.ts:223` |
| P2 | Demo terminal sanitizers normalize punctuation but do not strip ANSI/control sequences. | `demos/shared/output.ts:440`, `demos/shared/runtime.ts:232` |
| P2 | Fixture-generation scripts do not carry forward prior assertions when prompting or validating each episode. | `demos/alex-place/generate-fixtures.ts:32`, `demos/know-thyself/generate-fixtures.ts:32` |
| P2 | `explain()` manually duplicates vector-routing checks and can drift from `resolveQueryEmbedding()`. | `src/store/TemporalStore.ts:1228` |
| P2 | FTS rebuild DDL is duplicated between `rebuildFts()` and `applyFtsTokenizer()`. | `src/store/TemporalStore.ts:1123`, `src/store/TemporalStore.ts:1517` |
| P3 | If v005 is retained, it reads persisted tokenizer metadata and interpolates it into FTS5 DDL without validation. | `src/db/migrations/v005_rename.ts:67` |
| P3 | If v005 is retained, it can leave live embedding tables under the legacy `trl_` prefix when `sqlite-vec` is unavailable. | `src/db/migrations/v005_rename.ts:176` |
| P3 | `DefaultScorer.scoreBatch()` uses `bm25NormalisedById` for a map keyed by candidate index, not assertion id. | `src/defaults/scoring/DefaultScorer.ts:75` |
| P3 | Generated planning/review artifacts are committed under `_docs/plans`, making durable project docs harder to trust. | `_docs/plans/review-c-src-qwandery-trageti-docs-specs-peaceful-ember.md:1` |
| P3 | `retrieveCore()` and `indexBatch()` are large multi-phase functions that concentrate validation, routing, persistence, scoring, metrics, and expansion logic. | `src/pipeline/retrieve.ts:126`, `src/store/TemporalStore.ts:558` |

## Details

### [P0] Invalid reindex `batchSize` can silently destroy the live vector index

**File:** `src/pipeline/reindex.ts:49`

`reindexNamespace()` accepts `options.batchSize` without validating it. In staging-swap mode, `batchSize: 0` makes the first SQL query use `LIMIT 0`, so the loop exits immediately with `reindexed = 0`. The function then treats the empty staging table as successful, repoints the namespace to it, and drops the old live table.

This is a concrete data-loss/correctness issue: a caller typo in a public option can erase a complete vector index without any provider call or error.

**Suggested fix:**

```ts
const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
if (!Number.isInteger(batchSize) || batchSize <= 0) {
  throw new ReindexError(
    namespace,
    0,
    `batchSize must be a positive integer, got ${String(batchSize)}`,
  )
}
```

Validate before any staging table DDL. Add a regression test that creates a populated vector index, calls `reindexNamespace(..., { batchSize: 0 })`, and asserts the original index remains intact.

### [P3] Migration v005 interpolates persisted tokenizer metadata into DDL

**File:** `src/db/migrations/v005_rename.ts:67`

v005 reads `tokenizer` and `tokenizer_args` from the legacy database, casts parsed JSON directly to `string[]`, joins it into `tokenize`, and interpolates the result into:

```ts
tokenize='${tokenize}'
```

Unlike normal init/rebuild paths, this migration path does not call `validateTokenizer()`. A tampered or attacker-supplied legacy DB can store tokenizer metadata containing quotes or statement delimiters and trigger SQL injection during automatic migration.

This is not release-blocking for the current project context because there are no known pre-v0.3 consumers and the project may flatten migrations before beta/release. If v005 remains available in a beta or public package, harden it before shipping that migration path.

**Suggested fix:**

```ts
function parseStoredTokenizer(meta: { tokenizer: string; tokenizer_args: string }): FTS5TokenizerConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(meta.tokenizer_args)
  } catch {
    throw new MigrationCompatibilityError(
      'fts-tokenizer',
      'Stored FTS tokenizer args are invalid JSON.',
    )
  }
  if (!Array.isArray(parsed) || !parsed.every((arg): arg is string => typeof arg === 'string')) {
    throw new MigrationCompatibilityError(
      'fts-tokenizer',
      'Stored FTS tokenizer args must be an array of strings.',
    )
  }
  const config = { tokenizer: meta.tokenizer, tokenizerArgs: parsed }
  validateTokenizer(config, 'rebuild')
  return config
}
```

Treat persisted metadata as untrusted at migration boundaries if this migration remains part of the distributable package.

### [P1] `indexBatch()` can hang forever with `batchSize: 0`

**File:** `src/store/TemporalStore.ts:687`

In fail-fast mode:

```ts
const batchSize = options.batchSize ?? 64
for (let off = 0; off < groupItems.length; off += batchSize) {
```

If `batchSize` is zero, `off` never advances. Negative values also produce broken iteration. This is a public API option and should be validated before grouping or provider calls.

**Suggested fix:**

```ts
const batchSize = options.batchSize ?? 64
if (!Number.isInteger(batchSize) || batchSize <= 0) {
  throw new ValidationError([`batchSize must be a positive integer, got ${String(batchSize)}`])
}
```

Use the same helper for `indexBatch()`, `reindexNamespace()`, and `rebuildFts()`.

### [P1] `rebuildFts()` can hang inside a write transaction with invalid `batchSize`

**File:** `src/store/TemporalStore.ts:1116`

`rebuildFts()` validates the tokenizer, drops/recreates `trageti_fulltext`, and then loops with `start += batchSize`. With `batchSize: 0`, this never advances; with negative values, it can also be non-terminating. Because the loop is inside a transaction after FTS DDL, this can hold locks and leave the process wedged.

**Suggested fix:**

```ts
const batchSize = options.batchSize ?? 1000
if (!Number.isInteger(batchSize) || batchSize <= 0) {
  throw new ValidationError([`batchSize must be a positive integer, got ${String(batchSize)}`])
}
```

Validate before any FTS DDL.

### [P1] Reindex staging table names can collide and are blindly dropped

**File:** `src/pipeline/reindex.ts:71`

The staging table name is:

```ts
`${namespaceToEmbeddingTable(namespace)}_staging_${String(Date.now())}`
```

Two reindex operations for the same namespace starting in the same millisecond can compute the same table. The next line blindly drops that table before creating it, so one run can delete another run's staging table. This undermines the staging-swap safety guarantee.

**Suggested fix:**

```ts
const runId = crypto.randomUUID()
targetTable = `${namespaceToEmbeddingTable(namespace)}_staging_${runId}`
embeddingRepo.ensureVec0Table(targetTable, newDimension)
```

Consider a per-namespace reindex lock as well; concurrent rebuilds of the same namespace do not produce useful independent results.

### [P1] `deleteNamespace()` misses inbound cross-namespace references

**File:** `src/store/TemporalStore.ts:1005`

`writeLink()` permits cross-namespace links, but `deleteNamespace()` only deletes:

```ts
DELETE FROM trageti_links WHERE namespace = ?
```

A link stored in namespace `A` can point to an assertion or episode in namespace `B`. Deleting namespace `B` then attempts to delete the referenced assertion/episode while the `A` link still exists, causing a foreign-key failure.

**Suggested fix:**

```ts
this.db.prepare(`
  DELETE FROM trageti_links
  WHERE namespace = ?
     OR from_id IN (SELECT id FROM trageti_assertions WHERE namespace = ?)
     OR to_id IN (SELECT id FROM trageti_assertions WHERE namespace = ?)
     OR source_episode_id IN (SELECT id FROM trageti_episodes WHERE namespace = ?)
`).run(namespace, namespace, namespace, namespace)
```

Add tests for deleting a namespace that is the target of a cross-namespace link and the source episode of a link owned by another namespace.

### [P1] `writeLink()` does not enforce source episode namespace integrity

**File:** `src/store/TemporalStore.ts:487`

`validateLinkInput()` validates that `sourceEpisodeId` is non-empty, but not that it exists in `link.namespace`. The schema FK references only `trageti_episodes(id)`, so the DB cannot enforce this cross-column invariant. The spec says `AssertionLink.sourceEpisodeId` must share the link namespace.

**Suggested fix:**

```ts
const sourceEpisode = this.db
  .prepare<[string, string], { id: string }>(
    'SELECT id FROM trageti_episodes WHERE id = ? AND namespace = ?',
  )
  .get(link.sourceEpisodeId, link.namespace)

if (!sourceEpisode) {
  throw new ValidationError([
    `link.sourceEpisodeId "${link.sourceEpisodeId}" does not reference an episode in namespace "${link.namespace}"`,
  ])
}
```

### [P1] `reindexNamespace()` bypasses the vec0 readiness contract

**File:** `src/pipeline/reindex.ts:73`

The store has a central `ensureVectorReady()` guard that checks vectorless namespaces and `sqlite-vec` availability. `reindexNamespace()` goes directly to:

```ts
embeddingRepo.ensureVec0Table(targetTable, newDimension)
```

If `sqlite-vec` is not loaded, this can surface a raw SQLite `vec0` module error instead of the library's typed `MissingPeerDependencyError` path. This violates the v0.3 public error contract.

**Suggested fix:**

Route reindex through a store-level readiness/provisioning helper before entering `doReindex()`, or pass a validated capability flag into the pipeline and fail before DDL.

### [P1] Direct BM25 scoring is inverted

**File:** `src/defaults/scoring/DefaultScorer.ts:51`

The comments correctly note that FTS5 BM25 scores are negative and more-negative is better. The direct `score()` fallback computes:

```ts
const bm25 = 1 / (1 + Math.abs(candidate.bm25Score))
```

That makes `-1` score above `-10`. `scoreBatch()` handles this correctly by mapping the most negative score to `1`; the direct fallback does not.

**Suggested fix:**

```ts
const bm25 = 1 - 1 / (1 + Math.abs(candidate.bm25Score))
```

Add direct `score()` tests for two candidates where the only difference is BM25 score.

### [P1] `close()` does not coordinate with in-flight async provider work

**File:** `src/store/TemporalStore.ts:535`, `src/store/TemporalStore.ts:1278`

Provider-backed operations await external work and then resume with database writes. `close()` sets `closed = true`, disposes middleware, flushes the logger, and may close the owned database, but in-flight operations are not tracked or cancelled.

Example path:

```ts
const p = store.indexAssertion('a1') // awaits provider.embed()
await store.close()                  // may close db
await p                              // resumes and calls embeddingRepo.insert(...)
```

There is no second `requireNotClosed()` after the provider await and no in-flight operation guard.

**Suggested fix:**

Introduce a store operation wrapper that increments in-flight work, rejects new work once closing starts, and either waits for current work in `close()` or fails it using an abort/cancellation policy. At minimum, re-check closed state after provider awaits and before DB writes.

## P2/P3 Detail Notes

- Retrieval read path DDL: `retrieve()` calls `getEmbeddingTable`, which uses `ensureVectorReady()` and can create a vec0 table. Split read-only readiness from write/provisioning readiness.
- Migration cleanup, if retained: v005 documents best-effort vector table rename, but leaving `embedding_table` pointed at `trl_embeddings_*` after v005 weakens the `trageti_` naming invariant. This is low priority if migrations are flattened before beta.
- Numeric validation: `assembleContext()` should require integer `tokenBudget`; `getConnected()`/`findPath()` should validate `maxDepth`; retrieval should reject `NaN`/infinite `minConfidence` and temporal-window endpoints.
- Runtime type validation: `DefaultAssertionValidator` and structural citation checks call `.trim()` after truthiness checks. Non-string truthy values can throw raw `TypeError`s; numeric fields such as assertion `validFrom` are not consistently checked for finiteness before persistence.
- Performance: BM25-only retrieval should push temporal predicates into the FTS query instead of building all candidate IDs first. Trajectory chains should be batched. `findPath()` should stop at the shortest frontier or use SQL ordering/limit. Reindex should use keyset pagination instead of `OFFSET`.
- Demo hardening: do not include raw upstream response bodies in thrown errors by default; pass abort signals to demo provider fetches; strip ANSI/C0/C1 control sequences before terminal output.
- Demo fixture generation: both fixture scripts should share a helper that accumulates prior assertions per episode, matching runtime ingestion semantics.
- Maintainability: share vector-routing classification between `retrieve()` and `explain()`, centralize FTS rebuild DDL, rename `bm25NormalisedById`, and consider splitting `retrieveCore()`/`indexBatch()` into phase helpers.

## Re-check Results

Confirmed:

- Invalid `batchSize` issues in `reindexNamespace()`, `indexBatch()`, and `rebuildFts()`.
- v005 tokenizer metadata interpolation without validation, but downgraded to P3 because legacy migration compatibility is not important for this project state.
- `deleteNamespace()` cross-namespace FK cleanup gap.
- `writeLink()` source episode namespace gap.
- `reindexNamespace()` bypass of vec0 readiness.
- Direct BM25 fallback inversion.
- Demo raw error body and terminal control-sequence issues.
- Fixture generators using empty prior assertion context.

Narrowed:

- `maxDepth` validation is present in `retrieve()`, but missing from `getConnected()` and `findPath()`.
- Demo runtime ingestion does accumulate prior assertions; the gap is in the standalone fixture-generation scripts.

Rejected:

- The initial concern that custom validators bypass structural assertion invariants is not valid for `writeAssertion()`. `TemporalStore.writeAssertion()` calls `enforceStructuralInvariants()` before user validators, so replacing `options.validators` does not bypass citation presence, citation episode namespace, predecessor namespace/order, or citation excerpt policy.

## Recommendation

Do not cut v0.3.0 until the P0 and P1 findings are fixed and covered by focused regression tests. The minimum release-blocking test set should cover invalid batch sizes, same-ms/concurrent reindex staging names, cross-namespace namespace deletion, link source episode namespace validation, reindex without `sqlite-vec`, direct BM25 monotonicity, and closing a store while provider-backed indexing is in flight.

If legacy migrations remain in the beta/public package, also add a low-priority hardening pass for tampered tokenizer metadata and mixed-prefix vector-table migration behavior. If migrations are flattened, remove the v005-specific findings from the active release checklist.

After that, address P2 validation/performance/demo-hardening issues before expanding the public API further.
