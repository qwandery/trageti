# Trageti v0.4.1-alpha.1 Codex Code Review

Date: 2026-06-24

Scope: public API surface and underlying mechanics for data integrity, temporal validity, write/retrieval correctness, vector/indexing behavior, lifecycle, schema/migration safety, developer experience, and security-relevant risks.

Method: reviewed over six passes:

1. Public API, exports, README/spec contract, and runtime boundary validation.
2. Write paths, repository inserts, FK/reference validation, supersession, citations, links, and namespace deletion.
3. Retrieval, temporal predicates, graph expansion/path traversal, scoring, vector selection, and context assembly.
4. Indexing/reindexing, vector readiness, sqlite-vec boundaries, and indexing-state APIs.
5. Migrations, schema extensions, DDL interpolation, PRAGMA handling, tokenizer validation, and namespace locks.
6. Re-verification against the v0.4.1-alpha.0 findings to separate fixed issues from newly observed or still-open issues.

External references used where the review touches security or SQL/DDL best practices:

- OWASP SQL Injection Prevention Cheat Sheet: prepared statements and allow-list validation for dynamic SQL fragments that cannot be parameterized. <https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html>
- SQLite `ALTER TABLE ADD COLUMN` grammar and restrictions. <https://www.sqlite.org/lang_altertable.html>

## Findings

| Severity | Finding | Primary locations |
| --- | --- | --- |
| P1 / Security | `ColumnExtension.definition` is still raw executable DDL despite the new `createSQL` hardening. | `src/db/schema/extensions.ts:102`, `src/domain/types.ts:603`, `README.md:450` |
| P2 | Cross-namespace graph traversal is documented as traversable, but multi-hop traversal remains pinned to the original link namespace. | `README.md:405`, `src/defaults/graph/CTEGraphAdapter.ts:89`, `src/pipeline/retrieve.ts:503` |
| P2 | `findPath()` returns a successful zero-hop path for nonexistent assertion IDs. | `src/defaults/graph/CTEGraphAdapter.ts:142`, `src/pipeline/graph.ts:69` |
| P2 | `explain()` does not model `retrieve()` vector-readiness and vector-shape failures for caller-supplied query embeddings. | `src/store/TragetiStore.ts:1394`, `src/store/TragetiStore.ts:1408`, `src/pipeline/retrieve.ts:276` |
| P2 | File-backed database handles opened by `prepareDatabase()` / `TragetiStore.create()` can leak when setup fails. | `src/defaults/connection/prepareDatabase.ts:30`, `src/store/TragetiStore.ts:212` |
| P2 | `getMissingIndexing()` unnecessarily requires sqlite-vec when the vec0 table has not been created yet. | `src/store/TragetiStore.ts:1115`, `src/store/TragetiStore.ts:1866` |

## Detailed Findings

### P1 / Security: Raw column extension definitions remain executable DDL

`SchemaExtensionApplier.validateCreateTableSql()` now rejects multi-statement or wrong-table `createSQL`, but column extensions still use:

```ts
db.exec(`ALTER TABLE ${quoteIdent(col.table)} ADD COLUMN ${quoteIdent(col.column)} ${col.definition}`);
```

The table and column identifiers are quoted, but `col.definition` is a caller-controlled SQL fragment. The public type describes it as "SQL column definition: type + optional DEFAULT + optional CHECK" (`src/domain/types.ts:607`), and the v0.3 rev2 spec says raw schema SQL is trusted code, not tenant/user configuration. However, the current README "Schema extensions" section shows the feature without a clear trusted-code warning and lists constraints that do not mention raw DDL risk (`README.md:450-490`).

Why this matters:

- OWASP recommends parameterized queries where possible and allow-list validation for dynamic SQL parts that cannot use bind variables, such as identifiers or other query-structure fragments.
- SQLite `ALTER TABLE ADD COLUMN` has a defined `column-def` grammar and restrictions. Trageti can validate against that narrower grammar instead of accepting an arbitrary suffix.
- In products that expose Trageti schema extensions through admin UI, plugin manifests, tenant configuration, or AI-generated config, this is an SQL injection / destructive DDL risk.

