# Trageti v0.4.1-alpha.0 Code Review - API Surface and Mechanics

Date: 2026-06-21

Scope: current checked-out `trageti` source, focused on the public API surface and the storage, validation, indexing, graph, retrieval, and migration mechanics behind it. This review looked for genuine correctness, data-integrity, retrieval-validity, developer-experience, and security risks. Historical review files were used only as context; findings below are limited to risks still supported by the current source.

Verdict: request changes before promoting this alpha.

## Summary

The current branch has addressed several v0.4.0 review issues: bundle validators now run, supersession closes are guarded, namespace-indexing leakage is fixed, tokenizer and custom PRAGMA inputs are validated, graph hydration is batched, context assembly forwards retrieval filters, and sqlite-vec probing is cached.

The remaining highest-impact flaws are in graph temporal semantics and migration/version safety. Graph expansion and `getConnected()` filter links by time but hydrate linked assertions by ID with no assertion-validity predicate, so future or expired assertions can be returned as context for a temporal anchor where they are not valid. The fix should keep the API strict by default rather than adding a new temporal-distance escape hatch: normal graph expansion should only attach assertions valid at the anchor, while intentional history/audit workflows can use existing historical surfaces. The migration runner also silently accepts databases whose recorded schema version is newer than this package understands.

## Findings

| Priority | Finding | Location |
| --- | --- | --- |
| P1 | Graph expansion can attach assertions that are not valid at the retrieval anchor. | `src/pipeline/retrieve.ts:488`, `src/pipeline/retrieve.ts:500` |
| P1 | `getConnected()` can return future or expired assertions because traversal filters only links, then hydrates assertions by ID. | `src/defaults/graph/CTEGraphAdapter.ts:72`, `src/pipeline/graph.ts:59` |
| P1 | The migration runner does not reject a database with a future schema version. | `src/db/migrations/runner.ts:33` |
| P2 | Namespace operation locks can be cleared while the owning operation is still running. | `src/store/TragetiStore.ts:1632`, `src/store/TragetiStore.ts:1650` |
| P2 | Embeddings and query vectors are checked only for length, not finite numeric values. | `src/store/TragetiStore.ts:611`, `src/pipeline/retrieve.ts:276`, `src/defaults/providers/RawVectorProvider.ts:21` |
| P2 | The public `requiresForeignKeyToggle` migration flag is exposed but ignored by the runner. | `src/db/migrations/runner.ts:43` |
| P3 | Mixed-case schema extension columns are lower-cased in the extension cache, which can make extension bags lose values. | `src/db/schema/extensions.ts:10`, `src/db/repositories/AssertionRepository.ts:285` |
| P3 | `initNamespace(..., { config })` silently ignores config updates for existing namespaces. | `src/db/repositories/NamespaceRepository.ts:53` |

## Details

### P1: Graph expansion can attach temporally invalid assertions

`retrieve({ expandLinks: true })` asks the graph adapter for valid links, then loads each target with `ctx.assertionRepo.getById(link.toId)`. That hydration ignores `query.temporalAnchor`, `includeSuperseded`, and assertion `validFrom` / `validUntil`.

The result can include linked assertions that were not yet true at the anchor or were already superseded at the anchor. This contaminates assembled context and citations with claims outside the requested temporal snapshot. It is especially easy to create because `writeLink()` validates link endpoints exist, but it does not require the link window to be contained within either endpoint assertion's validity window.

Primary fix:

- Add an assertion temporal predicate during graph expansion hydration.
- For same-namespace links, fetch target assertions with `valid_from <= temporalAnchor` and, unless `includeSuperseded`, `(valid_until IS NULL OR valid_until > temporalAnchor)`.
- For permitted cross-namespace links, apply the same predicate in the target assertion's own namespace.
- Treat `includeSuperseded: true` as a past/closed-data relaxation only: it may include links and target assertions whose `validUntil <= temporalAnchor`, but it must still exclude future target assertions where `validFrom > temporalAnchor`.
- Do not add a "temporal distance" or "nearby validity" option for v0.4.1. Such an option would need to define distance across link windows, source assertion windows, target assertion windows, and every hop in a path; that ambiguity is too risky for prompt-context retrieval.
- Add tests where a valid link points to a future target and an expired target; neither should appear under default graph expansion.

