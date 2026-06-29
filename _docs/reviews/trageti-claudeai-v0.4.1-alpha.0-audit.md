# Trageti — Technical Audit

**Package:** `trageti@0.4.1-alpha.0` (git `72d19b5`, spec v0.3 rev2)
**Date:** 2026-06-27
**Method:** Source read of the core: schema + migrations, all six repositories, the retrieval pipeline and scorers, the CTE graph adapter, the store's write/lock/delete/reindex/assembly paths, connection/pragma setup, tokenizer and hash utilities, and packaging. The test suite was inventoried (45 files, ~9.7k LOC) but not executed; formatters, middleware, and the schema-extension applier were skimmed, not deep-read. This is a substantial audit of the core, not a line-by-line review of every module.

**Scope note:** This is the single, authoritative findings document for Trageti. It consolidates and supersedes the earlier retrieval-shortcomings brief — every finding (F1–F10) lives here.

**Headline:** The library is well-built. Security posture is strong, the temporal/supersession core is correct and transactional, and packaging is done properly. The findings below are real but none are critical; F1 is a must-fix, the rest are correctness-of-reporting, performance, concurrency, and hygiene items.

**Severity scale:** High = data loss / corruption / injection. Medium = wrong-but-silent results, meaningful perf cliff, or surprising behavior. Low = hardening, hygiene, or DX.

---

## Findings

### Retrieval & correctness

**F1 — Hybrid recall is bounded to the vector candidate set.** *Medium · must fix (deliberate, but a defect — the spec is wrong here too).*
`src/pipeline/retrieve.ts` (Steps 2–3), `src/internal/retrieval-defaults.ts`.
In `hybrid` with a vector index, candidates are the top `limit × 3` cosine neighbors (`OVERSAMPLE_MULTIPLIER = 3`); BM25 only *re-scores* those, it never contributes candidates. A strong lexical match (exact token / ID / rare term) ranked below the vector top-30 is unreachable in hybrid mode — the exact case hybrid search exists to catch. The `bm25` strategy is unaffected (BM25 selects there).
This is not a tradeoff to ratify. The public method is named `hybrid`; a developer reaching for it expects lexical and semantic recall to be unioned, and the current behavior silently violates that expectation. The fact that it was deliberate — codified in spec v0.3 rev2 §2581-2582 / §2661-2665 — means the **spec carries the same defect and must be corrected alongside the code**, not used to justify keeping the behavior.
**Fix:** make BM25 an independent retriever — union candidate generation (`vector_top_N ∪ bm25_top_N`) then RRF over the union. `runStep3Temporal` already demonstrates BM25 selection over the temporal set, so the machinery exists; the change is small and surgical. Existing hybrid-result assertions in the test suite will shift and should be updated to reflect correct union recall.

**F2 — Context assembly has a hardcoded recall ceiling and a misleading coverage metric.** *Medium.*
`src/pipeline/assemble.ts`, `src/internal/retrieval-defaults.ts` (`DEFAULT_ASSEMBLY_RETRIEVAL_LIMIT = 100`).
`assembleContext()` always retrieves exactly 100 assertions and lets the formatter truncate to `tokenBudget`. Two consequences: (a) a large token budget can never surface more than 100 assertions; (b) `coverage.totalAssertions` reports the fetched count (≤100), not the true number of matching assertions in the namespace — so "coverage" silently means "coverage of the fetched 100," which can read as far more complete than it is. **Fix:** derive the initial fetch from `tokenBudget` (or expose it), and compute `totalAssertions` from an actual count query, not the truncated fetch.

**F3 — No reranking stage.** *Low–Medium · gap.*
`src/pipeline/retrieve.ts` (Step 5 is a pure sort).
No second-stage cross-encoder rerank over the fused top-k caps achievable precision@k. **Fix:** optional, opt-in pluggable reranker over the fused top-k before truncation; keep it off by default so the offline/vectorless path stays dependency-free.

