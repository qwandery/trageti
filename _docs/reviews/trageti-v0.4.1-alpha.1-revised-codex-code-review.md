# Trageti v0.4.1-alpha.1 Revised Code Review

Date: 2026-06-29

Scope: revised review of `trageti@0.4.1-alpha.1`, consolidating all valid findings from:

- `_docs/reviews/trageti-v0.4.1-alpha.1-codex-code-review.md`
- `_docs/reviews/trageti-claudeai-v0.4.1-alpha.1-audit.md`

This document intentionally excludes findings that are stale against alpha.1, including the graph-expansion N+1 issue fixed by batched `getByIdsValidAt()` hydration.

External references used for non-obvious security or search-system guidance:

- OWASP SQL Injection Prevention Cheat Sheet: parameterization and allow-list validation for dynamic SQL fragments that cannot be bound. <https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html>
- SQLite `ALTER TABLE ADD COLUMN` grammar and restrictions. <https://www.sqlite.org/lang_altertable.html>
- Vespa phased ranking docs for multi-phase retrieval/ranking and second-phase reranking patterns. <https://docs.vespa.ai/en/phased-ranking.html>
- OpenAI tokenizer tool, illustrating that token counts are tokenizer/model dependent rather than equivalent to character counts. <https://platform.openai.com/tokenizer>

## Findings

| Priority | Finding | Source | Primary locations |
| --- | --- | --- | --- |
| P1 | Hybrid retrieval recall is bounded to vector-selected candidates; BM25 does not contribute independent candidates. | Claude F1 | `src/pipeline/retrieve.ts:329`, `src/pipeline/retrieve.ts:368`, `test/integration/r7-conformance.test.ts:232` |
| P1 / Security | `ColumnExtension.definition` is raw executable DDL despite `createSQL` hardening. | Codex | `src/db/schema/extensions.ts:102`, `src/domain/types.ts:603`, `README.md:450` |
| P2 | Context assembly has a hardcoded 100-result recall ceiling and reports fetched count as coverage total. | Claude F2 | `src/pipeline/assemble.ts:21`, `src/internal/retrieval-defaults.ts:25`, `src/domain/types.ts:382` |
| P2 | Cross-namespace graph traversal is documented as traversable, but recursive traversal remains pinned to the original link namespace. | Codex | `README.md:405`, `src/defaults/graph/CTEGraphAdapter.ts:89`, `src/pipeline/retrieve.ts:503` |
| P2 | `findPath()` returns a successful zero-hop path for nonexistent assertion IDs. | Codex | `src/defaults/graph/CTEGraphAdapter.ts:142`, `src/pipeline/graph.ts:69` |
| P2 | `explain()` does not model `retrieve()` vector-readiness and vector-shape failures for caller-supplied embeddings. | Codex | `src/store/TragetiStore.ts:1394`, `src/store/TragetiStore.ts:1408`, `src/pipeline/retrieve.ts:276` |
| P2 | File-backed database handles opened by `prepareDatabase()` / `TragetiStore.create()` can leak when setup fails. | Codex | `src/defaults/connection/prepareDatabase.ts:30`, `src/store/TragetiStore.ts:212` |
| P2 | `getMissingIndexing()` unnecessarily requires sqlite-vec before checking whether the vec0 table exists. | Codex | `src/store/TragetiStore.ts:1115`, `src/store/TragetiStore.ts:1866` |
| P2 | First-init migration and namespace creation remain check-then-act across processes. | Claude F8 | `src/db/migrations/runner.ts:33`, `src/db/repositories/NamespaceRepository.ts:62` |
| P2 / Required DX | Add an opt-in pluggable reranker over fused top candidates. | Claude F3, user requirement | `src/pipeline/retrieve.ts:469`, `src/domain/types.ts:216` |
| P2 / Required DX | Add a minimal self-citation helper with implementer-facing docs while preserving mandatory citations. | Claude F10, user requirement | `src/domain/types.ts:51`, `src/store/TragetiStore.ts:1514`, `README.md` |
| P3 / Required Docs | Token budget is a character heuristic; documentation must say it is an estimate and recommend headroom. | Claude F4, user requirement | `src/defaults/formatting/ProseFormatter.ts:32`, `README.md:358` |
| P3 / Recommended API | Support an opt-in pluggable tokenizer for context assembly budgets. | Claude F4 | `src/domain/types.ts:350`, `src/defaults/formatting/ProseFormatter.ts:18` |
| P3 / Required Docs | CTE graph BFS dense-graph costs need clearer implementer-facing documentation. | Claude F6, user requirement | `src/defaults/graph/CTEGraphAdapter.ts:30`, `_docs/dev/README.md` |
| P3 | Crashed staging-swap reindexes can leave orphan vec0 staging tables. | Claude F7 | `src/pipeline/reindex.ts:81`, `src/db/repositories/EmbeddingRepository.ts:35` |
| Release | npm `latest` points to an alpha prerelease. | Claude F9 | npm registry dist-tags, verified 2026-06-29 |