Alternative A: enforce link windows at write time so a link cannot be valid outside both endpoint assertion windows. This prevents new bad edges and makes traversal cheaper, but it breaks existing data that has broad link windows and still does not protect against direct DB writes or legacy rows.

Alternative B: keep returning the link but decorate it with no target assertion when the target is not valid. This preserves graph topology but makes `linkedAssertions` less surprising only if a separate `linkedEdges` surface is added.

Alternative C: add a flag or depth-like temporal tolerance that allows linked targets outside their validity window. This is not recommended for the current release. The strong use cases are real, but they are history/audit/topology workflows rather than default RAG-context workflows. Existing API paths are better fits: use `includeSuperseded: true` for past/closed material, `mode: 'trajectory'` for replacement history, `getEntityHistory()` / `getEntityTrajectory()` for entity-level history, `findPath()` for link topology, or rerun retrieval at the temporal anchor where the linked target is valid.

### P1: `getConnected()` returns assertions without temporal validation

The default graph adapter filters `trageti_links` by link namespace and link temporal validity. It never joins `trageti_assertions` for endpoint temporal validity. The public wrapper then calls `assertionRepo.getByIds(ids)`, which fetches every target ID regardless of validity at `options.temporalAnchor`.

This means `store.getConnected({ temporalAnchor: 1 })` can return an assertion whose `validFrom` is 10 if a link row has `validFrom <= 1`. It can also return a target whose `validUntil <= anchor` even when `includeSuperseded` is false. That violates the temporal API promise more directly than the retrieval case because `getConnected()` itself is a public temporal traversal method.

Primary fix:

- Add a repository method such as `getByIdsValidAt(ids, anchor, { includeSuperseded })`.
- Use it from `getConnected()` and retrieval graph expansion.
- Preserve cross-namespace traversal by validating per assertion row, not by forcing `assertion.namespace === traversal.namespace`.
- Keep future assertions excluded even when `includeSuperseded` is true; "superseded" should mean already-known historical material, not assertions that became true after the requested anchor.

Alternative A: push assertion-validity joins into `CTEGraphAdapter`. This prunes invalid paths earlier and avoids returning links that traverse through invalid nodes. Trade-off: it expands the adapter contract from "edge traversal" toward "edge plus node validity", and third-party adapters need clearer requirements.

Alternative B: document that graph traversal is link-temporal only. This is not recommended because the public options are named with `temporalAnchor`, and `expandLinks` is used to build LLM context where invalid assertions are high-impact.

Alternative C: introduce a graph-specific `temporalTolerance` or `graphTemporalMode`. Defer this unless real callers cannot express their workflow through current APIs. A future design should be explicit, for example separating "strict context retrieval" from "historical graph inspection", rather than using numeric distance that can be interpreted multiple ways.

### P1: Future schema versions are accepted silently

`MigrationRunner.applyMigrations()` reads the current max version and skips every known migration with `migration.version <= current`. If `trageti_schema_version` contains version `99` and this package only knows versions `1..2`, initialization proceeds without a compatibility error. The store then uses old repositories and assumptions against a database that may have a newer, incompatible schema.

Primary fix:

- Compute `latestKnown = this.migrations.at(-1)?.version ?? 0`.
- If `current > latestKnown`, throw `MigrationCompatibilityError` before any repositories are created.
- Include a recovery message such as "upgrade the trageti package or open with read-only tooling".

Alternative A: allow newer patch-compatible schemas if a metadata table records a compatible API range. This is more flexible, but it requires a new compatibility contract and tests.

Alternative B: attempt read-only degraded mode. This is risky unless every repository is audited to avoid writes and tolerate missing/renamed columns.

Tests:

- Seed `trageti_schema_version` with `latestKnown + 1`; `store.init()` should fail typed.
- Verify `getCurrentSchemaVersion()` can still inspect the version without initializing full store state.

### P2: Stale lock cleanup can break active long-running operations

The namespace-operation lock is persisted in `trageti_namespace_locks`, which is a good direction for multi-connection reindex safety. However, every lock check first deletes locks older than 24 hours based only on `acquired_at`. There is no heartbeat or ownership liveness check. A large reindex with a slow remote embedding provider can exceed 24 hours and still be active; a later write/index/delete call can clear its lock and proceed concurrently.

Primary fix:

- Add `heartbeat_at` to the lock table and update it between provider batches during `reindexNamespace()`.
- Clear stale locks based on missed heartbeats, not original acquisition time.
- Do not clear a lock held by the current owner unless the owner is explicitly releasing it.