**F4 — Token budget is a character heuristic, not a token count.** *Low · DX.*
`src/defaults/formatting/ProseFormatter.ts` (`Math.ceil(line.length * tokensPerChar)`).
`tokenBudget` is approximated as characters × a constant. This is materially off for code, non-English text, or dense punctuation, so assembled context can over- or under-shoot a model's real limit. A single assertion larger than the whole budget yields empty context (the first line breaks immediately). **Fix:** document the estimate clearly and recommend headroom; optionally allow a pluggable real tokenizer.

### Performance

**F5 — N+1 query in graph expansion.** *Medium.*
`src/pipeline/retrieve.ts` (Step 6).
When `expandLinks` is set, each linked target is hydrated with a separate `assertionRepo.getById(link.toId)` — one assertion SELECT *plus* one citation SELECT per link, per result. With many links or `maxDepth > 1` this is a quadratic-ish query fan-out on an otherwise tight hot path. The batched `getByIds` (which already batches citations) exists and should be used instead. **Fix:** collect all linked ids, hydrate once via `getByIds`, then attach.

**F6 — CTE graph BFS can blow up on dense graphs.** *Low · documented by authors.*
`src/defaults/graph/CTEGraphAdapter.ts`.
Per-path `visited` arrays scanned via `json_each` make traversal cost grow with path count on dense graphs. The adapter's own doc-comment acknowledges this and points to a custom `GraphQueryAdapter` for large graphs. Fine for local-scale use; flagged so the boundary is explicit.

