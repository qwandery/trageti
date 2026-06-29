# Trageti v0.4.2-alpha.0 Codex Code Review

Date: 2026-06-29

Scope: current repository state after commit `a394ffe` (`trageti@0.4.2-alpha.0`). This review uses the code-review skill and covers:

1. Remediation status against `_docs/reviews/trageti-v0.4.1-alpha.1-revised-codex-code-review.md`.
2. Developer experience across API, config, docs, and onboarding.
3. Demo relevance, correctness, and concept coverage.
4. Core API method behavior and implementation robustness.
5. Real-world RAG usefulness and production value.
6. Additional overlooked concepts, risks, and surfaces.

No npm registry or GitHub network state was verified during this local review. Dist-tag and publish-state comments below are therefore based only on committed release metadata, not on live registry state.

## Standard Code Review

**Verdict:** REQUEST CHANGES

**Confidence:** HIGH

### Summary

The v0.4.2-alpha.0 implementation resolves most of the revised alpha.1 remediation list: hybrid recall is no longer vector-bounded, rerankers and self-citation exist, context coverage is improved, graph traversal crosses namespaces, schema-extension DDL is hardened, and setup/indexing paths are stronger. However, several correctness and release-readiness issues remain, including temporal graph invariants, namespace-lock coverage for the advanced close path, reranker score semantics, `explain()` parity, and stale lockfile metadata.

### Findings

| Priority | Issue | Location |
| --- | --- | --- |
| P1 | Links can be written and traversed with temporal windows that predate their source/target assertions; traversal also does not verify the origin assertion is valid at the anchor. | `src/store/TragetiStore.ts:574`, `src/store/TragetiStore.ts:1847`, `src/defaults/graph/CTEGraphAdapter.ts:73`, `src/defaults/graph/CTEGraphAdapter.ts:175` |
| P1 | `advanced.closeAssertion()` bypasses namespace operation locks, so it can mutate active/superseded state during a reindex lock. | `src/store/TragetiStore.ts:539`, `src/store/TragetiStore.ts:550`, `src/store/TragetiStore.ts:1754` |
| P1 | Reranked result ordering is based on reranker scores, but `RetrievedAssertion.score` still exposes the first-stage score. | `src/pipeline/retrieve.ts:533`, `src/pipeline/retrieve.ts:539`, `src/pipeline/retrieve.ts:549` |
| P2 | `explain()` still reports vector readiness failures as notes for `retrievalStrategy: 'vector'` instead of throwing the same typed errors as `retrieve()`. | `src/store/TragetiStore.ts:1419`, `src/store/TragetiStore.ts:1440`, `src/store/TragetiStore.ts:1461` |
| P2 | `package-lock.json` still says `0.4.1-alpha.1` while `package.json` says `0.4.2-alpha.0`. | `package-lock.json:3`, `package-lock.json:9`, `package.json:3` |
| P2 | Namespace-scoped storage is advertised, but core IDs are globally unique and this is not made explicit enough for multi-tenant adopters. | `src/db/migrations/v001_baseline.ts:39`, `src/db/migrations/v001_baseline.ts:49`, `README.md:653` |
| P3 | Retrieval comments and README/API docs drifted after the hybrid/reranker changes. | `src/pipeline/retrieve.ts:337`, `src/pipeline/retrieve.ts:371`, `README.md:230`, `README.md:532` |
| P3 | Demos remain useful but do not cover the new v0.4.2 surfaces: rerankers, self-citation, token counters, retrieval expansion controls, schema-extension hardening, or vectorless production flows. | `demos/README.md:10`, `demos/shared/synthesis.ts:129` |
| P3 | The canonical spec document still identifies `0.4.0-rev.0` as the implemented package and does not cover v0.4.2 additions. | `_docs/specs/trageti-spec-v0.3-rev2.md:5` |

## Detailed Findings

### P1: Temporal link validity is underconstrained

`writeLink()` validates only scalar link fields, endpoint existence, cross-namespace warning, and source episode existence. It does not validate that `link.validFrom` is at or after the linked assertions become valid, nor that the source assertion is valid at traversal time. The default CTE adapter joins only the target assertion in both `findConnected()` and `findPath()`.

Impact:

- A caller can write `from.validFrom = 10`, `to.validFrom = 1`, `link.validFrom = 1`.
- `getConnected({ fromAssertionId: from, temporalAnchor: 5 })` can traverse from an assertion that did not yet exist at anchor 5.
- `findPath()` has the same issue on its base term.
- This undermines the library's strongest promise: temporally valid retrieval and graph mechanics.

Proposed resolution:

- In `validateLinkReferences()`, hydrate both endpoints, return their namespace and validity windows, and reject links whose `validFrom < max(from.validFrom, to.validFrom)`.
- If either endpoint has `validUntil`, either reject a link whose `validUntil` exceeds the endpoint window or document that link validity is independently bounded and traversal will still prune invalid endpoints.
- In `CTEGraphAdapter`, join and validate the source assertion in the base term:
  - `source.id = l.from_id`
  - `source.valid_from <= temporalAnchor`
  - unless `includeSuperseded`, `source.valid_until IS NULL OR source.valid_until > temporalAnchor`
- Keep validating every target hop as today.

Alternative:

- Do not enforce endpoint-relative link windows at write time; instead make traversal validate both current source and destination assertions at every hop.
- Trade-off: preserves more historical/dirty data import flexibility, but leaves invalid links in storage and makes every adapter responsible for defensive pruning.

Recommended tests:

- Reject a link whose `validFrom` predates either endpoint.
- `getConnected()` returns no links when the origin assertion is future at the anchor.
- `findPath()` returns `null` when the first hop starts from a future or expired source.
- Cross-namespace traversal still works when both source and target are valid.

### P1: `advanced.closeAssertion()` bypasses namespace locks

All normal mutation paths that can affect retrieval/indexing state check the namespace operation lock: `writeEpisode`, `writeEpisodeBundle`, `writeAssertion`, `writeCitation`, `writeLink`, `indexAssertion`, `indexBatch`, `deleteNamespace`, and `upgradeNamespaceToVector`. `advanced.closeAssertion()` calls `closeAssertionInternal()` without checking the assertion namespace against the lock table.

Impact:

- Active-only reindex (`includeSuperseded: false`) can be running while `advanced.closeAssertion()` changes `valid_until`.
- An active assertion can become superseded after the reindex query selected its batch but before the final swap/delete-superseded cleanup.
- The resulting vector table can contain stale rows or omit a now-needed row, depending on timing and strategy.

Proposed resolution:

- In `closeAssertionInternal()`, after `existing` is hydrated and before mutation, call:

```ts
this.requireNamespaceUnlocked(existing.namespace, 'advanced.closeAssertion');
```

- Add a regression test that manually inserts or acquires a namespace lock and expects `advanced.closeAssertion()` to fail with `NAMESPACE_OPERATION_LOCKED`.
- Add a deferred-provider reindex test that attempts `advanced.closeAssertion()` while the reindex is in flight.

Alternative:

- Remove the public advanced close path and require a regular supersession or a dedicated correction API with a clear lock contract.
- Trade-off: cleaner lifecycle semantics, but less useful for the documented no-replacement correction case.

### P1: Reranked ordering is not reflected in result scores

The reranker sorts `rerankedPool` by `rerankScore`, then discards `rerankScore` before splicing the candidates back into `ranked`. The final `RetrievedAssertion.score` is still `c.score`, the first-stage scorer output.

Impact:

- Results are ordered by one scoring system but expose another.
- Downstream score thresholds, UI score displays, analytics, or synthesis helpers can treat the top result as lower quality than later results.
- Demo synthesis sorts assertions by `score` in `highestSignalAssertions()`, so assembled or synthesized outputs can partially undo reranker ordering if they re-sort the returned context.

Proposed resolution:

- Decide and document score semantics:
  - Option A: `score` means final ranking score. Replace `c.score` with the reranker score for reranked candidates and preserve first-stage score in a new `scoreComponents.firstStageScore` or `rerank` metadata field.
  - Option B: keep `score` as first-stage score, add `rerankScore?: number`, and clearly document that ordering may use `rerankScore`.
- Prefer Option A for simple consumers. Most users expect `result.score` to explain `results` order.
- Add tests that a promoted reranked result has a score consistent with its final rank and that scores are monotonic under reranking.

Alternative:

- Keep current behavior but rename the field in a future breaking release to `firstStageScore`.
- Trade-off: avoids changing the alpha surface immediately, but preserves misleading output in the new reranker feature.