## Details

### P1: Hybrid recall is vector-bounded

In hybrid retrieval with a readable vector index, Step 2 selects the vector top `limit * OVERSAMPLE_MULTIPLIER`. Step 3 then runs BM25 only against those vector-selected IDs:

```ts
const step3 = vectorCanRun
  ? runStep3(db, buildCandidateJson(step2Rows.map((r) => r.assertion_id)), ftsText, bm25Limit)
  : runStep3Temporal(db, query, ftsText, oversample);
```

Candidate assembly then keeps only vector IDs when `vectorCanRun` is true. A strong lexical match that was not admitted by vector search is unreachable in `hybrid`, even if BM25 would rank it first.

This is a real recall defect because the public strategy is named and documented as `hybrid`, meaning callers reasonably expect both semantic and lexical retrievers to contribute candidates before fusion. The existing alpha.1 test `hybrid retrieval - BM25 attaches to vector-selected candidates only` encodes the current bug as expected behavior.

Resolution:

- In hybrid/vector-capable retrieval, call `runStep3Temporal(db, query, ftsText, oversample)` so BM25 selects its own top temporal candidates.
- Build candidates from the union of `step2Rows` IDs and `bm25Map` keys.
- Leave `RRFScorer` unchanged. It already tolerates `semanticDistance: null` and `bm25Score: null`.
- Update comments, README/spec text, and tests that assert vector-bounded hybrid recall.
- Add a regression where an assertion is BM25-strong but vector-absent and must be returned by `hybrid`.

Alternative:

- Keep vector-bounded hybrid and rename/document it as vector-first reranking.
- Trade-off: preserves current behavior and ranking tests, but the default `hybrid` strategy remains misleading and loses lexical recall.

### P1 / Security: Column extension definitions are raw DDL

`SchemaExtensionApplier` validates table `createSQL`, but column definitions are still concatenated into `ALTER TABLE ... ADD COLUMN` and passed to `db.exec()`:

```ts
db.exec(`ALTER TABLE ${quoteIdent(col.table)} ADD COLUMN ${quoteIdent(col.column)} ${col.definition}`);
```

Identifiers are quoted, but `col.definition` is a caller-controlled SQL fragment. OWASP guidance for dynamic SQL parts that cannot be parameterized is allow-list validation. SQLite also exposes a constrained column-definition grammar for `ALTER TABLE ADD COLUMN`, so Trageti can reject definitions outside the supported subset.

Resolution:

- Add `validateColumnDefinition(table, column, definition)` and call it before DDL execution.
- At minimum reject semicolons, SQL comments, NUL/control characters, side-effecting keywords, and unbalanced quotes/parentheses.
- Prefer a positive grammar for supported definitions: type name, optional `DEFAULT` literal, optional `NOT NULL`, optional `CHECK (...)`, optional `COLLATE`, and other intentionally supported SQLite column-definition pieces.
- Update README/type docs to state raw schema SQL is trusted-code only unless using the constrained validator/builder.
- Add tests for stacked statements and normal accepted definitions.

Alternative:

- Keep raw fragments as an advanced trusted-code escape hatch and add a safe builder API.
- Trade-off: maximum SQLite flexibility remains, but configuration-driven applications get a safer path.

### P2: Context assembly recall ceiling and coverage count

`assembleContext()` always calls `retrieve()` with `limit: DEFAULT_ASSEMBLY_RETRIEVAL_LIMIT`, currently 100, then lets the formatter truncate by `tokenBudget`. `coverage.totalAssertions` is set to the fetched result count, not the total number of matching assertions.

Impacts:

- A large token budget cannot include more than 100 assertions.
- `coverage.totalAssertions` can read as complete coverage when it is only coverage of the fetched page.
- After fixing hybrid recall to union vector and BM25 candidates, assembly's fixed fetch size becomes more visible.

