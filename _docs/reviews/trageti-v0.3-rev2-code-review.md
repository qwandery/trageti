# Trageti v0.3 Rev2 Code Review

Date: 2026-06-11

Scope: Full repository review of the Trageti v0.3 rev2 library, public API, tests, documentation, release metadata, CI/publish configuration, and alignment with `_docs/specs/trageti-spec-v0.3-rev2.md`.

Verdict: **Request changes before public beta**.

Confidence: **High** for P1/P2 findings with direct code evidence or reproduction; **Medium** for lower-severity design/documentation findings where the correct fix depends on product intent.

## Severity Key

- **P0**: Critical security/data-loss issue.
- **P1**: Release blocker: correctness, integrity, security, or public-contract violation.
- **P2**: Beta-quality issue: significant inconsistency, missing guardrail, misleading docs, or operational risk.
- **P3**: Lower-risk polish or maintainability issue.

## Findings By Severity

| Priority | Focus Area              | Finding                                                                                                                               | Primary Location                                                                                                     |
| -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| P1       | Data integrity          | Custom validators bypass baseline assertion integrity checks                                                                          | `src/store/TragetiStore.ts:261`, `src/store/TragetiStore.ts:1303`                                                    |
| P1       | Temporal integrity      | `advanced.closeAssertion()` accepts `NaN`/`Infinity` `validUntil` values                                                              | `src/store/TragetiStore.ts:437`, `src/store/TragetiStore.ts:448`                                                     |
| P1       | Input safety            | Invalid `queryTextMode` / `retrievalStrategy` / `mode` values are accepted at runtime                                                 | `src/pipeline/retrieve.ts:133`, `src/pipeline/retrieve.ts:280`                                                       |
| P1       | Reindex safety          | Invalid `reindexNamespace({ strategy })` silently selects in-place indexing                                                           | `src/pipeline/reindex.ts:44`, `src/pipeline/reindex.ts:71`                                                           |
| P1       | Reindex/indexing safety | Invalid `onProviderError` silently selects skip-mode behavior                                                                         | `src/store/TragetiStore.ts:551`, `src/pipeline/reindex.ts:45`                                                        |
| P1       | Security / error model  | `indexAssertion()` leaks raw provider errors instead of wrapping them                                                                 | `src/store/TragetiStore.ts:520`                                                                                      |
| P1       | Public validation       | Non-finite temporal anchors are accepted by retrieval, snapshots, graph, and assertion queries                                        | `src/pipeline/retrieve.ts:112`, `src/pipeline/snapshot.ts:10`, `src/defaults/graph/CTEGraphAdapter.ts:46`            |
| P1       | Public validation       | `writeLink()` lets missing `fromId` / `toId` fall through to raw SQLite FK errors                                                     | `src/store/TragetiStore.ts:463`                                                                                      |
| P1       | Release management      | Changesets would publish stable `0.3.0`, not the next beta prerelease                                                                 | `package.json:2`, `.changeset/early-timers-harden.md:1`                                                              |
| P2       | API introspection       | `store.explain()` accepts invalid options and returns plans that `retrieve()` would reject                                            | `src/store/TragetiStore.ts:1209`                                                                                     |
| P2       | Release automation      | PR CI does not enforce the documented coverage gate                                                                                   | `.github/workflows/ci.yml:29`                                                                                        |
| P2       | Release automation      | Publish workflow builds but does not run lint, typecheck, tests, or coverage before publishing                                        | `.github/workflows/publish.yml:24`                                                                                   |
| P2       | Schema extensions       | `ColumnExtension` permits episode/link columns, but only assertion rows expose extension data                                         | `src/domain/types.ts:555`, `src/db/repositories/EpisodeRepository.ts:66`, `src/db/repositories/LinkRepository.ts:17` |
| P2       | Documentation accuracy  | README overstates "full data isolation" while cross-namespace links can traverse into another namespace                               | `README.md:14`, `src/store/TragetiStore.ts:469`                                                                      |
| P2       | Documentation accuracy  | README says vector retrieval requires `queryEmbedding`, omitting the supported `queryText + EmbeddingProvider` vector path            | `README.md:235`, `_docs/specs/trageti-spec-v0.3-rev2.md:2758`                                                        |
| P2       | Release metadata        | Developer docs say `package.json` is set directly to `0.3.0`, but the package is `0.3.0-beta.0`                                       | `_docs/dev/README.md:553`, `package.json:2`                                                                          |
| P2       | Context assembly        | `JsonFormatter` budgets compact JSON but emits pretty JSON, so `tokenEstimate` can understate rendered output                         | `src/defaults/formatting/JsonFormatter.ts:40`, `src/defaults/formatting/JsonFormatter.ts:51`                         |
| P2       | Context assembly        | `StructuredFormatter` can render an empty section header when no assertion in that group fits                                         | `src/defaults/formatting/StructuredFormatter.ts:46`, `src/defaults/formatting/StructuredFormatter.ts:67`             |
| P2       | Error consistency       | `ValidationError` always says "Assertion validation failed", even for episodes, links, namespaces, FTS rebuilds, and close operations | `src/errors/index.ts:111`                                                                                            |
| P2       | Public validation       | Runtime callers can pass malformed filter arrays and get raw `TypeError`s or incoherent behavior                                      | `src/pipeline/retrieve.ts:546`, `src/defaults/graph/CTEGraphAdapter.ts:51`                                           |
| P3       | Documentation hygiene   | Changelog mixes current rev2 scorer text with older v0.2 scorer migration text that now reads as current guidance                     | `CHANGELOG.md:67`, `CHANGELOG.md:251`                                                                                |
| P3       | Maintainability         | `EpisodeRepository` builds an `extensions` object that is never returned                                                              | `src/db/repositories/EpisodeRepository.ts:66`                                                                        |
| P3       | Observability typing    | `RetrievalStepInfo.notes` is typed as a record, while explain-step notes are string arrays; the split is easy to misuse               | `src/domain/types.ts:172`, `src/domain/types.ts:282`                                                                 |

