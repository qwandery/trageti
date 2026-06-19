# trageti Changelog

## 0.4.0-rev.0

Beta remediation release implementing the v0.3 rev2 contract.

- Hardened public input validation across retrieval, explain, graph traversal,
  temporal snapshots, assertion reads, indexing, and reindexing. Invalid enum,
  temporal-anchor, filter-array, and provider-error-mode values now fail with
  stable typed errors before SQLite/provider side effects.
- Made baseline assertion integrity non-bypassable even when callers install
  custom validators, including finite temporal windows, confidence range,
  source-episode namespace integrity, citations, and supersession checks.
- Added extension-column read hydration for episodes and links in addition to
  assertions. `Episode` and `AssertionLink` now return a stable
  `extensions: Record<string, unknown>` bag; write APIs use
  `NewEpisodeInput` and `NewAssertionLinkInput` so callers do not supply
  extension values through core writers.
- Adjusted graph adapter typing: adapters return `GraphAdapterLink` values
  with optional extension bags, while public `findPath()` results are
  repository-hydrated `AssertionLink[]` values with extensions populated.
- Wrapped single-assertion provider failures as `EmbeddingProviderError` and
  added stable error codes for retrieval enum/filter validation plus indexing
  and reindex provider-error-mode validation.
- Fixed JSON and structured context formatter truncation accounting.
- Expanded beta-readiness coverage with runtime boundary integration tests,
  schema-extension read-surface integration tests, file-backed vectorless to
  vector lifecycle coverage, and a built-package E2E public-surface test.
- CI and publish now run the release gate with lint, typecheck, coverage,
  build, and E2E package tests. The npm dist-tag remains `beta`.

## 0.3.0

### Major API redesign

**BREAKING — uniform async API.** All public `TragetiStore` methods now return
`Promise`. Callers must `await` every store call (`store.init()`,
`store.writeEpisode(...)`, `store.retrieve(...)`, etc.). Internal repository
calls remain synchronous; the async surface exists for forward-compat with
async middleware and remote backends.

**BREAKING — `RetrievalQuery.queryEmbedding` is now optional.** `retrieve()`
requires one of `queryText`, `queryEmbedding`, or both, and routes by the
new `retrievalStrategy` field (`'hybrid' | 'vector' | 'bm25'`, default
`'hybrid'`). Strategy `'vector'` requires either `queryEmbedding` or
`queryText` plus a configured `EmbeddingProvider`; `'bm25'` requires
`queryText`; `'hybrid'` uses whichever inputs are available.

**BREAKING — default `queryTextMode` flipped to `'phrase'`.** User-supplied
`queryText` is now wrapped in a literal FTS5 phrase by default (operators
like `AND`/`OR`/`NEAR` are treated as text). Pass `queryTextMode: 'fts5'`
to restore the v0.2 raw-syntax behavior. This change is silent at the API
boundary; existing queries that did not rely on FTS5 operators are
unaffected.

### New public surface

- **Lifecycle:** `TragetiStore.create(options)` factory, `close()`,
  `requireOpen()`, `prepareDatabase()`, `StoreClosedError`. Ownership rule:
  `create({ database: string })` opens and owns the handle; `create({
database: Database })` leaves the handle to the caller.
- **Logger/Metrics:** `Logger` interface (`debug`/`info`/`warn`/`error`),
  default `ConsoleLogger` (warn+error to stderr) and `NoopLogger`. Optional
  `Metrics` interface — no default implementation; emission is a guarded
  no-op when unset.
- **Vectorless namespaces:** `embeddingDimension` is now optional. Omitting
  it (or passing `null`) registers a vectorless namespace usable with
  BM25-only retrieval and no `sqlite-vec` dependency.
- **Providers:** `EmbeddingProvider` contract (batch `embed(texts, options)`
  with `purpose` and `AbortSignal`); core ships `MockEmbeddingProvider`
  (deterministic hashed; emits `TRGT_MOCK_PROVIDER_NON_PRODUCTION` once
  per process outside `NODE_ENV=test`) and `RawVectorProvider`.
- **Indexing:** `indexBatch(items, options)` returns
  `IndexBatchResult = { indexed: number, skipped: Array<{ assertionId,
reason, errorCode? }> }`. Unknown IDs are recorded in `skipped[]`;
  `indexAssertion` still throws `IndexingError(ASSERTION_NOT_FOUND)`.