Alternative A: remove automatic stale cleanup and require an explicit administrative unlock API. This prevents false unlocks but creates operational burden after process crashes.

Alternative B: make the stale timeout configurable. This helps large deployments but does not solve the core "active owner has no heartbeat" problem.

Tests:

- Simulate a long-running reindex by passing a fake `now` or old lock timestamp while the owner is still active; writes must remain blocked.
- Simulate a crashed lock with no heartbeat update; an explicit recovery path should clear it predictably.

### P2: Vector inputs allow NaN and Infinity

Indexing and retrieval validate vector dimensions, but they do not validate vector element values. `RawVectorProvider.set()` also validates only length. Non-finite numbers can reach sqlite-vec through `embeddingRepo.insert()` or `vec_distance_cosine()`. Depending on sqlite-vec behavior, this can produce raw SQLite errors, undefined ordering, all-NaN distance behavior, or persisted unusable embeddings.

Primary fix:

- Add a shared vector validator that checks positive expected length and every element with `Number.isFinite`.
- Run it for caller-supplied `indexAssertion()` embeddings, `indexBatch()` supplied embeddings, provider-returned embeddings, `RawVectorProvider.set()`, and `query.queryEmbedding`.
- Return typed `IndexingError`, `EmbeddingProviderError`, or `RetrievalInputError` depending on the boundary.

Alternative A: normalize non-finite values to zero. This avoids hard failures but silently changes embedding geometry and can hide upstream provider bugs.

Alternative B: validate only caller-supplied arrays and trust providers. This catches direct API misuse but leaves provider regressions able to corrupt the index.

Tests:

- `indexAssertion('id', [NaN, 0])` rejects typed and does not create an index row.
- Provider returning `Infinity` causes a typed provider/indexing failure.
- `retrieve({ queryEmbedding: [NaN, 0], retrievalStrategy: 'vector' })` rejects before SQL execution.

### P2: `requiresForeignKeyToggle` is ignored

The public `Migration` type includes `requiresForeignKeyToggle`, and `getMigrations()` reports it through the public descriptor surface. The runner, however, always calls `runStandardMigration()` and never branches on that flag. A future migration that sets the flag will still be run inside a normal transaction with foreign keys left on, despite the API contract.

This is not currently breaking because the shipped migrations do not set the flag. It is still a significant maintenance hazard because the public surface says the feature exists.

Primary fix:

- Implement the FK-toggle path or remove/deprecate the flag until it exists.
- If implemented, refuse to run FK-toggle migrations inside an active transaction, toggle `PRAGMA foreign_keys`, run `PRAGMA foreign_key_check`, and record the schema version only after the check passes.

Alternative A: keep all migrations standard and delete the flag from the public interface in the next breaking release. This is simpler and avoids a complex migration mode.

Alternative B: leave the flag as reserved future metadata but make the runner throw if it sees `requiresForeignKeyToggle: true`. That fails closed and prevents accidental misuse.

Tests:

- Add a test-only migration with `requiresForeignKeyToggle: true`; assert the runner either executes the special path correctly or rejects with a typed migration error.

### P3: Mixed-case extension column names can lose read values

`getExistingColumns()` lower-cases every PRAGMA-reported column name before returning it. Repositories later use those cached names to read row properties. If a caller registers a mixed-case extension column such as `ReviewState`, the cache contains `reviewstate`, but the row object key may be `ReviewState`; the extension bag can return `null` even though the database row has a value.

Primary fix:

- Use lower-case only for comparisons against library columns and duplicate detection.
- Preserve the original PRAGMA column name in the returned extension-column cache.

Alternative A: require extension column names to be lower-case. This is simpler but should be enforced at validation time and documented.

### P3: Existing namespace config cannot be updated

`NamespaceRepository.upsert()` accepts `config`, stores it for new namespaces, and silently ignores it when the namespace already exists. The public `initNamespace(namespace, { config })` shape makes it look like callers can update metadata by reinitializing a namespace, but they cannot.

Primary fix:

- Either document config as create-only and add `updateNamespaceConfig()`, or update config on existing namespaces when `options.config` is supplied.

Alternative A: never mutate config through `initNamespace()` to keep initialization idempotent. Trade-off: safer initialization, but the API should make the create-only behavior explicit.

