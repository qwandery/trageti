# trageti Changelog

## 0.3.0

### Major API redesign

**BREAKING — uniform async API.** All public `TemporalStore` methods now return
`Promise`. Callers must `await` every store call (`store.init()`,
`store.writeEpisode(...)`, `store.retrieve(...)`, etc.). Internal repository
calls remain synchronous; the async surface exists for forward-compat with
async middleware and remote backends.

**BREAKING — `RetrievalQuery.queryEmbedding` is now optional.** `retrieve()`
requires one of `queryText`, `queryEmbedding`, or both, and routes by the
new `retrievalStrategy` field (`'hybrid' | 'vector' | 'bm25'`, default
`'hybrid'`). Strategy `'vector'` requires `queryEmbedding`; `'bm25'`
requires `queryText`; `'hybrid'` uses whichever inputs are available.

**BREAKING — default `queryTextMode` flipped to `'phrase'`.** User-supplied
`queryText` is now wrapped in a literal FTS5 phrase by default (operators
like `AND`/`OR`/`NEAR` are treated as text). Pass `queryTextMode: 'fts5'`
to restore the v0.2 raw-syntax behavior. This change is silent at the API
boundary; existing queries that did not rely on FTS5 operators are
unaffected.

### New public surface

- **Lifecycle:** `TemporalStore.create(options)` factory, `close()`,
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
- **Maintenance:** `rebuildFts(options)` drops and recreates `trl_fts`
  with a new tokenizer, preserves the rowid invariant, and updates
  `trl_fts_meta`. `upgradeNamespaceToVector(namespace, { embeddingDimension })`
  is the only path from vectorless to vector-configured.
- **Errors:** stable codes via `ErrorCode.*` and new classes
  `StoreClosedError`, `NamespaceDimensionMismatchError`,
  `MigrationCompatibilityError`, `IndexingError`, `RetrievalInputError`,
  `ReindexError`, `EmbeddingProviderError`, `ReferencedExtensionTableError`,
  `MissingPeerDependencyError`.

### Storage

- **Migration v003** introduces nullable `trl_namespaces.embedding_dimension`
  and `embedding_table` columns with a both-null-or-both-non-null `CHECK`,
  plus a new `trl_fts_meta` table that records the active tokenizer
  configuration (library-managed; not parsed from `sqlite_master`).
- **FK-toggle migration choreography** (`requiresForeignKeyToggle: true`):
  the runner captures the current `PRAGMA foreign_keys`, disables it,
  BEGINs an explicit transaction, runs the migration body, runs
  `PRAGMA foreign_key_check` (rolls back if violations are found),
  inserts the schema-version row, COMMITs, then restores the captured FK
  state in `finally`.
- **Lazy vec0 creation.** `init()` no longer eagerly creates per-namespace
  vec0 virtual tables; an internal `ensureVectorReady(namespace)` chokepoint
  validates the namespace is vector-configured, that `sqlite-vec` is
  loaded, and creates the vec0 table on first use.

### Scoring and ranking

- `DefaultScorer` retains its 60/30/10 weighting (semantic / BM25 / recency)
  and renormalizes weights when one signal is absent. Throws
  `TragetiError(SCORER_NO_USABLE_SIGNAL)` when both signals are null.
- **Deterministic tie-breaks:** results are ordered by `(score DESC,
  validFrom DESC, createdAt ASC, id ASC)`. `createdAt` must be ISO 8601
  with consistent precision so lexicographic order matches temporal order;
  library-managed IDs use SQLite BINARY collation.

### Misc

- `DefaultConnectionVerifier` downgrades the "sqlite-vec not loaded" path
  from a fatal `ConnectionVerificationError` to a warning so vectorless
  deployments can operate without the extension.
- Schema-extension validation runs at `init()` time:
  `referencesNamespace: true` requires `namespaceColumn`, and that column
  is verified against `PRAGMA table_info` after `createSQL` runs.
- New log codes: `TRGT_NON_WAL_MODE`, `TRGT_SQLITE_VEC_NOT_LOADED`,
  `TRGT_FOREIGN_KEYS_DISABLED`, `TRGT_EPISODE_CONTENT_LARGE`,
  `TRGT_CITATION_EXCERPT_MISSING`, `TRGT_CROSS_NAMESPACE_LINK`,
  `TRGT_INDEX_BATCH_SKIPPED`, `TRGT_DELETE_NAMESPACE_HAS_REFERENCES`,
  `TRGT_MOCK_PROVIDER_NON_PRODUCTION`.

## 0.2.0

### Minor Changes

- 5695df6: **Citations and trajectory retrieval.**

  **BREAKING (citations)**

  Assertions now require at least one citation. New `trl_citations` table, new
  `AssertionCitation` interface, `writeAssertion()` requires `citations`. The
  default validator and the `TemporalStore` itself enforce this. Existing v0.1
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