- **Maintenance:** `rebuildFts(options)` drops and recreates the
  `trageti_fulltext` FTS5 table with a new tokenizer, preserves the rowid
  invariant, and updates `trageti_tokenizer`.
  `upgradeNamespaceToVector(namespace, { embeddingDimension })` is the only
  path from vectorless to vector-configured.
- **Errors:** stable codes via `ErrorCode.*` and new classes
  `StoreClosedError`, `NamespaceDimensionMismatchError`,
  `MigrationCompatibilityError`, `IndexingError`, `RetrievalInputError`,
  `ReindexError`, `EmbeddingProviderError`, `ReferencedExtensionTableError`,
  `MissingPeerDependencyError`.

### Storage

- **Single v0.3 baseline migration.** The pre-beta migration chain has been flattened to one baseline at schema version `1`. Fresh databases are created directly with the steady-state `trageti_` schema: nullable vector namespace columns, citation storage, canonical `created_at` fields, `trageti_fulltext` + sync triggers, `trageti_tokenizer`, `trageti_idx_*` indexes, and per-namespace `trageti_embeddings_<hash>` vec0 tables when provisioned. Automatic migration from v0.2 prototype databases is intentionally not part of the v0.3 beta contract.
- **Lazy vec0 creation.** `init()` no longer eagerly creates per-namespace vec0 virtual tables. Indexing, reindexing, and namespace vector upgrade provision vec0 tables; retrieval is read-only and degrades hybrid queries to BM25 when a configured vector table has not yet been provisioned.
- **Safer maintenance and lifecycle behavior.** `batchSize` options are now validated before side effects, staging reindex uses unique run identifiers plus a per-namespace lock, reindex pagination is keyset-based, skip mode preserves batch provider calls, and `close()` rejects new operations while waiting for in-flight provider-backed operations to settle before closing an owned database handle.
- **Stricter public-boundary validation.** Fractional token budgets, invalid graph depths, non-finite temporal/confidence inputs, malformed assertion fields, and cross-namespace link source episodes now fail with typed validation errors instead of raw TypeErrors or SQLite constraint failures.

### Scoring and ranking

- **BREAKING — scorer contract is batch-only.** `RetrievalScorer` now requires
  `scoreBatch(candidates, context)`; the retrieval pipeline no longer calls a
  per-candidate `score()` fallback.
- **Default scorer changed to RRF.** `RRFScorer` is now the default scorer and
  fuses semantic, BM25, and recency ranks using reciprocal rank fusion.
- `LinearScorer` retains the previous 60/30/10 weighting (semantic / BM25 /
  recency) and renormalizes weights when one signal is absent. It throws
  `TragetiError(SCORER_NO_USABLE_SIGNAL)` when both semantic and BM25 signals
  are null. `DefaultScorer` remains as a deprecated alias for the default RRF
  scorer.
- **Deterministic tie-breaks:** results are ordered by `(score DESC,
validFrom DESC, createdAt ASC, id ASC)`. `createdAt` must be ISO 8601
  with consistent precision so lexicographic order matches temporal order;
  library-managed IDs use SQLite BINARY collation.

### Misc

- **Know Thyself demo derives repository history at runtime.** The demo now
  builds source documents, episodes, fixture extraction, and hash vectors from
  git keyframe commits instead of committed generated seed data. `--repo` and
  `--keyframes` support custom repositories in live-provider mode, and
  run-specific database files prevent cross-repo DB reuse.
- **Live demo runs are rate-limit aware and resumable.** Demo providers
  serialize live requests at one request per 5 seconds by default, configurable
  with `--limit` or `DEMO_RATE_LIMIT`, then retry retryable HTTP failures with
  backoff. Know Thyself caches live source summaries under `.local`, and reruns
  can re-index assertions left without embeddings by an interrupted provider
  call.
- `DefaultConnectionVerifier` downgrades the "sqlite-vec not loaded" path
  from a fatal `ConnectionVerificationError` to a warning so vectorless
  deployments can operate without the extension.
- Schema-extension validation runs at `init()` time:
  `referencesNamespace: true` requires `namespaceColumn`, and that column
  is verified against `PRAGMA table_info` after `createSQL` runs.