## Detailed Findings

### 1. P1 - Custom Validators Bypass Baseline Assertion Integrity

**Focus area:** Data integrity / validation architecture

The rev2 spec states that structural invariants cannot be bypassed by replacing validators; custom validators are domain validators that run after library integrity checks. The implementation only installs `DefaultAssertionValidator` when the user supplies no validators:

```ts
if (this.options.validators.length === 0) {
  this.options.validators.push(new DefaultAssertionValidator(...));
}
```

`TragetiStore.enforceStructuralInvariants()` covers citation presence, citation episode namespace, and supersession checks, but it does not cover all baseline checks still housed in `DefaultAssertionValidator`: required assertion strings, finite `validFrom`, finite/ordered `validUntil`, `confidence` range, and `sourceEpisodeId` existence in the same namespace.

I reproduced this with a permissive custom validator: an assertion in namespace `a` could store `sourceEpisodeId` from namespace `b`, and invalid numeric fields fell through to raw SQLite errors instead of typed library validation.

**Impact:** Replacing validators can create cross-namespace assertion provenance and lets malformed numeric inputs reach SQLite. This violates the spec and weakens the central data-integrity boundary.

**Suggested fix:** Always run a non-replaceable built-in integrity validator before custom validators, or move the remaining baseline checks into `enforceStructuralInvariants()`. Keep custom validators additive only. Add tests with a permissive custom validator.

### 2. P1 - `closeAssertion()` Accepts Non-Finite `validUntil`

**Focus area:** Temporal integrity

`advanced.closeAssertion()` only checks `validUntil <= existing.validFrom`. `NaN` fails that comparison and proceeds to the update; `Infinity` passes and is stored.

Observed behavior:

- `validUntil: NaN` resolves successfully while leaving `validUntil` effectively `null`.
- `validUntil: Infinity` stores a non-null value that marks the row closed, but it remains valid for every finite temporal anchor.

**Impact:** The no-replacement close escape hatch can silently no-op or create a never-expiring "closed" assertion.

**Suggested fix:** Reject non-finite values with `ValidationError` before comparison/update, using the same `finiteNumberError()` pattern used elsewhere.

### 3. P1 - Invalid Retrieval Union Values Are Accepted At Runtime

**Focus area:** Input safety / JavaScript boundary

The public TypeScript union types do not protect JavaScript consumers. `retrieve()` accepts arbitrary strings for `retrievalStrategy`, `queryTextMode`, and `mode`.