Resolution:

- Derive the initial fetch limit from `tokenBudget`, formatter/token estimator, and/or a caller option.
- Add a count path that reports the total number of matching assertions for the query filters before truncation.
- Rename or split coverage fields if both fetched count and true match count are useful, for example `matchedAssertions`, `fetchedAssertions`, and `includedAssertions`.

Alternative:

- Keep the fixed fetch but rename coverage to make it explicit: `fetchedAssertions` instead of `totalAssertions`.
- Trade-off: lower implementation cost, but still caps large-budget assembly.

### P2: Cross-namespace graph traversal is only shallowly cross-namespace

README text says explicit cross-namespace links are permitted and traversal can cross into the linked namespace. The default CTE can return a one-hop foreign target, but recursive steps continue filtering `trageti_links` by the original namespace. After `A:a1 -> B:b1`, traversal does not continue through normal B-scoped outgoing links from `B:b1`.

Resolution:

- Decide the exact contract.
- If traversal should follow the destination namespace, carry the current assertion namespace through the recursive CTE and select next-hop links from that namespace.
- If traversal is intended to remain fixed to the original link namespace, update README/spec and adapter docs to say so explicitly.
- Add cross-namespace multi-hop tests.

### P2: `findPath()` accepts nonexistent zero-hop endpoints

`CTEGraphAdapter.findPath()` returns `[]` immediately when `fromId === toId`, before checking whether the assertion exists. That makes a missing ID indistinguishable from a real zero-hop path.

Resolution:

- Preflight zero-hop paths in the store/pipeline and verify the assertion exists.
- Return `null` for a missing same-ID endpoint, or throw a typed input error if missing endpoints are invalid input.
- Add tests for existing same-ID, missing same-ID, and same-ID in another namespace.

### P2: `explain()` diverges from `retrieve()` for caller-supplied embeddings

`retrieve()` validates caller-supplied embedding length and finite values, and it fails or degrades based on vector readiness. `explain()` only runs scalar retrieval validation and estimates vector applicability from namespace/table state. It can return a plan for a call `retrieve()` would reject.

Resolution:

- Factor shared vector routing and validation classification for `retrieve()` and `explain()`.
- Validate caller-supplied embeddings in `explain()`.
- Either throw the same typed errors as `retrieve()` or extend the explain result with machine-readable `wouldFail` / `failureCode`.

### P2: Failed setup can leak file-backed database handles

`prepareDatabase()` opens file-backed `better-sqlite3` handles and can throw during pragma setup or sqlite-vec loading. `TragetiStore.create()` can also throw during `store.init()` after opening a file-backed handle. In both cases, callers do not receive the handle and cannot close it.

Resolution:

- Track whether `prepareDatabase()` opened the handle and close it before rethrowing setup failures.
- Wrap `await store.init()` in `TragetiStore.create()` and close the DB when the create path owns it.
- Preserve the original failure as the primary error if close also throws.
- Add temp-file tests that force setup/init failure and then verify the file can be reopened/deleted.

### P2: `getMissingIndexing()` requires sqlite-vec too early

`getPendingIndexing()` can answer from core tables when a vector namespace has no vec0 table yet. `getMissingIndexing()` calls `ensureVectorReadable()` before checking whether the table exists, so it can throw `MissingPeerDependencyError` even though no vec0 inspection is needed.

Resolution:

- In `getMissingIndexing()`, check `embeddingRepo.tableExists(tableName)` before `ensureVectorReadable()`.
- If the table is absent, return `filterRequestedIndexingIds(namespace, assertionIds, options)`.
- Only require sqlite-vec when a vec0 table exists and needs introspection.

### P2: Init and namespace creation are not cross-process serialized

Namespace operation locks now have heartbeats, which protects long-running operations. That does not serialize first database initialization, migration application, or first creation of the same namespace across separate processes. The migration runner and namespace `upsert()` still use read-then-insert flows that can race.

Resolution:

- Serialize initialization and migrations with `BEGIN IMMEDIATE`, an init lock table, or another SQLite-backed app-level initialization guard.
- Treat benign "already applied" / "already exists with same config" conflicts as retryable reads where possible.
- Add multi-connection tests for fresh DB init and same-namespace creation.

### P2 / Required DX: Opt-in pluggable reranker