- Log codes (all `TRGT_`-prefixed): `TRGT_NON_WAL_MODE`,
  `TRGT_FOREIGN_KEYS_ENABLED`, `TRGT_EPISODE_CONTENT_LARGE`,
  `TRGT_CITATION_EXCERPT_MISSING`, `TRGT_CROSS_NAMESPACE_LINK`,
  `TRGT_INDEX_BATCH_SKIPPED`, `TRGT_MOCK_PROVIDER_NON_PRODUCTION`,
  `TRGT_RETRIEVE_VECTOR_SKIPPED`, `TRGT_RETRIEVAL_DEBUG_HOOK_ERROR`,
  `TRGT_DEPRECATED_USAGE`, `TRGT_NAMESPACE_VECTOR_UPGRADED`,
  `TRGT_PENDING_INDEXING_VECTORLESS`, `TRGT_REINDEX_STAGING_LEFTOVER`,
  `TRGT_STATS_VEC_NOT_INTROSPECTED`, `TRGT_MIGRATION_TOKENIZER_INCOMPATIBLE`,
  `TRGT_MIDDLEWARE_DISPOSE_ERROR`.
  The v0.2-era `TRGT_DELETE_NAMESPACE_HAS_REFERENCES` is retired (the
  warn-and-proceed deleteNamespace path is replaced by the cascade option
  and `ReferencedExtensionTableError`); the generic init-time
  `TRGT_SQLITE_VEC_NOT_LOADED` / `TRGT_FOREIGN_KEYS_DISABLED` verifier
  warnings are removed (foreign keys are now enforced, and sqlite-vec is
  an optional peer dependency).

### API-conformance remediation (R9)

A pre-release code-review round reconciling the implementation with the
v0.3 specification. See the dated "API-conformance remediation (R9)"
amendment in `trageti-spec-v0.3.md`.

- **BEHAVIOR CHANGE — `retrieve()` and `includeSuperseded`.** With the
  default `includeSuperseded: false`, `retrieve()` now returns the
  assertion version valid **at** `temporalAnchor` even when that version is
  mid-chain (it both supersedes a predecessor and is itself closed by a
  successor). A prior bug dropped such versions. With
  `includeSuperseded: true`, `retrieve()` returns every assertion with
  `validFrom <= temporalAnchor` regardless of `validUntil` — closed and
  superseded versions included — and that flag now also propagates into
  Step-6 graph expansion, so `retrieve({ expandLinks: true,
includeSuperseded: true })` traverses closed links.
- **Citation-excerpt policy is no longer bypassable.** `writeAssertion()`
  enforces the inline-citation excerpt policy directly, so a replaced
  `validators` array can no longer disable the regulated-domain
  `requireCitationExcerpt` hard-fail or the `TRGT_CITATION_EXCERPT_MISSING`
  warning. `DefaultAssertionValidator` gains an
  `enforceCitationExcerptPolicy?: boolean` option (default `true`) so its
  documented standalone behavior is unchanged.
- **Graph option types.** `TraversalOptions` / `PathOptions` are the
  store-facing types for `getConnected` / `findPath`
  (`namespace` + source ids + `temporalAnchor` + optional `maxDepth` /
  `linkTypes` / `includeSuperseded`). The `GraphQueryAdapter` extension
  interface now takes the new `GraphAdapterTraversalOptions`. `CTEGraphAdapter`
  implements `includeSuperseded` (include expired links) and `findPath`
  `linkTypes` filtering. New exported type `TemporalSnapshotOptions` for
  `getTemporalSnapshot`.
- **New error codes** (all `RetrievalInputError`):
  `RETRIEVAL_INVALID_TEMPORAL_WINDOW`, `RETRIEVAL_INVALID_CONFIDENCE`,
  `RETRIEVAL_INVALID_TOKEN_BUDGET`, and `SCORER_BATCH_LENGTH_MISMATCH`
  (a `scoreBatch()` length mismatch was previously a generic
  `ValidationError`).
- **`MigrationDescriptor.appliedAt`.** `getMigrations()` descriptors carry
  `appliedAt: string | null` — the ISO-8601 apply timestamp, or `null` when
  not yet applied.
- **FTS5 tokenizer.** `FTS5TokenizerConfig` gains
  `trustedCustomTokenizer?: boolean` to opt a registered custom tokenizer
  out of the built-in allow-list. Supplying a different explicit tokenizer
  when reopening a populated database fails closed with
  `MigrationCompatibilityError`; an empty database rebuilds in place.
