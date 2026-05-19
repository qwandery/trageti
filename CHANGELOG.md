# trageti Changelog

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