## Suggested Regression Coverage

- Retrieval graph expansion with valid links to future and expired assertions.
- `getConnected()` with the same invalid target windows, plus a cross-namespace link whose target is valid and one whose target is not.
- `includeSuperseded: true` includes past/closed graph targets but still excludes future targets.
- Opening a DB whose `trageti_schema_version` is greater than the latest known migration.
- Long-running reindex lock heartbeat/stale-lock behavior.
- Non-finite vectors from caller input and provider output.
- Test-only migration with `requiresForeignKeyToggle: true`.
- Mixed-case schema extension columns round-trip into `extensions`.

## Suggested Implementation Order

1. Fix graph target temporal filtering in `getConnected()` and retrieval expansion, keeping the existing API strict and documenting historical workarounds rather than adding a temporal-distance option.
2. Add future-schema rejection to the migration runner.
3. Harden vector validation at all input/provider boundaries.
4. Replace acquisition-time stale lock cleanup with heartbeat-based recovery or explicit unlock.
5. Decide whether to implement or reject `requiresForeignKeyToggle`.
6. Clean up extension-column case handling and namespace config semantics.

## Claude Code Cross-Check Addendum

Date: 2026-06-22

After comparing this review with Claude Code's v0.4.1-alpha.0 review, the following additional items are confirmed and should be fixed before promotion:

| Priority | Finding | Resolution |
| --- | --- | --- |
| P1 | `close()` rejects already-admitted in-flight operations after async boundaries because `closing` is treated the same as `closed`. | Reject only new operations during drain; allow tracked operations to finish. |
| P1 | `close()` can leave the store in a `closing` but not `closed` state if middleware disposal, logger flush, or DB close throws. | Always transition to terminal closed state in `finally`; collect cleanup failures and rethrow after cleanup. |
| P2 | Duplicate caller-provided assertion, episode, link, and citation IDs surface raw SQLite constraint errors. | Convert duplicate IDs to typed `ValidationError`s, with repository-level constraint mapping as a race fallback. |
| P2 | Provider-derived query embeddings with wrong dimensions are reported as caller `queryEmbedding` errors. | Validate provider output immediately and throw provider-specific errors. |
| P2 | `getPositionRange()` uses only active assertions, which can distort recency scoring for historical or supersession-heavy namespaces. | Use the full namespace assertion range and update scoring-context documentation accordingly. |
| P2 | Indexing status and reindex scope are inconsistent for active-only vs historical embeddings. | Preserve historical indexing by default, and add explicit active-only indexing/reindex options. |
| P2 | `getMissingIndexing()` throws for vectorless namespaces while `getPendingIndexing()` returns `[]`. | Return `[]` for vectorless namespaces. |
| P3 | Supersession-chain CTEs rely on write validation instead of constraining recursive traversal to one namespace. | Add namespace constraints to recursive chain traversal. |
| P3 | Large vector retrieval candidate sets are serialized through JSON and `json_each(?)`. | Push temporal filtering into vector SQL instead of materializing the full candidate set in JS. |
| P3 | `isSqliteVecLoaded()` caches `false` permanently. | Re-probe when the cached value is `false`; keep caching `true`. |
| Security hardening | Extension table `createSQL` is executed as arbitrary SQL from trusted caller configuration. | Validate it as one `CREATE TABLE IF NOT EXISTS <declared table>` statement before execution. |

Claude Code's stale-embedding finding is valid only as an indexing-contract concern, not as a reason to delete superseded embeddings by default. Superseded embeddings are required for historical vector retrieval and for `includeSuperseded` workflows, so ordinary supersession must not delete them. Active-only cleanup belongs behind an explicit active-only reindex/maintenance option.

The `deleteNamespace()` link-deletion finding is not carried forward. The current split statements intentionally handle same-namespace rows and cross-namespace references separately and are preferable to a broad `OR` delete for clarity and index use.

The FTS tokenizer and vec0 dimension interpolation finding is defense-in-depth only. The values are already validated before interpolation, but final invariant checks at the DDL boundary are still worth adding.

Temporal graph traversal remains strict by default. No temporal-distance or tolerance option should be added for v0.4.1-alpha.0; audit and topology use cases should use explicit historical APIs such as `includeSuperseded`, `mode: 'trajectory'`, entity history/trajectory reads, path inspection, or retrieval at the target-valid anchor.