### P2: `explain()` is still not behavior-parity with vector retrieval failures

The revised alpha.1 plan required `explain()` parity for invalid caller embeddings and vector-readiness failures. Caller embedding validation was added, but `retrievalStrategy: 'vector'` readiness failures are still represented as notes such as `retrievalStrategy 'vector' would fail: VECTOR_TABLE_MISSING`.

Impact:

- `retrieve()` throws for vectorless namespaces, missing providers, missing sqlite-vec, and missing vector tables.
- `explain()` succeeds for several equivalent vector strategy calls, so a caller can receive a plan for a query that cannot execute.
- This weakens the stated use of `explain()` as non-executing planning introspection that models retrieval behavior.

Proposed resolution:

- Factor a shared route/classify helper from `resolveQueryEmbedding()` and use it in `explain()`.
- For `strategy === 'vector'`, throw the same typed error class/code that `retrieve()` would throw.
- For `hybrid`, keep notes/fallback modeling because hybrid degradation is valid behavior.
- Add explicit tests for vectorless, no provider, no sqlite-vec, and missing vec0 table parity.

Alternative:

- Keep `explain()` non-throwing but add `wouldFail: true` and `failureCode`.
- Trade-off: useful for UI planning, but this diverges from the implemented plan and requires docs to clearly distinguish `explain()` from `retrieve()`.

### P2: `package-lock.json` is stale for the release

`package.json` is `0.4.2-alpha.0`, but `package-lock.json` still has the root version as `0.4.1-alpha.1`.

Impact:

- Repository release metadata is inconsistent.
- GitHub/source installs and release audits can report the wrong root package version.
- This also undercuts the earlier requirement to keep Changesets/changelog/release metadata current.

Proposed resolution:

- Run `npm install --package-lock-only` or `npm install` with no dependency changes and commit the lockfile version update.
- Add a release checklist item that asserts `package.json`, `package-lock.json`, `CHANGELOG.md`, `.changeset/pre.json`, and `publishConfig.tag` agree.

Alternative:

- Remove `package-lock.json` from the library repository if the project does not want lockfile semantics.
- Trade-off: simpler release metadata, but less reproducible local CI/dev installs.

### P2: Namespace-scoped storage vs globally unique IDs is underdocumented

The schema uses `TEXT PRIMARY KEY` on `trageti_episodes.id`, `trageti_assertions.id`, `trageti_links.id`, and `trageti_citations.id`. That means IDs are globally unique across the whole database, not scoped by namespace. README promises namespace-scoped storage and isolated data/embedding tables, which can lead multi-tenant adopters to reuse natural IDs like `ep-1` in different namespaces.

Impact:

- A second namespace can fail on duplicate IDs despite being conceptually isolated.
- Cross-namespace links are easier to implement with globally unique assertion IDs, but that trade-off is not front-and-center.
- This is a major onboarding and multi-tenant DX trap.

Proposed resolution:

- Add README/API docs: "IDs are database-global. Prefix them with namespace/tenant if natural IDs can collide."
- Consider helper utilities or examples for ID namespacing.
- For a future breaking schema, evaluate composite keys `(namespace, id)` plus explicit cross-namespace endpoint namespace columns on links.

Alternative:

- Keep global IDs permanently as a documented design choice.
- Trade-off: simpler FKs and cross-namespace traversal, but less intuitive multi-tenant ergonomics.

### P3: Documentation and comments drifted after v0.4.2 changes

Examples:

- `src/pipeline/retrieve.ts` comments still say BM25 only re-scores vector-selected candidates and never contributes candidates, while the code now calls `runStep3Temporal()` and unions BM25 IDs.
- README `RetrievalMeta` omits `matchedCount`.
- README says extension column names must not be SQLite reserved words, but the implementation accepts reserved words because identifiers are quoted.
- `_docs/specs/trageti-spec-v0.3-rev2.md` still says the spec is implemented by `0.4.0-rev.0`.

Impact:

- Future maintainers can reintroduce the old hybrid recall bug by trusting stale comments.
- API consumers cannot discover `matchedCount` from the main retrieval docs.
- Schema extension rules appear stricter than the implementation.

Proposed resolution:

- Update comments in `retrieve.ts` to describe independent vector/BM25 candidate generation and union fusion.
- Update README meta shape with `matchedCount`.
- Update schema-extension constraints to match quoted identifier behavior.
- Add a short v0.4.2 addendum to the spec or mark the spec as v0.3 baseline plus later alpha amendments.

### P3: Demos are useful but lag the new API surface

The demos are relevant and valuable: Alex's Place demonstrates temporal personal knowledge, Know Thyself demonstrates repo evolution, and Big Brother demonstrates multimodal activity capture. They cover ingestion, citations, indexing, hybrid retrieval, graph expansion, trajectory mode, snapshots, and assembled context.

Coverage gaps:

- No demo uses `IRetrievalReranker`, so users cannot see the intended first-stage plus second-stage pattern.
- No demo uses `selfCitation()` as a minimal onboarding path.
- No demo shows `TokenCounter`, `retrievalLimit`, or `retrievalExpansion`.
- No demo exercises vectorless/BM25-only production mode end-to-end.
- No demo uses schema extensions.
- `demos/shared/synthesis.ts` copies only older `RetrievalQuery` fields into `ContextAssemblyOptions`; it does not propagate `reranker` or `rerankCandidateLimit` from a query-shaped caller object.

Proposed resolution:

- Add a tiny "minimal-ingest" or "quickstart" demo using vectorless BM25 plus `selfCitation()`.
- Add one reranker example, even if deterministic and simple, to show contract shape.
- Add one context-budget example with a custom token counter.
- Add a schema extension demo or at least a fixture-backed test/demo snippet.
- Decide whether `contextOptionsFromQuery()` should propagate reranker fields, or document that synthesis deliberately ignores rerankers.

### P3: Production positioning gaps remain

Trageti has a strong real-world niche: temporal assertion storage for RAG, provenance through mandatory citations, vectorless fallback, SQLite portability, and extension hooks. It is especially compelling for audit logs, evolving project knowledge, personal/team memory, compliance timelines, support knowledge bases, and source-grounded assistants.

Remaining production gaps to track:

- No built-in document chunker/extractor pipeline; demos have extraction code, but the core starts at "assertion" input.
- No first-party embedding adapters beyond mock/raw vectors.
- No multi-process write coordination beyond SQLite busy timeouts and namespace reindex locks.
- No encryption/backup/retention helpers.
- No metadata/extension-column filtering in retrieval.
- No built-in tenant ID policy despite global IDs.
- No reranker timeout policy beyond passing `AbortSignal` to the context.
- No migration path from earlier prototype schemas, by design, but this limits adopters with old data.

These are not all bugs, but they should be explicit roadmap or limitation items because professional RAG adopters will ask about them.

## Remediation Status Against Revised Alpha.1 Review

| Revised finding | v0.4.2 status |
| --- | --- |
| Hybrid recall vector-bounded | Mostly resolved. Code now unions independent BM25 and vector candidates. Comments remain stale. |
| Raw `ColumnExtension.definition` | Mostly resolved with a conservative validator. Docs should better state the accepted grammar. |
| Context assembly fixed 100 ceiling and coverage count | Resolved. Fetch limit expands from budget; coverage has total/fetched/included. |
| Cross-namespace graph traversal pinned to original namespace | Resolved for recursive traversal. Remaining issue: source assertion validity is not checked. |
| `findPath(id, id)` for missing endpoints | Resolved. |
| `explain()` vector parity | Partially resolved. Caller embedding validation is shared; vector readiness failures are still notes. |
| Failed setup handle leaks | Resolved by owned-handle cleanup in create/prepare failure paths. |
| `getMissingIndexing()` without sqlite-vec and absent table | Resolved. |
| First-init migration and namespace creation races | Mostly resolved via `BEGIN IMMEDIATE` migrations and conflict-tolerant namespace insert/re-read. |
| Opt-in pluggable reranker | Added, but final score semantics are flawed. |
| Minimal self-citation helper | Resolved. |
| Token budget docs and token counter | Resolved. |
| Dense graph CTE docs | Resolved in README/dev docs. |
| Orphan staging vec0 tables | Resolved with init-time cleanup. |
| Release alpha tagging | Partially resolved in `publishConfig.tag` and Changesets pre mode. Live npm dist-tags not verified. |
| Release metadata consistency | Not fully resolved because `package-lock.json` is stale. |

