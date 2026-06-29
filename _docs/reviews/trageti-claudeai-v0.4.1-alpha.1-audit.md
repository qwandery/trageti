# Trageti — Technical Audit (v0.4.1-alpha.1)

**Package:** `trageti@0.4.1-alpha.1` (git `fcd902a`)
**Supersedes:** the v0.4.1-alpha.0 audit (`72d19b5`). Single authoritative findings doc; F1–F10 carried forward with alpha.1 status.
**Method:** Re-cloned at the new HEAD and diffed against `72d19b5`. Read the full `retrieve.ts` hybrid path, the new `runStep2Temporal`, the candidate-assembly block, the v003 migration, and the reindex/repository diffs.

**Headline:** alpha.1 landed real improvements — the graph-expansion N+1 (F5) is fixed and now temporally correct, and the namespace lock gained a heartbeat (F8). **But the priority item, F1, is *not* fixed.** The retrieval refactor that touched the vector path is a performance change orthogonal to the hybrid-recall defect; the candidate set is still vector-bounded.

---

## Status at a glance

| ID | Finding | Severity | alpha.1 status |
|----|---------|----------|----------------|
| **F1** | **Hybrid recall bounded to vector candidate set** | **HIGH** | **NOT FIXED** — perf refactor only; recall ceiling intact |
| F2 | Context-assembly ceiling + misleading coverage count | Medium | Unchanged (`assemble.ts` untouched) |
| F3 | No reranking stage | **Required** (opt-in, pluggable) | Not present |
| F4 | Token budget is a char heuristic | Docs **mandatory**; pluggable tokenizer recommended | Not addressed |
| F5 | N+1 in graph expansion | Medium | **FIXED** — batched + temporally correct |
| F6 | CTE BFS scaling on dense graphs | Low | Code +24 lines; needs implementer-facing docs |
| F7 | Orphan staging tables on crash | Low | Appears unaddressed — verify |
| F8 | Cross-process races | Low–Med | **Partially fixed** — lock heartbeat added; init/create race likely remains |
| F9 | Prerelease on `latest` dist-tag | Low | Verify at publish |
| F10 | Mandatory citations raise trial friction | Self-citation helper **mandatory** | Not present |

---

## F1 — Hybrid recall is still bounded to the vector candidate set · HIGH · NOT FIXED

**This is the one that has to change, and "hybrid" should do what it says on the tin.**

### What alpha.1 changed (and why it doesn't fix F1)

The vector step was refactored from `runStep2` to `runStep2Temporal`. Old path materialized every temporal-candidate id in JS, built a JSON array, and constrained the vec0 search to it. New path pushes the temporal predicate directly into the vec0 SQL (`WHERE assertion_id IN (SELECT id FROM trageti_assertions WHERE <temporal conditions>) ORDER BY semantic_distance ASC LIMIT oversample`). That's a legitimate performance win — it avoids materializing the candidate list — and it's the right direction. **But it only changes *how vector selects its own candidates*. It does not make BM25 an independent retriever.**

In the hybrid+vector path today (`src/pipeline/retrieve.ts`):

- **Step 3 (BM25)** still re-scores the vector picks only: `runStep3(db, buildCandidateJson(step2Rows.map(r => r.assertion_id)), ftsText, …)`. BM25 is bounded to the ≤`limit × 3` ids vector already chose.
- **Candidate set** is still vector-only: `if (vectorCanRun) { for (const r of step2Rows) candidateIds.add(...) }`.

So a document BM25 would rank #1 but that the vector stage didn't admit (exact token, identifier, rare term) remains unreachable in hybrid mode — exactly the case hybrid search exists to catch. The stale comment at the top of Step 3 ("BM25 is a re-scoring step") and the spec (v0.3 rev2 §2581-2582 / §2661-2665) still encode the defect and must be corrected with the code.

### The fix — candidate generation only; RRF and the scorer are untouched

The defect is in **candidate generation**, not fusion. `RRFScorer` is correct and stays exactly as-is. Concretely, two edits in `retrieve.ts`:

1. **Make BM25 select its own candidates in the vector path.** In Step 3, when vector ran, call `runStep3Temporal(db, query, ftsText, oversample)` (the same independent, temporally-bounded BM25 selection the bm25-only path already uses) instead of `runStep3(db, buildCandidateJson(step2Rows…), …)`. BM25 now returns its own top-`oversample` over the temporally-valid set.
2. **Union the candidate ids.** Replace the `if (vectorCanRun) …vector-only… else …bm25-only…` branch with a true union: add every `step2Rows` id **and** every `bm25Map` key. Pool becomes `vector_top_N(temporal) ∪ bm25_top_N(temporal)`.

That's it. Everything downstream already supports this:

- **Partial membership is already handled.** The candidate assembly sets `semanticDistance: semanticById.get(id) ?? null` and `bm25Score: bm25Map.get(id) ?? null`. A bm25-only candidate arrives with a null semantic distance; a vector-only candidate with a null BM25 score. `RRFScorer` ranks each signal over the candidates that *have* that signal and contributes nothing for a missing one — which is already how the three-signal fusion (semantic + BM25 + recency) works, since recency isn't present on every candidate. **No scorer change. No new edge case.**
- **Hydration already works for the union.** Under `useVectorBoundedTemporalSelection`, `oversampledIds = [...candidateIds]` (no `step1Map` filter), and the hydrated rows are written back into `step1Map`. BM25-only ids hydrate via the same `getByIds` call and get their `step1Row`. The union fix is compatible with the alpha.1 refactor as written.