Proposed resolution:

- Add `validateColumnDefinition(table, column, definition)` and call it before `addColumnIfAbsent()`.
- At minimum, reject semicolons, comments, NUL/control characters, `PRAGMA`, `ATTACH`, `DETACH`, DML/DDL verbs, and unbalanced quotes/parentheses.
- Prefer a positive grammar for allowed column definitions: type name, optional `DEFAULT` literal, optional `NOT NULL`, optional `CHECK (...)`, optional `COLLATE`, and other SQLite-supported pieces the project intentionally supports.
- Update `README.md` and public type docs to state that raw schema extensions are trusted-code only unless the caller uses the constrained builder/validator.
- Add tests for stacked statements in `definition`, comments, unsafe keywords, malformed parentheses, and accepted normal definitions such as `TEXT`, `INTEGER DEFAULT 0`, and `TEXT CHECK (length(value) < 200)`.

Alternative:

- Keep raw `definition` as an explicitly trusted-code escape hatch and add a separate safe builder API such as `column.text({ default, notNull, check })`.
- Trade-off: preserves full SQLite flexibility for power users while giving configuration-driven apps a safe path.
- Side-effect: two ways to express extensions. Mitigate by marking raw fragments as advanced/trusted in docs and examples.

### P2: Cross-namespace graph traversal is only shallowly cross-namespace

The README states that cross-namespace links are permitted and that traversal "can cross into the linked namespace" (`README.md:406-408`). The default adapter does allow a one-hop link from namespace A to an assertion in namespace B because it joins the target assertion by ID only. But every recursive step still filters links by the original `namespace` parameter:

```sql
FROM trageti_links l
JOIN traversal t ON l.from_id = t.to_id
...
WHERE l.namespace = ?
```

That means a path A:a1 -> B:b1 can be returned, but traversal from B:b1 will only follow links stored under namespace A. It will not follow normal B-scoped outgoing links from B:b1. This affects `getConnected()` and `retrieve({ expandLinks: true, maxDepth: >1 })` because both depend on the same `findConnected()` adapter.

Why this matters:

- The public contract says cross-namespace links are traversable, not merely returnable as one-hop foreign targets.
- Multi-hop `expandLinks` is used to build RAG context. Incomplete second-hop traversal can silently omit relevant linked assertions from the target namespace.
- The current behavior is not obviously discoverable from the API. `namespace` appears to scope the starting graph query, but after an explicit cross-namespace edge the docs imply the walk can continue in the linked namespace.

Proposed resolution:

- Decide and document one exact semantic rule, then enforce it with tests.
- If "cross into linked namespace" means traversal follows the destination assertion's namespace, carry the current assertion namespace through the recursive CTE. Join each target assertion, store its namespace in the traversal state, and on the next hop select links where `l.namespace = current_target_namespace`.
- Ensure custom adapter guidance says whether adapters receive a starting namespace or a fixed link namespace.
- Add regression tests:
  - namespace A assertion links to namespace B assertion;
  - namespace B assertion links to namespace B second assertion;
  - `getConnected({ namespace: 'A', maxDepth: 2 })` reaches the B second assertion if that is the intended contract.

Alternative:

- Preserve current fixed-link-namespace traversal and update README/spec to say that `namespace` scopes the link set for the whole traversal; cross-namespace links can return a foreign assertion, but traversal does not automatically switch to that assertion's namespace.
- Trade-off: simpler and backward-compatible, but less aligned with the phrase "cross into the linked namespace" and less useful for federated graph navigation.
- Mitigation: add an explicit option later, for example `crossNamespaceTraversal: 'fixed-link-namespace' | 'target-namespace'`, defaulting to current behavior until a major release.

### P2: `findPath()` accepts nonexistent zero-hop endpoints

`CTEGraphAdapter.findPath()` returns `[]` immediately when `fromId === toId`:

```ts
if (fromId === toId) return [];
```

This happens before any assertion lookup. As a result, `store.findPath({ namespace, fromAssertionId: 'does-not-exist', toAssertionId: 'does-not-exist', ... })` reports a successful zero-hop path even though the assertion is absent. This is inconsistent with the rest of the graph API, which otherwise depends on existing link/assertion rows and temporal validity.