The pipeline currently scores and sorts fused candidates, then truncates. A second-stage reranker is a valid release requirement: it should be opt-in, pluggable, and run over the fused top candidates before final truncation. Multi-phase ranking is a common search architecture for balancing broad first-stage recall with more expensive precision ranking.

Resolution:

- Add a public reranker interface, for example `IRetrievalReranker`.
- Add optional store-level and query-level reranker configuration.
- Run the reranker after first-stage fusion over a bounded pool and before final `limit`.
- Keep it disabled by default so vectorless/offline usage remains dependency-free.
- Define timeout/error behavior and whether reranker failures fail the query or degrade to fused ranking.

### P2 / Required DX: Minimal self-citation helper

Mandatory citations are a core provenance feature and should remain enforced. However, a single-assertion ingest path currently requires callers to hand-author a citation object even for basic trial usage. A self-citation helper is required to reduce first-run friction without weakening the data model.

Resolution:

- Add a small helper, for example `selfCitation({ assertionId, episodeId, sourceRef?, excerpt? })`, that returns a valid `NewAssertionCitation`.
- Document when it is appropriate and when richer citations should be used.
- Keep strict citation enforcement unchanged.

### P3 / Required Docs: Token budget heuristic

`ProseFormatter` estimates tokens as `Math.ceil(line.length * tokensPerChar)`. This is useful as a cheap heuristic, but token counts vary by tokenizer, model, language, punctuation, and code content. Documentation must state that `tokenBudget` is approximate and recommend headroom.

Resolution:

- Update README and implementer docs with an explicit estimate warning.
- Recommend leaving headroom when passing assembled context to model APIs.
- Add examples showing how to tune `tokensPerChar`.

### P3 / Recommended API: Pluggable tokenizer for context budgets

Support a tokenizer/counting hook so callers can use model-specific token counters instead of character heuristics.

Resolution:

- Add an optional token counting interface to formatter or context assembly options.
- Keep the current heuristic as the default.
- Make tokenizer errors explicit and deterministic.

### P3 / Required Docs: Dense graph CTE costs

`CTEGraphAdapter` uses recursive CTEs and per-path visited arrays. The code comment warns that this can be slow on dense or large graphs, but implementer-facing documentation should call out the scale boundary and the `GraphQueryAdapter` escape hatch.

Resolution:

- Add a dedicated docs section covering graph adapter performance expectations.
- Recommend custom graph adapters for dense, high-depth, or high-fanout workloads.
- Document how temporal validity and namespace behavior must be preserved by custom adapters.

### P3: Orphan staging vec0 tables after crash

Staging-swap reindex creates a uniquely named vec0 staging table and cleans it up on handled failures. A process crash after table creation can still leave a physical staging table that is not referenced by `trageti_namespaces.embedding_table`.

Resolution:

- Add an init-time or explicit maintenance sweep for `trageti_embeddings_*_staging_*` tables with no namespace metadata reference.
- Log each dropped orphan table.
- Keep the sweep conservative: never drop the currently referenced `embedding_table`.

### Release: prerelease is on npm `latest`

As of 2026-06-29, `npm view trageti dist-tags --json` returns:

```json
{
  "alpha": "0.4.1-alpha.0",
  "latest": "0.4.1-alpha.0"
}
```

This means bare `npm install trageti` resolves to an alpha prerelease.

Resolution:

- Move `latest` back to the intended stable release or remove the alpha from `latest`, depending on release policy.
- Publish future prereleases with an explicit prerelease tag, for example `npm publish --tag alpha`.
- Verify Changesets/CI does not override the intended dist-tag.

## Fixed Or Rejected Items From Source Documents

- Claude F5, graph expansion N+1: fixed in alpha.1 by batched temporal target hydration.
- Claude F6 as a code defect: accepted only as documentation work. The default adapter already warns in code; the gap is implementer-facing docs.
- Mandatory citations as a model defect: rejected. Citation enforcement remains correct; the valid finding is the required self-citation helper and docs.

## Recommended Fix Order

1. Fix hybrid candidate generation and update tests/spec/docs.
2. Harden `ColumnExtension.definition`.
3. Fix context assembly fetch/coverage semantics.
4. Add the required opt-in reranker and self-citation helper.
5. Fix graph/zero-hop/explain/setup/getMissingIndexing correctness issues.
6. Add required documentation for token budgets and dense graph adapter boundaries.
7. Add staging-table GC and init/create cross-process hardening.
8. Correct npm dist-tags before the next publish.