## Core API Surface Review

### Store creation and lifecycle

Strengths:

- `TragetiStore.create()` is the right high-level entry point.
- Owned database handles are closed on setup/init failure.
- `close()` rejects new tracked operations and waits for admitted tracked operations.
- Cleanup errors are collected and thrown after the store is terminally closed.

Risks:

- Some public methods are sync-in-async and not tracked by `trackOperation()`. In single-threaded JS this is usually fine, but it makes lifecycle semantics less uniform.
- `advanced.closeAssertion()` needs namespace-lock coverage.

### Writing APIs

Strengths:

- Episode, assertion, bundle, link, and citation writes are strongly validated before database writes.
- Duplicate IDs are mapped to typed `ValidationError`s.
- Assertion writes and supersession close are transactional.
- Citation presence and citation episode namespace are non-bypassable.

Risks:

- Link temporal consistency is not enforced.
- Bundle supersession cannot naturally reference another assertion created in the same bundle; if that is intentional, document it.
- `selfCitation()` reduces friction but still relies on callers passing the same assertion ID as the surrounding `writeAssertion()` call.

### Retrieval and scoring

Strengths:

- Hybrid recall is now materially better.
- Query text defaults to safe phrase mode.
- Vector validation covers finite values and dimensions.
- RRF default is a good first-stage fusion default.
- Debug steps and metadata are useful.

Risks:

- Reranker score semantics are misleading.
- Stale comments describe the previous vector-bounded hybrid bug.
- `matchedCount` counts temporal/filter matches before retrieval ranking, which is correct, but main docs understate it.
- `limit * OVERSAMPLE_MULTIPLIER` is still a fixed candidate pool; high-recall applications may need explicit candidate limit knobs for vector and lexical branches separately.

### Context assembly

Strengths:

- Fetch limit expansion and fetched/total/included coverage are a real improvement.
- Built-in formatter token counting can use custom counters.
- Formatters return included assertions, keeping text and metadata aligned.

Risks:

- Third-party formatter output is trusted; malformed `includedCount` or `includedAssertions` can make coverage inconsistent.
- The demos' synthesis adapter does not propagate the new reranker fields.

### Graph APIs

Strengths:

- Strict target temporal filtering and cross-namespace continuation are in place.
- Same-ID missing endpoint behavior is fixed.
- CTE adapter docs now warn about dense graph cost.

Risks:

- Source assertion validity is not checked in traversal.
- Link temporal windows are independent from endpoint windows without a clear contract.
- `getConnected()` returns `[]` for a missing source; that may be acceptable, but the behavior should be documented.

### Indexing and reindexing

Strengths:

- Vectorless namespace behavior is consistently represented.
- `getPendingIndexing()` and `getMissingIndexing()` avoid sqlite-vec unless needed.
- Reindex locks now heartbeat and stale-clean by heartbeat.
- Staging-swap and active-only rebuild behavior is documented and tested.

Risks:

- Namespace locks do not currently cover `advanced.closeAssertion()`.
- In-place reindex remains intentionally risky; docs should keep emphasizing it as a trade-off.

### Schema and migrations

Strengths:

- Future schema versions are rejected.
- FK-toggle migrations fail closed.
- Migrations are serialized with `BEGIN IMMEDIATE`.
- Extension table `createSQL` is restricted to one declared `CREATE TABLE`.
- Column extension definitions are allow-listed.

Risks:

- Extension tables can still encode application-specific FK behavior that `deleteNamespace()` cannot understand unless `referencesNamespace` is configured.
- Stale spec text could confuse contributors about the active version.

## Developer Experience Review

Positive DX:

- The top-level `TragetiStore.create()` path is clear.
- The README now explains vectorless mode, hybrid behavior, citations, context assembly, graph traversal, and reindexing.
- Error classes and stable codes are a strong adopter-facing design.
- Mandatory citations are a strong integrity signal and `selfCitation()` helps onboarding.
- Optional hooks are practical: scorer, reranker, formatter, graph adapter, validators, logger, metrics, middleware, tokenizer, schema extensions.

DX obstacles:

- The public type surface is large and not grouped into beginner/intermediate/advanced tiers in the docs.
- The all-async API over synchronous SQLite is pragmatic but can surprise users expecting non-blocking database work.
- Global ID uniqueness is underdocumented.
- Reranker score semantics will confuse consumers.
- The schema-extension model is powerful but still trusted-code oriented; safer builders would be useful.
- Core does not include real embedding providers or an assertion extraction pipeline, so "first useful production app" still requires significant adopter code.

Recommended DX improvements:

- Add a "minimum viable production setup" guide: vectorless, citations, IDs, backups, writer serialization, retrieval strategy.
- Add a "choosing IDs" section.
- Add a "score semantics" section covering first-stage, rerank, and score components.
- Add runnable examples for reranker, token counter, and schema extension.
- Add a glossary that distinguishes episodes, source documents, assertions, citations, links, trajectory, snapshot, and namespace.

## Demo Review

Current demos are conceptually strong. They show why temporal RAG matters better than toy examples would:

- `alex-place`: evolving personal knowledge with supersession, graph, entity history, grounded answers.
- `know-thyself`: repository evolution, keyframes, trajectory, snapshots, risk queries.
- `big-brother`: multimodal activity capture and goal inference.

Correctness and relevance:

- Demos use real `TragetiStore` flows and offline fixtures, which is good for reproducibility.
- They correctly distinguish source documents from episodes and derive citation excerpts from source material.
- Provider configuration is unusually complete for a demo suite.

Gaps:

- New 0.4.2 APIs are not demonstrated.
- Fixture vectors are explicitly not semantically meaningful; this is documented, but screenshots and outputs should keep reminding users.
- `big-brother` is memorable but may be off-putting for privacy-sensitive professional buyers; consider a neutral alias or framing such as "Activity Timeline" while keeping the existing demo as an internal codename.
- Demos are heavier than a first-run quickstart; add one tiny deterministic demo that writes two assertions and retrieves them.

## Real-World RAG Usefulness

Trageti is valuable where "what was true when?" matters. It is more specialized and more auditable than a plain vector store. Strong fits:

- Evolving support knowledge bases.
- Engineering/project memory.
- Case timelines and incident response.
- Compliance evidence trails.
- Personal/team assistants that must avoid stale facts.
- Source-grounded analytical notebooks.

Current constraints for production adoption:

- It is a storage/retrieval kernel, not a complete ingestion/RAG platform.
- It assumes caller-managed extraction quality.
- It assumes caller-managed writer serialization across processes.
- It has no built-in auth, encryption, backup, or retention story.
- It depends on SQLite and sqlite-vec operational characteristics.
- Graph traversal is intentionally not graph-database scale.

Overall assessment: useful and differentiated, especially if positioned as a temporal assertion/provenance engine rather than a complete RAG product. The remaining P1/P2 issues should be fixed before recommending it as production-ready.

## Additional Overlooked Surfaces

- **ID policy:** document globally unique IDs and recommended prefixing.
- **Clock/time semantics:** `position` is caller-defined numeric time; docs should warn against mixing wall-clock timestamps and sequence numbers in one namespace.
- **Privacy:** citations and assertion content can contain sensitive data; docs should include backup/encryption/redaction guidance.
- **Observability:** metrics/logging exist, but docs should list all log codes and metric names in one place.
- **Adapter contracts:** custom graph adapters must preserve temporal source and target validity once fixed.
- **Result stability:** retrieval determinism should include reranker tie behavior and score semantics.
- **Bulk ingestion:** no public bulk assertion write outside episode bundle; large ingest guidance should state transaction and memory expectations.
- **Schema extensions:** extension read bags are supported, but extension writes are not part of core writers; docs should show the intended pattern for setting extension column values safely.
- **Package release:** lockfile drift should be added to pre-release validation.
- **Spec drift:** add a v0.4.x supplement or keep specs versioned with package alpha releases.

## Recommended Fix Order

1. Fix temporal link/source validity and add graph regression tests.
2. Add namespace-lock enforcement to `advanced.closeAssertion()`.
3. Fix reranker final score semantics and docs.
4. Make `explain()` throw or machine-report vector failures consistently with its documented contract.
5. Update `package-lock.json` to `0.4.2-alpha.0`.
6. Correct stale comments and README/spec drift.
7. Add minimal demos for self-citation, vectorless retrieval, reranker, token counter, and schema extensions.
8. Document global ID policy and multi-tenant guidance.