Concrete risks:

- Any `queryTextMode` other than `'phrase'` is treated like raw FTS5 because the code only checks `queryTextMode === 'phrase'`.
- Invalid `retrievalStrategy` values are reported back in `meta.retrievalStrategy` and otherwise behave like a hybrid-ish query.
- Invalid `mode` silently behaves like snapshot mode.

**Impact:** A malformed runtime input can bypass the safe phrase-mode default and expose raw FTS5 semantics without explicitly choosing `queryTextMode: 'fts5'`.

**Suggested fix:** Add runtime enum validation for `retrievalStrategy`, `queryTextMode`, and `mode` before routing. Throw `RetrievalInputError` with a stable code and generic message.

### 4. P1 - Invalid Reindex Strategy Silently Selects In-Place Indexing

**Focus area:** Reindex safety

`reindexNamespace()` defaults `strategy` to `'staging-swap'`, but the implementation only checks for that exact string:

```ts
if (strategy === 'staging-swap') {
  // safe staging path
} else {
  // in-place path
}
```

Any invalid runtime value, such as `{ strategy: 'staging' }`, goes down the in-place branch.

**Impact:** A malformed option can silently bypass the safe default and choose the destructive/partial-indexing mode that the spec describes as an explicit tradeoff.

**Suggested fix:** Validate `strategy` against `'staging-swap' | 'in-place'` before DDL or provider calls. Invalid values should throw `ReindexError` or `ValidationError` before side effects.

### 5. P1 - Invalid `onProviderError` Silently Selects Skip Mode

**Focus area:** Reindex/indexing safety

`indexBatch()` and `reindexNamespace()` both treat every `onProviderError` value other than `'fail-fast'` as skip mode:

```ts
if (mode === 'fail-fast') {
  ...
} else {
  // skip behavior
}
```

**Impact:** A misspelled option changes failure semantics from fail-fast to partial/skip behavior. For reindexing, that interacts with partial-swap behavior and can change whether provider failures preserve or replace the live index.

**Suggested fix:** Validate `onProviderError` against `'fail-fast' | 'skip'` in both code paths before any indexing work starts.

### 6. P1 - `indexAssertion()` Leaks Raw Provider Errors

**Focus area:** Security / error model

`indexBatch()`, `reindexNamespace()`, and query-embedding retrieval wrap provider failures in `EmbeddingProviderError` and sanitize messages. `indexAssertion()` directly awaits `provider.embed()` without a try/catch.

I reproduced this with a provider throwing `Error('SECRET query text')`: the raw error name, code, and message propagated to the caller.

**Impact:** Provider errors can contain source text, prompts, upstream response bodies, API identifiers, or secrets. The single-assertion index path violates the sanitization policy applied elsewhere.

**Suggested fix:** Wrap provider failures in `EmbeddingProviderError(provider.name, 0, err)` and keep the original error only as `cause`.

### 7. P1 - Non-Finite Temporal Anchors Are Accepted

**Focus area:** Public validation / temporal correctness

`retrieve()`, `getTemporalSnapshot()`, `getAssertions({ validAt })`, `getConnected()`, and `findPath()` do not validate temporal anchors as finite numbers. I reproduced `NaN` inputs returning empty results or zero-hop graph results instead of typed errors.

**Impact:** A malformed temporal anchor can produce empty or misleading query results and, in retrieval metadata, `NaN` serializes to `null` in JSON. This undermines auditability for a temporally-aware library.

**Suggested fix:** Add finite-number validation for `temporalAnchor`, `atPosition`, and `validAt` on every public read path before SQLite execution.

### 8. P1 - `writeLink()` Missing Endpoint Validation Falls Through To SQLite

**Focus area:** Public validation / error model

`writeLink()` validates link field shapes and source episode namespace, but it does not reject missing `fromId` or `toId` with a typed `ValidationError`. If either endpoint is absent, the insert hits SQLite foreign-key enforcement and throws `SqliteError: SQLITE_CONSTRAINT_FOREIGNKEY`.

**Impact:** Public invalid input reaches SQLite, contradicting the v0.3 public-input validation goal.

**Suggested fix:** Check that `fromId` and `toId` exist before insert. Decide explicitly whether each must be in `link.namespace` or whether cross-namespace links remain permitted with the warning.