**F7 — Orphan staging tables on crashed reindex.** *Low · housekeeping.*
`src/pipeline/reindex.ts`.
Staging-swap creates `..._staging_<uuid>` vec0 tables. A crash between create and swap/cleanup leaves orphan tables (the namespace lock is recovered via staleness, but the physical table is not GC'd). **Fix:** a sweep that drops `trageti_embeddings_*_staging_*` tables with no live `embedding_table` reference, runnable on init or on demand.

### Concurrency

**F8 — Cross-process races on first init and namespace creation.** *Low–Medium.*
`src/db/migrations/runner.ts`, `src/db/repositories/NamespaceRepository.ts` (`upsert`).
Namespace *operations* (reindex, delete) are correctly serialized cross-process via an atomic `INSERT` into `trageti_namespace_locks` (PK on namespace) — that part is solid. But migration application and namespace `upsert` are check-then-act and are **not** covered by that mechanism (you can't lock a namespace that doesn't exist yet, and migrations precede any namespace). Two processes opening a fresh database concurrently, or creating the same new namespace concurrently, can throw on one side (PK conflict on the schema-version row or the namespace row). "Local SQLite" actively invites multi-process access, so this is worth handling. **Fix:** wrap init/migration in `BEGIN IMMEDIATE` (or an app-level init lock) and catch the benign "already applied / already exists" conflict, retrying the read.

### Packaging & release hygiene

**F9 — A prerelease occupies the `latest` dist-tag.** *Low · real.*
Registry shows `latest → 0.4.1-alpha.0` (and `alpha → 0.4.1-alpha.0`), while `package.json publishConfig.tag` is `"beta"`. So a bare `npm install trageti` pulls an alpha, and the configured tag wasn't honored. **Fix:** republish prereleases under a prerelease tag only (`npm publish --tag alpha`) and reserve `latest` for a stable cut; verify `changeset publish` / CI isn't overriding `publishConfig`.

### API surface & adoption

**F10 — Mandatory citations raise trial-adoption friction.** *Low · API/adoption · deliberate.*
`src/db/migrations/v001_baseline.ts` (schema), `writeAssertion` / `writeEpisodeBundle` (enforcement).
Every assertion must carry at least one citation. This is excellent for provenance and faithfulness, and the right call for provenance-sensitive users (clinical, legal, research) — but it raises the bar for casual "embed my docs and go" evaluation, filtering away the quick-trial adopter who would otherwise convert. This is a deliberate audience choice, not an oversight, and not a defect; it is flagged because the friction is real and worth managing. **Fix (optional):** keep the model, but offer a documented minimal-citation path (e.g. a single self-citation helper) to lower the first-run cost without weakening provenance.

---

## Verified clean

These were specifically checked and found sound — listed because a credible audit should say what it cleared, not just what it flagged.

- **SQL injection:** every query parameterized; the only dynamic identifiers are vec0/FTS table names, which are SHA-256-derived (`src/internal/hash.ts`) and `quoteIdent`-escaped. The two unparameterizable surfaces — FTS5 tokenizer DDL and custom pragmas — are guarded by allow-lists plus strict char-class regexes (`src/internal/tokenizer.ts`, `prepareDatabase`). No injection path found.
- **Supersession atomicity:** the successor insert, its citations, and the predecessor's `valid_until` close happen in one `db.transaction()` (`writeAssertion`, `writeEpisodeBundle`). The README's atomicity claim holds.
- **Append-only model:** no single-assertion delete; content is immutable (changes happen via a new superseding assertion). This sidesteps orphan-embedding and stale-embedding hazards — an embedding stays valid for its (immutable) content forever. `deleteNamespace` drops the whole vec0 table in a transaction with FK-safe ordering.
- **Foreign keys:** the default verifier enables FKs, re-reads, and fails closed (`DefaultConnectionVerifier`).
- **Determinism:** retrieval ranking, graph traversal output, and supersession chains all have explicit, total tie-break orders.
- **Cycle / depth safety:** graph BFS carries a per-path `visited` set; supersession traversal is structurally acyclic by construction and additionally capped at depth 1000.
- **Timestamps:** consistent ISO-8601 across all five repositories (an earlier suspicion of a `toISOString()` vs `datetime('now')` split was checked and is false — the SQL default is simply never exercised).
- **Lock stale-clear:** compares ISO string to ISO string (chronological), not the string-vs-number bug it superficially resembles.
- **Packaging:** dual ESM/CJS via tsup; correct `exports` map including a separate `./dist/index.d.cts` for CJS types (a commonly-missed detail); `files` whitelist + `.npmignore` keep `src`/`test` out of the tarball; `sideEffects:false`; `prepublishOnly` runs lint + typecheck + coverage + build + e2e. `better-sqlite3` correctly external; `sqlite-vec` correctly an optional peer loaded via `createRequire`.
- **Test depth:** 45 test files / ~9.7k LOC against ~6.9k source LOC, including an e2e test of the published package surface, vectorless-mode, supersession, trajectory, temporal-filter, and migration tests.

---

## Summary

| ID | Finding | Severity | Intended? |
|----|---------|----------|-----------|
| F1 | Hybrid recall bounded to vector candidate set | Medium | Deliberate — and that's the defect (fix code + spec) |
| F2 | Context-assembly recall ceiling + misleading coverage | Medium | Partly |
| F3 | No reranking stage | Low–Med | — |
| F4 | Token budget is a char heuristic | Low | Yes |
| F5 | N+1 in graph expansion | Medium | No |
| F6 | CTE BFS scaling on dense graphs | Low | Yes (documented) |
| F7 | Orphan staging tables on crash | Low | No |
| F8 | Cross-process init / namespace-create races | Low–Med | No |
| F9 | Prerelease on `latest` dist-tag | Low | No |
| F10 | Mandatory citations raise trial friction | Low | Deliberate (manage, don't remove) |

**Priorities.** **F1 is a must-fix** — `hybrid` that can't surface a strong lexical match is false advertising, and the spec defect should be corrected with it. Beyond that, if you touch three things: **F5** (clear win, pure perf, batch the hydrate), **F2** (correctness-of-reporting — the coverage metric can mislead a caller into trusting partial context), and **F8** (multi-process is the natural failure mode for a local SQLite library). The rest are hygiene.

**Not audited:** formatters beyond the prose token estimator, the middleware pipeline internals, the schema-extension applier, and runtime behavior (no suite execution, no benchmarks, no fuzzing of FTS/vector edge cases). A follow-up pass on those plus an actual `npm pack` smoke test would close the remaining gaps.