### What *does* change, and must be validated deliberately

- **Result membership changes**, not just ordering — documents will surface that literally could not before. That is the fix working.
- **BM25 rank values change** for documents already in the pool: today a doc's BM25 rank is its position among the vector picks; after the union it's its position in BM25's own top-N. Same `RRFScorer`, different (correct) input ranks → different output ordering. Validate the new ranking against intent; don't be surprised by it.
- **Pool size grows**, worst case from `limit × 3` toward `2 × (limit × 3)` when the two top-Ns are disjoint. Bounded, but it feeds assembly — so treat **F2 as part of this change**: the hardcoded 100-candidate assembly fetch and the `coverage.totalAssertions` count (which reports fetched, not true total) matter slightly more once the pool is honest.

### Tests

The existing 669-line regression suite plus the hybrid tests will move. Distinguish three cases as you update them: (a) **membership** changes — a test asserting the old vector-bounded recall was encoding the bug as expected behavior; fix the assertion. (b) **ordering** changes — softer, expected. (c) anything breaking that touches **neither** the hybrid path's membership nor ordering (supersession, temporal-filter, vectorless path) — that's unintended blast radius; stop and look rather than greening the assertion.

---

## Fixed / improved in alpha.1

**F5 — N+1 in graph expansion · FIXED (and better than asked).** The per-link `getById(link.toId)` loop is gone, replaced by a single batched `getByIdsValidAt([...unique toIds], temporalAnchor, { includeSuperseded })` with a `targetById` map. Not only is the N+1 eliminated, the batch is now **temporally correct** — link targets are resolved as-of the query anchor, which the old per-row path did not guarantee.

**F8 — Cross-process robustness · PARTIALLY FIXED.** New migration `v003_namespace_lock_heartbeat` adds a `heartbeat_at` column + index to `trageti_namespace_locks`. This lets a long-running operation prove liveness so its lock isn't stale-cleared mid-flight, and lets stale-clear target genuinely dead locks — a real improvement to the lock mechanism. **Still open:** the first-init / namespace-creation race (migration apply and `NamespaceRepository.upsert` are check-then-act, not guarded by the lock, since there's no namespace to lock yet). The runner diff shows no `BEGIN IMMEDIATE` / init guard. Lower priority, but note it remains.

---

## Still open — with your directives folded in

**F2 — Assembly recall ceiling + misleading coverage · Medium · unchanged.** `assemble.ts` was not touched. The 100-candidate fetch is still hardcoded regardless of `tokenBudget`, and `coverage.totalAssertions` still reports the fetched count, not the true matching total. Fix: derive the fetch from `tokenBudget`; compute `totalAssertions` from a real count. Bundle with F1 (the union changes pool size).

**F3 — Reranker · now REQUIRED (opt-in, pluggable).** No rerank stage exists; Step 5 is still a pure sort. Add an **opt-in, pluggable** reranker over the fused top-k before truncation, consistent with the existing pluggable-scorer pattern, off by default so the offline/vectorless path stays dependency-free. This is also directly supported by the external literature (Vespa's multiphase cascade ranking) as the standard precision lever.

**F4 — Token budget heuristic · docs MANDATORY; pluggable tokenizer recommended.** The budget is `chars × tokensPerChar` (`ProseFormatter`), materially off for code/non-English. **Mandatory:** implementer-facing docs stating the budget is an estimate and to leave headroom. **Recommended:** support an opt-in pluggable real tokenizer.

**F6 — CTE BFS scaling · implementer docs needed.** alpha.1 added ~24 lines and a temporal-validity guidance commit. Ensure the dense-graph cost characteristic and the `GraphQueryAdapter` escape hatch are documented in **implementer-facing** docs, not just code comments.

**F7 — Orphan staging tables · appears unaddressed.** No sweep for `trageti_embeddings_*_staging_*` tables left by a crashed reindex was found in the diff. Low priority; add a sweep on init or on demand.

**F9 — Prerelease on `latest` dist-tag.** Verify at publish that `0.4.1-alpha.1` goes to a prerelease tag and not `latest`, so a bare `npm i trageti` doesn't pull an alpha.

**F10 — Self-citation helper · MANDATORY.** Keep the mandatory-citation model, but add a minimal **self-citation helper** (so a single-assertion ingest doesn't require hand-authoring a citation), with clear implementer-facing docs. Lowers first-run friction without weakening provenance.

---

## What to do next, in order

1. **F1 (HIGH).** Two edits in `retrieve.ts`: BM25 selects its own top-N via `runStep3Temporal` in the vector path; union the candidate ids. Leave `RRFScorer` untouched. Update the stale Step-3 comment and the spec. Re-validate ranking and reclassify the tests.
2. **F2 (Medium), bundled with F1.** Budget-derived fetch; honest `totalAssertions`.
3. **F3 (required).** Opt-in pluggable reranker over fused top-k.
4. **F10 (mandatory).** Self-citation helper + docs.
5. **F4 (mandatory docs).** Estimate caveat now; pluggable tokenizer when feasible.
6. **F6 docs / F7 sweep / F8 init-race / F9 dist-tag.** Hygiene.

**Net:** alpha.1 is a real step — F5 and the lock heartbeat are genuine. But the headline defect is untouched: hybrid retrieval still can't surface a strong lexical match the vector stage didn't admit. The fix is small, it's in candidate generation, and it leaves RRF alone.