- **Typed input validation.** `writeEpisode()` / `writeLink()` reject
  malformed required fields with `ValidationError` before any SQLite write;
  `reindexNamespace({ newDimension })` validates the dimension before vec0
  DDL. Retrieval debug/explain steps are typed (`RetrievalStep` /
  `RetrievalStepInfo`); emitted step names are `'semantic'` / `'keyword'`.
- **Extension identifiers.** Extension column and `namespaceColumn` names
  that collide with a SQLite reserved keyword are now accepted (every
  identifier is quoted in DDL); only the `trageti_` prefix and
  library-column collisions are rejected.
- **Removed.** `RetrievalMeta.queryTextMode` is now `QueryTextMode | null`
  (`null` for a no-`queryText` call); the unimplemented `Migration.down`
  field is removed.

### Retrieval & graph polish

A pre-release polish round. See the dated "Retrieval & graph polish"
amendment in `trageti-spec-v0.3.md`.

- **Snapshot `includeSuperseded`.** `getTemporalSnapshot({ includeSuperseded:
true })` now returns every assertion with `validFrom <= atPosition` —
  including versions closed before `atPosition` — instead of ignoring the
  flag. The default (`includeSuperseded: false`) is unchanged: only the
  version valid at `atPosition`.
- **New error code `RETRIEVAL_INVALID_QUERY_TEXT`.** A malformed
  `queryTextMode: 'fts5'` expression now throws `RetrievalInputError` with
  this dedicated code instead of being reported under
  `RETRIEVAL_REQUIRES_QUERY_TEXT`. The thrown message is generic — it never
  echoes the offending query text or a raw SQLite parser fragment.
  `RETRIEVAL_REQUIRES_QUERY_TEXT` now means strictly missing/blank query text.
- **Debug/explain step order.** The `rank` retrieval step is emitted
  immediately after `score` and before the optional `graph-expand` /
  `trajectory-expand` steps, in both the `RetrievalDebug.onStep` hook and
  `store.explain()`.
- **Named, shared defaults.** Retrieval limit (10), candidate oversample
  factor (×3), context-assembly retrieval limit (100), and graph traversal
  depths (`getConnected` 3, `findPath` 5) are now defined once as named
  internal constants.
- **Deterministic graph neighborhood order.** `CTEGraphAdapter.findConnected`
  returns links in a stable order (traversal depth, then link `createdAt`,
  then `id`), so repeated `getConnected` calls are reproducible.

## 0.2.0

### Minor Changes