### 9. P1 - Release Would Publish Stable `0.3.0`, Not Beta

**Focus area:** Release management

`package.json` is currently `0.3.0-beta.0`, but Changesets is not in pre-mode. `npx changeset status --verbose` reports the next release as `trageti 0.3.0`, driven by normal `minor` changesets.

`publishConfig.tag: "beta"` only controls npm dist-tag; it does not make the semver version a prerelease. Publishing stable `0.3.0` under the beta dist-tag would consume the final `0.3.0` version.

**Suggested fix:** Enter Changesets pre-mode (`changeset pre enter beta`) or otherwise convert the next release to `0.3.0-beta.1`. If stable `0.3.0` is intentional, align package metadata, docs, and release notes around that decision.

### 10. P2 - `store.explain()` Returns Plans For Invalid Queries

**Focus area:** API introspection

`explain()` advertises a validate step, but it does not run the same validation as `retrieve()`. I reproduced successful explain output for invalid `limit: 0`, bad `maxDepth`, inverted temporal windows, and invalid `retrievalStrategy`.

**Impact:** Tooling can show a plan for a query that would fail at execution time. That weakens explain as a safe production tuning API.

**Suggested fix:** Share retrieval input validation between `explain()` and `retrieve()`, or have `explain()` explicitly report validation failures in a typed way.

### 11. P2 - CI Does Not Enforce Coverage

**Focus area:** Release automation

The spec requires 95/95/95/85 coverage thresholds. `vitest.config.ts` enforces them, and `npm run test:coverage` currently passes, but the CI workflow does not run that command. A PR can merge while lowering coverage below the documented threshold.

**Suggested fix:** Add `npm run test:coverage` to CI, possibly on only one Node version to control runtime.

### 12. P2 - Publish Workflow Does Not Run The Full Gate

**Focus area:** Release automation

The publish workflow runs `npm ci`, `npm run build`, then `changesets/action`. It does not run lint, typecheck, unit tests, integration tests, or coverage before publishing. The package has a `prepublishOnly` script, but relying on lifecycle behavior inside automated publishing is weaker and less visible than making the workflow gate explicit.