Why this matters:

- `[]` is the documented successful zero-hop result. Returning it for missing IDs makes absence indistinguishable from a real identity path.
- Callers using `findPath()` to validate graph connectivity can incorrectly accept invalid assertion references.

Proposed resolution:

- Move the zero-hop check above the adapter or add an adapter preflight that verifies the assertion exists before returning `[]`.
- Return `null` for a missing zero-hop endpoint, or throw `RetrievalInputError` / `ValidationError` if the library wants missing endpoints to be caller input errors.
- If cross-namespace zero-hop paths are supported, require only existence. If `namespace` should constrain zero-hop paths, require `id` to exist in that namespace.
- Add tests for nonexistent same-ID, existing same-ID in the starting namespace, and existing same-ID in another namespace.

Alternative:

- Keep `[]` for any identical IDs and document it as a pure identity relation independent of persistence.
- Trade-off: technically simple, but surprising for a store-backed API and weak for validation workflows.

### P2: `explain()` diverges from `retrieve()` for caller-supplied embeddings

`retrieve()` validates caller-supplied `queryEmbedding` length and finite numeric values (`src/pipeline/retrieve.ts:276-286`). It also touches vector readiness through `ensureVectorReadable()` when the strategy permits vector retrieval. Depending on namespace state, `retrieve()` can throw for vectorless namespaces, missing sqlite-vec, or vector-only retrieval without a table.

`explain()` calls only `validateRetrievalQuery()` and then estimates `wouldApplyVector` from `vectorless` and `vectorReady` (`src/store/TragetiStore.ts:1394-1436`). With caller-supplied `queryEmbedding` it does not:

- validate vector dimension or non-finite values;
- model `retrieve()` failures for vectorless namespaces;
- model missing sqlite-vec failures for caller-supplied embeddings;
- report vector-only `VECTOR_INDEX_NOT_READY` consistently when a vec0 table is absent.

Why this matters:

- `explain()` is a planning/introspection API. Returning a plan for a request that `retrieve()` would reject undermines its primary value.
- Runtime validation tests currently cover shared scalar retrieval validation, but not vector-shape or vector-readiness parity.

Proposed resolution:

- Factor a shared vector routing/classification helper used by both `resolveQueryEmbedding()` / `retrieve()` and `explain()`.
- In `explain()`, validate caller-supplied `queryEmbedding` against the namespace dimension with `vectorValidationError()`.
- For fatal states, either throw the same typed errors as `retrieve()` or add an explicit `wouldFail` / `failureCode` field to `RetrievalExplainResult`.
- Add tests covering:
  - non-finite query embedding;
  - dimension mismatch;
  - vectorless namespace with `retrievalStrategy: 'vector'`;
  - vector-configured namespace with no vec0 table and vector-only strategy;
  - sqlite-vec missing with caller-supplied embedding.

Alternative:

- Keep `explain()` non-throwing and surface all fatal retrieval blockers as notes.
- Trade-off: less disruptive for callers using explain as a dashboard endpoint, but the result type needs a machine-readable failure field; free-form notes are easy to miss.

### P2: Failed setup can leak file-backed database handles

`prepareDatabase()` opens a `better-sqlite3` handle when passed a filename, applies pragmas, and loads sqlite-vec. If any setup step throws after the handle is opened, the function throws without closing it. `TragetiStore.create()` then has a second leak point: `prepareDatabase()` can succeed, `new TragetiStore(...)` can succeed, and `await store.init()` can fail, but the file-backed database is not closed because the store is never returned.

Why this matters:

- `TragetiStore.create({ database: 'file.db' })` is the documented recommended path.
- On failed initialization, callers do not receive a `Database` or `TragetiStore` instance, so they cannot close the handle themselves.
- File-backed SQLite handles can hold locks or resources longer than expected, which is especially painful on Windows development and CI.

Proposed resolution:

- In `prepareDatabase()`, track `openedHere = typeof source === 'string'`; wrap setup in `try/catch`; close `db` before rethrowing when `openedHere`.
- In `TragetiStore.create()`, wrap `await store.init()` in `try/catch`; if `closeDatabaseOnStoreClose` would be true, call `db.close()` before rethrowing.
- If close itself throws, preserve the original setup/init failure as the primary error and attach the close failure as `cause` or an additional logged warning.
- Add tests with a bad pragma/schema extension/tokenizer that forces setup failure against a temp file and then verifies the file can be reopened/deleted.

Alternative:

- Document that failed `create()` may leave a handle open until process exit.
- Trade-off: no code complexity, but this is hostile to the recommended high-level API and leaves callers no recovery path.

### P2: `getMissingIndexing()` requires sqlite-vec before it knows whether vec0 exists

`getPendingIndexing()` intentionally avoids sqlite-vec when the namespace is vector-configured but the vec0 table has not been lazily created yet. It can return all active assertions as pending from core tables only.

`getMissingIndexing()` first checks that the namespace is vector-configured, then immediately calls `ensureVectorReadable(namespace)`. `ensureVectorReadable()` probes sqlite-vec before checking whether the table exists. In the vector-configured / table-not-created / sqlite-vec-not-loaded state, `getMissingIndexing()` throws `MissingPeerDependencyError` even though it could answer from core tables exactly like `getPendingIndexing()`.

Why this matters:

- The two indexing-state APIs have inconsistent degradation for the same physical state.
- Callers can register a vector namespace without eagerly creating a vec0 table; asking which selected IDs are missing should not require sqlite-vec until there is an actual vec0 table to introspect.

Proposed resolution:

- In `getMissingIndexing()`, check `embeddingRepo.tableExists(tableName)` before `ensureVectorReadable()`.
- If the table is absent, return `filterRequestedIndexingIds(namespace, assertionIds, options)`.
- Only call `ensureVectorReadable()` when the table exists and vec0 inspection is required.
- Add tests for vector-configured namespaces created with sqlite-vec not loaded and no vec0 table.

Alternative:

- Keep requiring sqlite-vec for all vector-configured missing-index checks.
- Trade-off: simpler invariant, but inconsistent with `getPendingIndexing()` and unnecessarily blocks setup/planning flows.

## Re-Verified Non-Findings From The Previous Review

These v0.4.1-alpha.0 issues appear resolved in the alpha.1 source and are not repeated as open findings:

- Store `close()` now blocks new tracked operations, drains in-flight operations, marks the store closed even if cleanup hooks throw, and reports cleanup failures after closure.
- Duplicate episode, assertion, link, and citation IDs are mapped to typed `ValidationError`s.
- Retrieval graph expansion and `getConnected()` use `getByIdsValidAt()` and respect target temporal validity, including future-target exclusion.
- The default graph adapter prunes invalid destination assertions during traversal.
- Query, provider, raw-provider, batch, and reindex vectors are checked for dimension and finite numeric values.
- `getPositionRange()` now uses full namespace assertion history rather than active-only rows.
- Future schema versions are rejected with `MigrationCompatibilityError`.
- Migrations that require foreign-key toggling fail closed.
- Namespace operation locks include heartbeat refresh and heartbeat-based stale cleanup.
- Mixed-case extension columns round-trip through `extensions`.
- Extension table `createSQL` is constrained to a single `CREATE TABLE` statement for the declared table.
- sqlite-vec false cache is re-probed while true remains cached.
- Supersession recursive CTEs are namespace-bound.
- `getMissingIndexing()` returns `[]` for vectorless namespaces.
- Active-only reindex can remove superseded embeddings while default reindex remains historical.

## Recommended Fix Order

1. Harden `ColumnExtension.definition` and update schema-extension docs.
2. Decide and lock cross-namespace multi-hop traversal semantics; add tests before changing SQL.
3. Fix `findPath()` zero-hop existence handling.
4. Share vector readiness/shape classification between `retrieve()` and `explain()`.
5. Close file-backed handles on `prepareDatabase()` / `create()` failure.
6. Align `getMissingIndexing()` table-missing behavior with `getPendingIndexing()`.