- 5695df6: **Citations and trajectory retrieval.**

  **BREAKING (citations)**

  Assertions now require at least one citation. New `trl_citations` table, new
  `AssertionCitation` interface, `writeAssertion()` requires `citations`. The
  default validator and the `TragetiStore` itself enforce this. Existing v0.1
  rows in production databases remain readable with `citations: []` — the
  validator only enforces on new writes.

  **BREAKING (custom scorers)**

  `ScoredCandidate.bm25Score` and `RetrievedAssertion.scoreComponents.bm25Score`
  now carry the **raw FTS5 BM25** value (negative; more-negative = better) instead
  of a min-max-normalised value in `[0, 1]`. `DefaultScorer` performs the
  normalisation internally — its ranking is unchanged. **Custom scorers that
  consumed the previous normalised value must be updated** (negate to flip
  direction; use `scoreBatch` for cross-candidate normalisation). See README
  §Custom scorer for a migration snippet.

  **BREAKING (`supersedeAssertion`)**
  - No longer overwrites `supersedes_id` on the old assertion — `supersedes_id`
    now strictly stores the prior-assertion pointer (new → old), as the spec
    intends.
  - `replacedById` is validated for namespace compatibility but **not persisted**
    (no `replaced_by_id` column in v0.2 — see future-design note in dev guide).
  - Calling `supersedeAssertion()` on an assertion whose `valid_until` is already
    non-null now rejects with `ValidationError`. The assertion is part of an
    established replacement chain; mutating the window risks chain inconsistency.

  **NEW: trajectory retrieval mode**

  `retrieve()` and `assembleContext()` accept `mode: 'snapshot' | 'trajectory'`.
  - `mode: 'snapshot'` (default) — preserves v0.1 behaviour exactly.
  - `mode: 'trajectory'` — each `RetrievedAssertion` gains a `supersessionChain`
    field containing all prior versions of that assertion, oldest-first, with full
    citations. `supersessionChain: []` when there are no predecessors; the
    property is absent in snapshot mode.

  New utility `getEntityTrajectory(namespace, entityId): Assertion[]` follows the
  supersession chain for an entity. **Replacement chains only** — does not
  traverse `trl_links`; non-chain entity rows are returned as one-element
  trajectories. For accumulation/layering relationships use `getEntityHistory()`
  plus `expandLinks: true`.

  **NEW: optional `RetrievalScorer.scoreBatch`**

  `RetrievalScorer` gains an optional `scoreBatch?(candidates, context): number[]`
  hook for scorers that need cross-candidate normalisation. _Implementation
  extension beyond the v0.2 spec_ — added to preserve the spec's "raw signals
  into the scorer" contract while letting `DefaultScorer` perform BM25
  normalisation across the candidate set. Custom scorers that don't implement it
  keep working via the per-candidate `score()` fallback. The retrieval pipeline
  validates the returned array length and throws on mismatch.

  Historical note: this v0.2-era entry is superseded by the v0.3 rev2 /
  `0.4.0-rev.0` contract. `RetrievalScorer` is now batch-only and must
  implement `scoreBatch(candidates, context)`.

  **NEW: index `trl_idx_assertions_supersedes`**

  Added in v002 alongside the citations table. Indexes
  `(namespace, supersedes_id)` to support efficient reverse-supersession lookups
  ("what replaced assertion X?"). Required because `supersedes_id` is strictly
  new → old in v0.2.

  **POLICY (auto-supersession)**

  `writeAssertion()` with a non-null `supersedesId` now atomically sets the
  predecessor's `valid_until = new.validFrom` in a single transaction, after
  validating the predecessor exists, shares the namespace, has
  `validFrom < new.validFrom`, and is not already closed at a different position.

  **Setting `supersedesId` is a strong replacement signal** — it removes the
  predecessor from snapshot retrieval immediately. For new information that
  _layers on_ an earlier assertion rather than replacing it, use
  `writeLink({ linkType: 'deepens' | 'qualifies' | 'contextualizes' | 'contradicts' | 'measures' })`
  instead. See README §Choosing supersession vs links.

  **SPEC AMENDMENT: accumulation link types**

  `RecommendedLinkTypes` extended with `DEEPENS`, `CONTRADICTS`, `CONTEXTUALIZES`,
  `QUALIFIES`, `MEASURES`. Vocabulary-only — no schema or retrieval behaviour
  change. The library treats `linkType` as opaque; this is a recommendation to
  help callers express layering distinctly from replacement.

### Patch Changes

- **Enforce monotonic episode positions per namespace** (BREAKING behaviour fix).
  `writeEpisode()` now enforces the v0.2 spec invariant that episode positions
  must increase strictly monotonically within a namespace. Writing an episode at
  a position less than or equal to the existing maximum for the namespace now
  throws `ValidationError`.

  Callers writing out-of-order episodes were silently violating the spec; their
  writes now fail at insert time. The first write to a fresh namespace is
  unconstrained (no predecessor). Monotonicity is per-namespace — positions in
  namespace A do not constrain namespace B.

  The check runs inside `EpisodeRepository.insert()`'s `db.transaction()` block,
  so a rejected write leaves no partial state.

- **`findPath()` returns the full ordered path** (BREAKING behaviour fix).
  `CTEGraphAdapter.findPath()` previously returned only the terminal link of a
  multi-hop walk (e.g. `[linkBC]` for the path `a -> b -> c`), discarding every
  intermediate hop. It now returns the complete ordered link list
  (`[linkAB, linkBC]`), matching the spec contract.

  Callers who relied on the truncated single-link return value are silently
  broken by this fix and must adapt:
  - `path[0].fromId === fromAssertionId`, every adjacent pair connects, and
    `path[path.length - 1].toId === toAssertionId`.
  - If `fromAssertionId === toAssertionId`, `findPath()` returns `[]` (zero-hop
    path) without consulting `trl_links`.
  - Cycle protection is now enforced via a visited-to-id set in the recursive
    CTE; a returned path never revisits an assertion.
  - When multiple paths of equal minimum depth exist, the adapter selects the
    one whose hop-ordered `(createdAt, id)` tuple sequence is lexicographically
    smallest. Selection is deterministic across runs.

## 0.1.0

Initial release.