**Suggested fix:** Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run test:coverage` before the Changesets publish step, or replace the build step with `npm run prepublishOnly`.

### 13. P2 - Schema Extension Column Surface Is Incomplete

**Focus area:** Schema extensions / API design

`ColumnExtension.table` allows `trageti_assertions`, `trageti_episodes`, and `trageti_links`. Only `Assertion` has a public `extensions` bag and only `AssertionRepository` returns it. `EpisodeRepository` computes an `extensions` object but discards it; `LinkRepository` has no extension-column awareness.

**Impact:** The type surface advertises custom columns on all three library tables, but consumers can only observe assertion extension columns through public objects.

**Suggested fix:** Either limit `ColumnExtension.table` to supported read surfaces for v0.3, or add extension bags and repository support for episodes and links.

### 14. P2 - README Overstates Namespace Isolation

**Focus area:** Documentation accuracy

README claims "full data isolation" for namespaces. The implementation permits cross-namespace links, emits `TRGT_CROSS_NAMESPACE_LINK`, and `getConnected()` can hydrate an assertion from another namespace when a link points there.

**Impact:** Consumers may assume namespace-scoped graph reads can never return data from another namespace. That is not true today.

**Suggested fix:** Replace "full data isolation" with a narrower claim, such as isolated namespace storage and embedding tables, and document the cross-namespace link behavior.

### 15. P2 - README Misstates Vector Retrieval Inputs

**Focus area:** Documentation accuracy

README says `retrievalStrategy: 'vector'` "requires `queryEmbedding`". The spec and implementation also support `retrievalStrategy: 'vector'` with `queryText` when an `EmbeddingProvider` is configured; Step 0 derives the query embedding and vector retrieval proceeds.

**Suggested fix:** Update README to say vector retrieval requires either a supplied `queryEmbedding` or `queryText` plus a configured provider.

### 16. P2 - Developer Docs Version Statement Is Stale

**Focus area:** Release metadata

`_docs/dev/README.md` says "`package.json` is at `0.3.0`, set directly." The actual package version is `0.3.0-beta.0`, and Changesets is active.

**Impact:** This conflicts with the current beta release process and can cause maintainers to make the wrong versioning change.

**Suggested fix:** Align the dev guide with the intended beta process and Changesets pre-mode decision.

### 17. P2 - `JsonFormatter` Underestimates Rendered Token Usage

**Focus area:** Context assembly

`JsonFormatter` estimates each item using compact `JSON.stringify(payload)`, then emits the final array with `JSON.stringify(..., null, 2)`. Pretty-print whitespace can make the rendered context materially longer than the estimate.

**Impact:** `tokenEstimate` can underreport the actual rendered output, and `tokenBudget` is less trustworthy for JSON contexts.

**Suggested fix:** Estimate with the same serialized representation that is emitted, or emit compact JSON when budgeting compact JSON.

### 18. P2 - `StructuredFormatter` Can Render Empty Sections

**Focus area:** Context assembly

`StructuredFormatter` checks whether a section header fits before checking whether any bullet in that section fits. If the header fits but the first assertion does not, it pushes an empty section header and reports `includedCount: 0`.

**Impact:** Context text can contain category headings with no evidence underneath, which is poor input for downstream generation and makes coverage harder to interpret.

**Suggested fix:** Only emit a section after at least one assertion bullet has been accepted, or include the header cost in a provisional buffer that is discarded if no item fits.

### 19. P2 - `ValidationError` Message Is Assertion-Specific For Non-Assertion Failures

**Focus area:** Error consistency

`ValidationError` always formats its message as `Assertion validation failed`, but the same class is used for episodes, links, `closeAssertion()`, `rebuildFts()`, namespace upgrade validation, and other public options.

**Impact:** The stable code is still usable, but messages are misleading for operators and test failures outside assertion writes.

**Suggested fix:** Allow `ValidationError` to accept an optional context label, defaulting to a neutral "Validation failed".

### 20. P2 - Malformed Runtime Filter Arrays Are Not Guarded

**Focus area:** Public validation / JavaScript boundary

`retrieve()` assumes `entityTypes` and `assertionTypes` are arrays when a truthy object with `length` is supplied; graph traversal assumes `linkTypes` supports `.map()`. TypeScript callers are protected, but JavaScript consumers can pass strings or array-like objects and get raw `TypeError`s or invalid SQL parameter behavior.

**Impact:** Public malformed options are not consistently rejected before SQLite or pipeline execution.

**Suggested fix:** Validate array-valued options with `Array.isArray()` and validate element types as strings.

### 21. P3 - Changelog Contains Stale Scorer Guidance

**Focus area:** Documentation hygiene

The top of `CHANGELOG.md` correctly documents the rev2 batch-only scorer contract and RRF default. Later historical text still describes `RetrievalScorer.scoreBatch` as optional and says custom scorers without it keep working via a per-candidate fallback.

**Impact:** The file mixes historical v0.2 migration notes with current release notes. Readers scanning the changelog may follow stale scorer guidance.

**Suggested fix:** Mark older sections explicitly as historical, or add a short note that rev2 supersedes the optional `scoreBatch` text.

### 22. P3 - Dead Extension Object In `EpisodeRepository`

**Focus area:** Maintainability

`EpisodeRepository.rowToEpisode()` builds an `extensions` object from extension columns, but `Episode` has no `extensions` field and the function returns no such data.

**Impact:** This is harmless at runtime but indicates the episode extension-column surface is unfinished or partially removed.

**Suggested fix:** Remove the dead block if episodes are not meant to expose extension data, or complete the API as described in finding 13.

### 23. P3 - Retrieval Step Notes Use Two Incompatible Shapes

**Focus area:** Observability typing

`RetrievalStepInfo.notes` is typed as `Record<string, unknown>`, while `RetrievalExplainStep.notes` is `string[]`. The names are close enough that extension authors can reasonably expect the same semantics.

**Impact:** Low runtime risk, but the observability API is less coherent than it should be for a beta public contract.

**Suggested fix:** Rename one field or align the note payload shape across debug and explain surfaces.

## Validation Performed

The following commands were run during the review:

- `npm.cmd run lint` - passed.
- `npm.cmd run typecheck` - passed.
- `npm.cmd test` - passed: 46 test files, 508 tests.
- `npm.cmd run build` - passed.
- `npm.cmd run test:coverage` - passed: 95.14% statements/lines, 88.92% branches, 98.78% functions.
- Focused Node scripts reproduced the validator-bypass, non-finite temporal input, invalid enum option, raw link FK error, raw provider error, `explain()` validation, and cross-namespace README mismatch behaviors.

## Recommendation

Fix the P1 findings before public beta. The highest-leverage implementation work is to centralize runtime public-input validation, make built-in integrity checks non-bypassable, and harden provider/reindex error semantics. In parallel, decide the beta versioning policy and make CI/publish enforce the same release gate humans are using locally.

## Additional Testing Observations And Proposals

Date: 2026-06-18

Scope: Follow-up review of the current unit, integration, and E2E test shape to identify meaningful integration paths and end-to-end scenarios that should be covered before the public beta. The current test suite already has strong coverage for many narrow behaviors, including retrieval validation, temporal filtering, supersession, citations, schema-extension validation, graph traversal, vectorless namespaces, reindexing, middleware, and a basic full happy path. The proposals below focus on integration boundaries that are either untested or only indirectly tested.

### Integration Test Proposals

| Priority | Focus Area                           | Proposed Test                                                                                                                                                                                                                                                                                                                            | Why It Matters                                                                                                                                                                        |
| -------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Public package surface               | Add an integration smoke test that imports from the public package entrypoint rather than internal `src/...` paths, exercises `TragetiStore.create()`, `prepareDatabase()`, default formatters/scorers/providers, and exported error classes. Prefer testing both ESM import and the built package artifact in CI after `npm run build`. | Most tests currently import internal source modules. A public beta needs assurance that `exports`, generated declarations, CJS/ESM output, and documented imports work for consumers. |
| P1       | Runtime input boundary               | Add JavaScript-style integration tests that deliberately cast malformed values into public APIs: retrieval enums, temporal anchors, filter arrays, reindex/index modes, graph `linkTypes`, snapshot filters, and `getAssertions({ validAt })`.                                                                                           | TypeScript unions do not protect JavaScript consumers. This should prove all public input guards fail with typed Trageti errors before SQLite/provider work.                          |
| P1       | Schema extension read surface        | Add store-level integration tests for extension columns on `trageti_assertions`, `trageti_episodes`, and `trageti_links`, including reopen behavior and graph/path link results once link hydration is implemented.                                                                                                                      | Low-level extension DDL is tested, but beta consumers need confidence that configured extension columns are discoverable through public read models across fresh and reopened stores. |
| P1       | File-backed persistence with vectors | Add a file-backed lifecycle test that writes assertions, indexes vectors, closes, reopens, retrieves by BM25/vector/hybrid, checks `getPendingIndexing()`, and runs `reindexNamespace()`.                                                                                                                                                | Current file-backed lifecycle coverage is BM25-focused. Vector table metadata, vec0 table existence, and cache warming across reopen are higher-risk integration seams.               |
| P1       | Reindex atomicity and recovery       | Add a staging-swap recovery test where an existing complete index is in place, a reindex provider fails mid-run, the old index remains queryable, and a second reindex succeeds. Include skipped/partial-swap behavior.                                                                                                                  | Reindexing is one of the most stateful operations. Tests should prove failure paths preserve the previous live index and recovery is straightforward.                                 |
| P2       | Custom extension interfaces          | Add integration tests for custom `GraphQueryAdapter`, custom `IRetrievalScorer`, custom `ContextFormatter`, custom `ConnectionVerifier`, custom `Logger`, and custom `Metrics` used through `TragetiStore`, not just unit-level helpers.                                                                                                 | These are advertised enterprise extension points. The suite should prove they compose with the store lifecycle and public retrieval/context APIs.                                     |
| P2       | Metrics and structured logging       | Add integration tests that attach a metrics sink and structured logger, then assert expected events/counters for retrieve, indexBatch, reindex, cross-namespace link warning, missing-citation warning, and debug-hook error shielding.                                                                                                  | Observability is part of the public operational contract, but most tests verify behavior rather than emitted telemetry.                                                               |
| P2       | Store close and operation lifecycle  | Add tests where `close()` is called while a provider-backed retrieve/index/reindex is in flight, and where concurrent `reindexNamespace()` calls target the same namespace.                                                                                                                                                              | The store has in-flight operation tracking and reindex locks. These concurrency/lifecycle guarantees are not fully exercised by synchronous happy paths.                              |
| P2       | External database ownership          | Add tests for `TragetiStore.create({ database: existingDb })` and `closeDatabaseOnStoreClose` true/false, verifying whether the caller-owned `better-sqlite3` handle remains usable or is closed as documented.                                                                                                                          | Database ownership is a subtle integration contract and easy for consumers to get wrong.                                                                                              |
| P2       | Namespace deletion completeness      | Expand delete tests to combine extension-table cascade, vector table removal, inbound/outbound cross-namespace links, citations, assertions, episodes, namespace metadata, and cache behavior after deletion.                                                                                                                            | Current delete coverage is partial. Namespace deletion is destructive and should prove all related storage is cleaned up without deleting unrelated namespaces.                       |
| P2       | Tokenizer rebuild and reopen         | Add a file-backed test that changes FTS tokenizer on an empty database, writes data, reopens with a different tokenizer and expects compatibility failure, then explicitly `rebuildFts()` and verifies BM25 behavior.                                                                                                                    | Existing tokenizer tests cover important slices, but an end-to-end reopen/rebuild path would better protect the stored-tokenizer contract.                                            |
| P2       | Provider signal propagation          | Add integration tests that assert `AbortSignal` reaches provider calls for `indexAssertion()`, `indexBatch()`, `retrieve()` Step 0, `assembleContext()`, and `reindexNamespace()`.                                                                                                                                                       | Cancellation is an API promise across several async provider paths, and only some paths are currently asserted directly.                                                              |
| P3       | Public type compile fixtures         | Extend the existing type compile fixture to cover custom adapters/scorers/formatters/validators, `TragetiStore.create()`, schema extensions, and the planned episode/link extension read models.                                                                                                                                         | This catches public declaration regressions that runtime tests cannot see.                                                                                                            |

### End-To-End Scenario Proposals

1. **Public package consumer journey.** Build the package, import from the package entrypoint, create a file-backed store, write episodes/assertions/citations/links, index via an embedding provider, run BM25/vector/hybrid retrieval, assemble context, close, reopen, and verify the same reads still work. This is the closest approximation of a beta consumer's first successful integration.

2. **Vectorless-to-vector namespace evolution.** Start with a vectorless namespace using BM25-only retrieval, accumulate assertions, upgrade the namespace with a provider, index pending assertions, run hybrid retrieval, close/reopen, then reindex with staging-swap. This covers the intended migration path for users who begin without embeddings.

3. **Temporal drift and auditability.** Model an entity whose assertions change over several episodes, with citations on each assertion, supersession chains, layered non-superseding links, snapshots at multiple anchors, trajectory retrieval, and context assembly. Assertions should prove that every generated context item remains tied to the correct temporal state and citation.

4. **Schema-extension application workflow.** Register assertion, episode, link, and namespace-referencing extension table metadata; write data; mutate extension-column values through SQL; retrieve assertions/episodes/paths; delete the namespace with cascade; and verify extension-table cleanup. This covers the advertised extension surface as an application would use it.

5. **Failure and recovery workflow.** Build a complete vector index, simulate provider failures during single indexing, batch indexing, query embedding, and reindexing; assert sanitized errors/skips; verify the old index remains usable after failed staging reindex; then swap successfully on retry. This protects the operational recovery story.

6. **Custom extension-point workflow.** Run one scenario using a custom validator, scorer, formatter, graph adapter, middleware, logger, and metrics sink together. Assert call order, typed outputs, telemetry, and final retrieval/context behavior. This would catch integration bugs between extension points that isolated unit tests miss.

7. **Cross-namespace graph workflow.** Create two namespaces with isolated embeddings but an explicit cross-namespace link, verify the warning, retrieve connected assertions across the link, delete one namespace, and verify dangling/inbound/outbound links are cleaned up while the other namespace remains valid. This makes the documented "isolated storage, permitted cross-namespace links" model concrete.

8. **Runtime JavaScript misuse workflow.** From a JS-facing test (or TS with `as unknown as` casts), pass invalid option values across the full public surface and assert every failure is typed, stable, and sanitized. This should include values that previously fell through to SQLite, raw FTS5, or provider errors.
