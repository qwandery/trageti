# trageti
## Package Specification v0.3

**Status:** Final design specification — implementation begins after sign-off
**Date:** May 2026
**License intent:** MIT
**Target runtime:** Node.js 18+ / TypeScript 5+

---

## Contract Scope

The v0.3 public contract is **every typed interface in this document**, **every
documented MUST / MUST NOT invariant**, **every error code in the Error Model
tables**, **every log code in the Logging codes table**, and **every schema
migration described in Schema and Migrations**. Behavior outside that surface
is implementation latitude; consumers MUST NOT depend on it.

Concretely: changing the shape of a typed interface, removing or renaming an
error code or log code, weakening a documented invariant, or altering a
schema-migration step is a breaking change. Adding new optional fields,
introducing new log codes, or shipping new opt-in APIs is not.

---

## Specification Changelog

This changelog tracks changes to the specification, not to the implementation.
v0.3 is a clean-break specification for a broader-adoption package: safer
defaults, stronger integrity guarantees, clearer developer experience, and
better operational visibility.

---

### v0.3 — May 2026

**Breaking changes are intentional.** The design goal is a professional-use
library that can be adopted safely by teams who will not read the source.

**Notable changes from v0.2** (after multi-round design review against the
actual v0.2 source):

- **All public `TemporalStore` methods are async.** Uniform `Promise<...>`
  contract across writes, retrieval, indexing, introspection, lifecycle.
- **`NewAssertion` split** into caller-facing `NewAssertionInput` (nullable
  fields are optional and default to `null` at the boundary) and
  validator-facing `NormalizedNewAssertion`. `NewAssertion` retained as a
  deprecated alias.
- **Vectorless namespaces** with lazy `vec0` creation. `init()` no longer
  requires `sqlite-vec`. New `vector-configured` / `vector-ready`
  terminology. Schema migration v003 makes
  `trl_namespaces.embedding_dimension` and `embedding_table` nullable
  (with a both-null-or-both-non-null `CHECK`); FK-toggle migration runner
  documented.
- **`RetrievalStrategy = 'hybrid' | 'vector' | 'bm25'`** added (the
  existing `RetrievalMode = 'snapshot' | 'trajectory'` keeps that name
  unchanged). BM25-only retrieval has a dedicated pipeline branch; hybrid
  with text-only inputs gracefully falls back to BM25 when no provider
  or no `sqlite-vec` is available.
- **`ensureVectorReady()`** as the single chokepoint for all vec0-touching
  paths.
- **`getStats()` and `getPendingIndexing()` semantics** for the four
  observable `(sqlite-vec loaded × vec0 exists)` states; `vectorReady`
  field on `NamespaceStats`.
- **`DefaultScorer` formula corrected** to match the actual v0.2 code
  (position-range-normalized recency; weight renormalization when BM25 or
  vector signals are absent; min-max BM25 normalization with `range === 0
  → 1` rule). `semanticDistance` becomes nullable.
- **`TableExtension`** gains declarative `namespaceColumn`; raw
  `cleanupSQL` deferred to v0.4. Extension tables are NEVER dropped by
  `deleteNamespace()` — only per-namespace rows via the generated DELETE.
- **`InitializedTemporalStore` brand dropped** in favor of runtime guards
  via `requireOpen()` / `StoreClosedError` / `NamespaceNotInitializedError`.
- **`MissingPeerDependencyError`** is the single error type for "sqlite-vec
  not loaded" (the previous `RETRIEVAL_REQUIRES_VECTOR_BACKEND` code is
  removed).
- **Quickstart includes two examples**: hybrid (default) and BM25-only /
  vectorless (no `sqlite-vec` install required).
- **Two-example Quickstart** plus `prepareDatabase`, `rebuildFts`, and
  detailed Reindex/Indexing/Provider-failure semantics.

#### Correctness and Integrity - BREAKING

- **Foreign keys are enforced by default.** The default connection verifier must
  enable `PRAGMA foreign_keys = ON`, re-check it, and fail closed if enforcement
  is unavailable. Warning-only FK behavior is removed.
  Migration note: callers that intentionally disable FK checks must provide a
  custom `ConnectionVerifier` and accept full responsibility for integrity.
- **Namespace dimension mismatch is rejected.** Reopening an existing
  vector-configured namespace with a *different* embedding dimension throws
  `NamespaceDimensionMismatchError` unless the caller runs
  `reindexNamespace()`. Reopening *without* supplying any dimension or
  provider is allowed: the stored dimension remains authoritative, so
  caller-supplied-vector operations still work when `sqlite-vec` is loaded
  and vector lengths match. Provider-derived vector operations require an
  in-process `EmbeddingProvider`; without one, they fail or degrade according
  to the normal indexing/retrieval strategy rules.
  Migration note: callers do not have to persist the namespace dimension to
  reopen, but if they DO supply one, it must match the stored value.
- **Namespace deletion is database-authoritative.** `deleteNamespace()` must
  look up the namespace's embedding table from `trl_namespaces`, not only from
  an in-memory cache, before dropping vector storage.
  Migration note: no API change; behavior becomes more complete.
- **`indexBatch()` reports all outcomes.** Silent skipping of unknown assertion
  IDs is removed. The method returns an `IndexBatchResult`, or throws when
  configured for fail-fast behavior.
  Migration note: callers must handle the result envelope.
- **Reindexing is staging-based.** `reindexNamespace()` builds a staging vector
  table and swaps it into use only after all embeddings are generated and
  validated.
  Migration note: failed reindex preserves the previous usable index.
- **Public inputs are validated.** Invalid `limit`, `maxDepth`, temporal
  windows, token budgets, confidence bounds, and embedding dimensions throw
  `RetrievalInputError` or `ValidationError` before SQLite execution.
  Migration note: callers relying on SQLite errors will now receive typed
  library errors earlier.
- **Supersession has one canonical write path.** The canonical replacement path
  is `writeAssertion({ supersedesId })`, which atomically closes the predecessor.
  `supersedeAssertion()` is removed from the primary API; the retained escape
  hatch for closing without a replacement is `store.advanced.closeAssertion()`.
  Migration note: replace two-step `writeAssertion()` plus
  `supersedeAssertion()` flows with a single replacement assertion write.

#### Security - BREAKING where needed

- **`queryText` is safe text by default.** User-provided keyword text is treated
  as literal text or an escaped phrase. Raw FTS5 expression mode requires an
  explicit `queryTextMode: 'fts5'`.
  Migration note: callers that intentionally used FTS5 operators must opt in.
- **FTS5 tokenizer configuration is validated.** Built-in tokenizers use an
  allow-list; tokenizer arguments use a strict character policy unless the
  caller explicitly marks configuration as trusted.
  Migration note: unsupported tokenizer configs fail at initialization.
- **Dynamic identifiers are always quoted.** Any dynamic table or column name is
  passed through the identifier-quoting helper, even when names are derived from
  trusted hashes.
  Migration note: no API change.
- **Schema extension SQL is explicitly trusted code.** Raw `createSQL` and
  column definitions remain possible, but documentation and types must mark this
  as a trusted-code surface, not a user-config surface.
  Migration note: apps that expose schema extension values to tenants must add
  their own validation or use the constrained builder API.

#### Developer Experience - ADDITIVE and BREAKING

- **`TemporalStore.create()` initializes the common path.** A factory opens or
  accepts a database, applies migrations, verifies connection state, registers
  the namespace, and returns an initialized store.
- **`prepareDatabase()` is a convenience helper.** It loads `sqlite-vec` when the
  adapter is installed, applies recommended pragmas, and returns a configured
  `better-sqlite3` database. The core library must not force heavyweight
  adapter dependencies on consumers who do not use the helper.
- **`EmbeddingProvider` is introduced.** Callers may continue passing vectors
  manually, but configured providers can embed assertions and queries through a
  common interface. Provider implementations are optional adapters or subpath
  exports.
- **`Logger` is pluggable.** Direct writes to stderr are replaced by a logger
  interface. The default logger emits structured warnings without source
  content, query text, embeddings, or secrets.
- **Retrieval returns an envelope.** `retrieve()` returns `RetrievalResult`
  rather than a bare array, carrying `results` plus metadata such as timing,
  filters, candidate counts, and warnings.
- **Defaults are named and shared.** Retrieval and context assembly share
  documented defaults for limit, oversampling, and graph depth.
- **Observability is first-class.** Retrieval debug hooks and `store.explain()`
  expose query planning and per-step timing without requiring source edits.

#### Testing and Release - ADDITIVE

- **Integration tests must include adversarial inputs.** Required classes:
  FTS syntax characters, file-backed reopen, multi-instance namespace lifecycle,
  dimension mismatch, atomic reindex rollback, complete multi-hop paths,
  extension-table deletion, and malformed public options.
- **Coverage thresholds are raised.** Minimum coverage targets:
  lines 95%, functions 95%, statements 95%, branches 85%.
- **Release metadata must match behavior.** Package version, README, changelog,
  changesets, and spec version must describe the same public surface.
- **Dependency posture is reviewed before release.** Runtime dependencies remain
  minimal. Optional adapters must not become accidental hard dependencies.

---

### v0.2 - May 2026

Introduced required citations, `trl_citations`, trajectory retrieval mode,
`getEntityTrajectory()`, raw BM25 score delivery to scorers, complete-path
`findPath()` (full ordered link walk + zero-hop + deterministic shortest-path
tie-break), and enforced monotonic episode positions per namespace.

### v0.1 - April 2026

Initial specification for temporal assertions, namespace storage, SQLite schema,
semantic retrieval, graph traversal, and extension interfaces.

---

## Implementation Plan

v0.3 is a clean break. The work is staged into internal implementation
checkpoints so each change set is reviewable, historically verifiable,
moderate in complexity, and practical to roll back in an emergency. These
phases are commit boundaries, not public release boundaries.

### Phase 1 — Correctness patches

Commit as an internal checkpoint against the current public surface. No
breaking changes; no new abstractions; nothing externally visible to consumers
beyond fixed defects.

- Fix the broken README supersession example: replace the two-call sequence
  with a single `writeAssertion({ supersedesId })` call.
- `deleteNamespace()` looks up the embedding table from `trl_namespaces`
  rather than the in-memory cache (externally invisible correctness fix —
  closes the leak when a namespace was created by another store instance).
- Identifier-quoting audit: every dynamic table or column name passes
  through the existing `sql-ident` helper, even when sourced from trusted
  hashes (no surface change).
- Dev-dependency audit cleanup (`vitest`/`vite`/`esbuild` chain).
- CHANGELOG.md and `package.json` version aligned to actual content.
- Regression tests: multi-instance namespace lifecycle (the deleteNamespace
  fix), README example snippet test.

### Phase 2 — Safety hardening

Adds new optional behavior with backward-compatible defaults. Existing call
sites continue to work without changes.

- `queryTextMode` ADDED with the **default kept as `'fts5'`** (preserves
  current raw FTS behavior — no consumer breaks on minor-version upgrade).
  The default flips to `'phrase'` in 0.3.0.
- FTS5 tokenizer configuration is validated against an allow-list when
  newly creating an FTS table in a database that has not yet run v001
  (the `trl_fts` table is global per-database). Existing databases retain
  their tokenizer config; switching requires the explicit `rebuildFts()`
  introduced in Phase 3.
- `Logger` interface is added with a backward-compatible default that
  preserves the current stderr behavior.
- Schema-extension surfaces gain explicit "trusted code" docstrings.

### Phase 3 — DX redesign

The full v0.3 surface described in this spec, including everything moved
out of Phase 1 because it is in fact API/behavior-changing:

- All public `TemporalStore` methods become async.
- `TemporalStore.create()` factory; `prepareDatabase()` helper; `close()`
  lifecycle.
- `EmbeddingProvider` interface and `RawVectorProvider` /
  `MockEmbeddingProvider` defaults in core; reference adapters as subpath
  exports or companion packages.
- `RetrievalResult` envelope with metadata.
- `RetrievalStrategy = 'hybrid' | 'vector' | 'bm25'` and BM25-only
  pipeline branch; vectorless namespaces with lazy vec0; v003 schema
  migration with FK-toggle runner.
- `RetrievalDebug` hook and `store.explain()`.
- `NewAssertion` split into `NewAssertionInput` /
  `NormalizedNewAssertion`; supersession consolidated to
  `writeAssertion({ supersedesId })`.
- FK enforcement (warn → fail-closed); `NamespaceDimensionMismatchError`
  on reopen; `IndexBatchResult` envelope.
- `reindexNamespace()` defaults to atomic staging-swap; `rebuildFts()`
  introduced.
- `queryTextMode` default flipped to `'phrase'`.
- `MissingPeerDependencyError` consolidation.
- Coverage thresholds raised to 95/95/95/85.
- Version, README, CHANGELOG, and changesets aligned at 0.3.0.

Phase 1 and Phase 2 are stable internal commit points before the full Phase 3
redesign. They are not public release boundaries, and no partial v0.3 upgrade
is intended before the complete v0.3 release.

---

## What This Is

`trageti` is a TypeScript library for temporally-aware retrieval-augmented
generation over SQLite. It stores, indexes, and retrieves episodic assertions:
discrete, typed claims with explicit validity windows and source citations.

The core problem is temporal drift in semantic meaning. A statement, diagnosis,
legal position, operational fact, or personal-history observation can mean
different things at different points in a sequence. `trageti` makes the temporal
anchor an explicit retrieval filter before semantic or keyword scoring occurs.

The library is designed for local/offline and lightweight AI-centric use cases,
while remaining appropriate for professional domains such as medical, mental
health, legal, law enforcement, regulated finance, and intelligence analysis.
The goal is not to decide truth for those domains. The goal is to preserve
provenance, temporal validity, update history, and retrieval transparency well
enough that domain software can build higher-level review and governance on top.

### Quickstart

trageti supports two distinct deployment shapes, both of which earn front-of-book
visibility because they target genuinely different consumers:

#### Example 1 — Hybrid retrieval (vector + BM25, the default path)

The example uses the in-package `MockEmbeddingProvider` so the snippet runs
without external dependencies (results from the mock are not semantically
meaningful — `MockEmbeddingProvider` is for tests and quickstarts only).
`prepareDatabase` defaults to `loadSqliteVec: true`, so this path requires
the `sqlite-vec` peer dependency.

Install: `npm install trageti better-sqlite3 sqlite-vec`

```typescript
import { TemporalStore, MockEmbeddingProvider } from 'trageti'

const store = await TemporalStore.create({
  database: 'rag.db',
  namespace: 'demo',
  embeddingProvider: new MockEmbeddingProvider({ dimension: 384 }),
})

await store.writeEpisode({
  id: 'ep-1', namespace: 'demo', position: 1,
  type: 'note', occurredAt: '2026-05-11T09:00:00Z',
  content: 'Initial intake notes.',
})
await store.writeAssertion({
  id: 'a-1', namespace: 'demo', type: 'observation',
  content: 'Patient reports occasional insomnia.',
  validFrom: 1, confidence: 0.9, sourceEpisodeId: 'ep-1',
  citations: [{
    id: 'c-1', episodeId: 'ep-1',
    sourceRef: 'intake#L4', excerpt: 'occasional insomnia',
  }],
})
// Provider derives the embedding from assertion.content (no `embedding`
// field supplied, so MockEmbeddingProvider is consulted).
await store.indexBatch([{ assertionId: 'a-1' }])

const { results, meta } = await store.retrieve({
  namespace: 'demo', queryText: 'sleep problems', temporalAnchor: 1,
})

await store.close()
```

For a real RAG path, replace `MockEmbeddingProvider` with a production adapter
such as `OllamaEmbeddingProvider`, `TransformersJsEmbeddingProvider`, or
`OpenAIEmbeddingProvider` (see Provider Adapters). The optional `validUntil`,
`supersedesId`, `entityId`, and `entityType` fields on `writeAssertion()` are
omitted in this example — they default to `null` via the input normalization
step inside `writeAssertion()` (see `NewAssertionInput` in Core Concepts).

#### Example 2 — BM25-only retrieval (no `sqlite-vec` required)

The most under-appreciated capability of v0.3: trageti supports temporally-aware
RAG over SQLite *without* `sqlite-vec` for use cases where keyword search and
graph traversal are sufficient (compliance review, structured-document indexing,
audit-trail querying). Vectorless deployments install no native vector binary
and run on bare `better-sqlite3`.

Install: `npm install trageti better-sqlite3`  (no `sqlite-vec`)

```typescript
import { TemporalStore } from 'trageti'

const store = await TemporalStore.create({
  database: 'rag.db',
  namespace: 'compliance',
  prepare: { loadSqliteVec: false },
  // No embeddingDimension, no embeddingProvider — namespace is vectorless.
})

await store.writeEpisode({
  id: 'ep-1', namespace: 'compliance', position: 1,
  type: 'document', occurredAt: '2026-05-11T09:00:00Z',
  content: 'Annual liability waiver, revision 7.',
})
await store.writeAssertion({
  id: 'a-1', namespace: 'compliance', type: 'clause',
  content: 'Customer waives liability for ordinary negligence.',
  validFrom: 1, confidence: 1.0, sourceEpisodeId: 'ep-1',
  citations: [{
    id: 'c-1', episodeId: 'ep-1',
    sourceRef: 'waiver#§3.1', excerpt: 'waives liability for ordinary negligence',
  }],
})
// indexBatch is NOT called — vectorless namespaces don't index vectors.

const { results, meta } = await store.retrieve({
  namespace: 'compliance',
  queryText: 'liability waiver',
  retrievalStrategy: 'bm25',  // explicit; clearer intent than relying on hybrid fallback
  temporalAnchor: 100,
})
// meta.vectorApplied === false; meta.bm25Applied === true.

// Equivalent path via hybrid fallback (no provider + queryText only → BM25):
//   retrievalStrategy: 'hybrid' (or omitted — hybrid is the default)
// produces the same results and emits TRGT_RETRIEVE_VECTOR_SKIPPED at info.
// Either form is supported. 'bm25' is preferred when the deployment is
// permanently vectorless because intent is explicit at the call site.

await store.close()
```

---

## Design Principles

**Correctness over convenience.** Silent failures are bugs. Unknown assertion
IDs, wrong embedding dimensions, impossible temporal windows, and partial graph
paths must be surfaced explicitly.

**Temporal position is a retrieval dimension, not metadata.** Each assertion has
a validity window over caller-defined ordinal positions. Retrieval excludes
assertions outside the requested anchor before scoring.

**Assertions, not chunks.** The storage unit is a discrete claim with citations,
not a raw text chunk. This keeps retrieval results explainable and auditable.

**Provenance is non-negotiable.** Assertions always carry citations. Retrieval
and context assembly must not strip provenance.

**Drop-in defaults, advanced opt-ins.** A new user should be able to initialize a
working local store quickly. Advanced behavior such as raw FTS expressions,
custom schema SQL, custom graph engines, or external embedding providers is
explicit and replaceable.

**Trusted-code surfaces are labeled.** Schema extension SQL and tokenizer
configuration are powerful operator/developer surfaces, not safe end-user input
surfaces.

**Pluggable everywhere; opinionated where it matters.** Scoring, formatting,
validation, graph traversal, logging, connection verification, middleware, and
embedding providers are replaceable. The defaults fail closed on integrity.

---

## Core Concepts

### Episode

Episodes are source input events. Each episode belongs to a namespace and has
a caller-defined `position` (the temporal anchor unit; consistent, comparable,
and stable within a namespace), a display/audit timestamp, a type, content,
and creation timestamp.

v0.3 keeps the v0.2 episode shape:

```typescript
interface Episode {
  id: string
  namespace: string
  /** Caller-defined ordinal: consistent, comparable, stable within a
   *  namespace. This is the unit `temporalAnchor` is expressed in
   *  throughout retrieval. */
  position: number
  /** ISO 8601 — real-world time of the event; display and audit only.
   *  Never used for ordering or retrieval filtering — that is what
   *  position is for. */
  occurredAt: string
  /** Caller-defined; opaque to the library. */
  type: string
  content: string
  /** ISO 8601 — when the system recorded this episode. Filled by the
   *  store on write; the write-side input shape omits this field. */
  createdAt: string
}
```

The write path is `store.writeEpisode(episode: Omit<Episode, 'createdAt'>)`.
It validates required fields and warns through the configured logger when
content exceeds `maxEpisodeContentBytes`.

### Assertion

Assertions are discrete claims. The on-read `Assertion` shape is unchanged
from v0.2:

```typescript
interface Assertion {
  id: string
  namespace: string
  type: string
  content: string
  validFrom: number
  validUntil: number | null
  confidence: number
  sourceEpisodeId: string
  supersedesId: string | null
  entityId: string | null
  entityType: string | null
  citations: AssertionCitation[]
  createdAt: string
  extensions: Record<string, unknown>
}
```

v0.3 splits the **write-side** type into a caller-facing input type and a
validator/repository-facing normalized type. This eliminates the v0.2
DX papercut where four nullable fields had to be passed explicitly even
when they were `null`.

```typescript
/** Caller-facing. Nullable fields are optional; omitted = null at the boundary. */
interface NewAssertionInput {
  id: string
  namespace: string
  type: string
  content: string
  validFrom: number
  confidence: number
  sourceEpisodeId: string
  citations: NewAssertionCitation[]
  validUntil?: number | null
  supersedesId?: string | null
  entityId?: string | null
  entityType?: string | null
}

/** Validator/repository-facing. Nullable fields are required (null permitted),
 *  guaranteed by writeAssertion()'s normalization step. */
interface NormalizedNewAssertion {
  id: string
  namespace: string
  type: string
  content: string
  validFrom: number
  validUntil: number | null
  confidence: number
  sourceEpisodeId: string
  supersedesId: string | null
  entityId: string | null
  entityType: string | null
  citations: NewAssertionCitation[]
}

/** Deprecated alias of NewAssertionInput, retained for one minor; removed in v0.4. */
type NewAssertion = NewAssertionInput
```

**Normalization order.** `writeAssertion(input: NewAssertionInput)` MUST coerce
each missing nullable field to `null` as its very first step, BEFORE
structural invariants, configured `AssertionValidator.validate()` calls, or
any repository write. Validators receive the normalized shape — `validUntil`,
`supersedesId`, `entityId`, and `entityType` are guaranteed to be `null` (not
`undefined`) at validator-call time. This guarantee is part of the
`AssertionValidator` contract.

**Wording rule for the spec and docs:** "**omitted** and `null` are both
treated as `null`." Do not say "undefined and null" — the repo's
`tsconfig.json` enables `exactOptionalPropertyTypes: true`, so
`validUntil?: number | null` does NOT permit explicit `validUntil: undefined`.
The property must be omitted entirely.

`writeAssertion()` is the canonical way to create a replacement. When
`supersedesId` is non-null after normalization, the store validates the
predecessor and atomically sets the predecessor's `validUntil` to the new
assertion's `validFrom`.

### AssertionCitation

Citations remain required for new assertions. The on-read shape is unchanged
from v0.2:

```typescript
interface AssertionCitation {
  id: string
  /** FK → trl_assertions.id */
  assertionId: string
  /** FK → trl_episodes.id (must share the assertion's namespace) */
  episodeId: string
  /** Caller-defined non-empty reference string; format opaque to the library. */
  sourceRef: string
  /** Verbatim text from the source passage. Strongly recommended; null
   *  permitted but warned on write (or rejected when
   *  validation.requireCitationExcerpt is true). */
  excerpt: string | null
  excerptStart?: string
  excerptEnd?: string
  metadata?: Record<string, unknown>
  createdAt: string
}
```

Two write-side input shapes:

```typescript
/** Inline citation passed to writeAssertion(). The store fills in
 *  assertionId (from the parent assertion's id) and createdAt. */
type NewAssertionCitation = Omit<AssertionCitation, 'assertionId' | 'createdAt'>

/** Late-citation input passed to store.writeCitation(). Caller supplies
 *  assertionId explicitly because the parent assertion already exists. */
type NewLateCitation = Omit<AssertionCitation, 'createdAt'>
```

Use `NewAssertionCitation` when adding citations to a new assertion in the
same `writeAssertion()` call. Use `NewLateCitation` (via `store.writeCitation`)
to attach an additional citation to an existing assertion. Both share the
same on-read `AssertionCitation` shape; the difference is who supplies
`assertionId`.

Citation metadata is JSON. Citation excerpts may be `null` by default; the
validator emits `TRGT_CITATION_EXCERPT_MISSING` because uncited or
unverifiable claims are weak inputs for high-stakes RAG systems.

Regulated-domain deployments should configure
`validation.requireCitationExcerpt: true` (see Namespace Configuration), which
upgrades the warning to a hard `ValidationError` at write time. This is the
recommended default for medical, legal, mental health, and law enforcement
deployments.

### AssertionLink

Links connect assertions without implying replacement unless the caller
assigns such semantics to the link type. Links retain their own validity
windows and source episode references.

```typescript
interface AssertionLink {
  id: string
  namespace: string
  /** Source assertion. */
  fromId: string
  /** Target assertion. */
  toId: string
  /** Caller-defined; opaque to the library. Recommended values include
   *  'deepens', 'qualifies', 'contextualizes', 'contradicts', 'measures' —
   *  but any string is allowed. */
  linkType: string
  validFrom: number
  validUntil: number | null
  /** FK → trl_episodes.id (must share the link's namespace). */
  sourceEpisodeId: string
  /** ISO 8601 — filled by the store on write. */
  createdAt: string
}
```

The write path is `store.writeLink(link: Omit<AssertionLink, 'createdAt'>)`.

Accumulation/linking remains distinct from supersession. If new information
layers on an older assertion, callers should keep both assertions valid and
connect them with a link rather than reaching for `supersedesId`.

---

## Extension Interfaces

### GraphQueryAdapter

The adapter contract remains, but `findPath()` must return the full ordered path
or `null`.

```typescript
interface GraphQueryAdapter {
  findConnected(
    db: Database,
    namespace: string,
    fromIds: string[],
    options: TraversalOptions,
  ): AssertionLink[]

  findPath(
    db: Database,
    namespace: string,
    fromId: string,
    toId: string,
    options: PathOptions,
  ): AssertionLink[] | null
}
```

**Adapter / store boundary — explicit.** The `GraphQueryAdapter`
operates over the **graph edge layer**: both methods return
`AssertionLink[]` (the edges traversed). The store layer is responsible
for hydrating those edges into the assertion records callers actually
see:

- `store.getConnected(options)` invokes
  `adapter.findConnected(db, namespace, [options.fromAssertionId], options)`,
  collects the distinct `toId`s from the returned links, and hydrates
  them into `Assertion[]` (with citations) via the standard repository
  read path. Adapters never construct `Assertion` values themselves.
- `store.findPath(options)` invokes
  `adapter.findPath(db, namespace, options.fromAssertionId, options.toAssertionId, options)`
  and returns the result `AssertionLink[] | null` directly to the
  caller — no per-link hydration is needed because the public
  `findPath()` contract returns links, not assertions.

This split keeps custom adapters focused on traversal correctness (and
free to use any in-database graph representation: CTE, recursive view,
materialized closure, future ANN-graph hybrid) while the store owns
hydration, citation joins, and result-envelope construction. Custom
adapters MUST NOT return assertion data outside the documented
`AssertionLink` fields; doing so violates the boundary and yields
implementation-dependent behavior.

The default CTE adapter must include cycle protection and tests for direct,
multi-hop, cyclic, expired-link, and max-depth scenarios.

### RetrievalScorer

Scorers receive a candidate's semantic distance (nullable in BM25-only mode),
optional BM25 score, candidate position, and scoring context. Batch scoring
remains the preferred hook for cross-candidate normalization.

```typescript
interface ScoredCandidate {
  assertion: Assertion
  /** Cosine distance from sqlite-vec; lower = more similar.
   *  Null in retrievalStrategy: 'bm25' or when the vector step was skipped
   *  via hybrid fallback (see Retrieval Implementation). */
  semanticDistance: number | null
  /** FTS5 BM25 score; null if no queryText was supplied or the candidate
   *  did not match. More-negative = better match. */
  bm25Score: number | null
  /** assertion.validFrom, for recency calculations. */
  position: number
}

interface RetrievalScorer {
  score(candidate: ScoredCandidate, context: ScoringContext): number
  scoreBatch?(candidates: readonly ScoredCandidate[], context: ScoringContext): number[]
}

interface ScoringContext {
  /** The temporal anchor the active retrieval query was issued at. */
  temporalAnchor: number
  /** Min and max validFrom across the namespace's *active* assertions at
   *  call time. Used for recency normalization. When the namespace has
   *  zero active assertions, both fields equal each other (any value); a
   *  degenerate range collapses recency to 1 per the DefaultScorer
   *  contract. */
  namespacePositionRange: { min: number; max: number }
  /** The full RetrievalQuery being scored. Custom scorers may read any
   *  field (e.g. minConfidence, entityTypes) to compose domain-specific
   *  weights. */
  query: RetrievalQuery
}
```

**Contract for `scoreBatch()`:**

- The returned array MUST have exactly the same length as `candidates`, in the
  same order. Length mismatch throws `RetrievalInputError`.
- Returned scores MUST be finite numbers. `NaN` and `±Infinity` throw
  `RetrievalInputError`.
- Higher score = better. The library sorts descending.
- The same `(candidates, context)` input MUST produce identical output across
  invocations within a single process. Cross-process determinism is not
  required.

**Default scorer (`DefaultScorer`).** Weighted linear combination matching the
v0.2 implementation exactly. Weights are exposed as `DefaultScorer.WEIGHTS`
constants (`{ SEMANTIC: 0.6, BM25: 0.3, RECENCY: 0.1 }`) so custom scorers can
compose against them without re-deriving.

Common derived values:

```text
semanticSimilarity = max(0, min(1, 1 - semanticDistance))   (when non-null)
recency            = (position - rangeMin) / (rangeMax - rangeMin)
                     (= 1 when rangeMax === rangeMin; rangeMin/rangeMax come
                     from context.namespacePositionRange)
```

Per-candidate `score(candidate, context)` covers four cases:

```text
A. semanticDistance non-null AND bm25Score non-null  (hybrid candidate):
   bm25 = 1 / (1 + |bm25Score|)
   return 0.6 * semanticSimilarity + 0.3 * bm25 + 0.1 * recency

B. semanticDistance non-null AND bm25Score null  (vector-only candidate):
   return (0.6 / 0.7) * semanticSimilarity + (0.1 / 0.7) * recency

C. semanticDistance null AND bm25Score non-null  (BM25-only candidate):
   bm25 = 1 / (1 + |bm25Score|)
   return (0.3 / 0.4) * bm25 + (0.1 / 0.4) * recency

D. both null  (unreachable — pipeline filters before scoring):
   throw TragetiError({
     code: 'SCORER_NO_USABLE_SIGNAL',
     message: 'candidate has no usable signal'
   })
```

Batch `scoreBatch(candidates, context)` mirrors the per-candidate cases but
substitutes min-max normalized BM25 (with negation, since FTS5 BM25 is
negative and more-negative = better) for the `1 / (1 + |bm25Score|)`
compression. The normalization runs across candidates that have a non-null
`bm25Score`; vector-only candidates use Case B as-is.

**`scoreBatch()` BM25 normalization edge case.** When all non-null `bm25Score`
values in the batch are equal — including the trivial case of a single
non-null `bm25Score` — `range = max - min === 0`. Every such candidate is
assigned `bm25Norm = 1`. This matches the existing implementation and is part
of the public contract; custom scorers replacing `DefaultScorer` SHOULD follow
the same rule for consistency, though the contract only requires deterministic
output.

### ContextFormatter

Formatters still receive retrieved assertions with full citations. v0.3 requires
formatters to report included count explicitly in metadata or an envelope field;
context assembly must not infer truncation state from formatter-private keys.

### AssertionValidator

Structural invariants cannot be bypassed by replacing validators. Custom
validators are domain validators and run after library integrity checks.

```typescript
interface AssertionValidator {
  validate(assertion: NormalizedNewAssertion): ValidationResult
}

interface ValidationResult {
  valid: boolean
  /** Human-readable validation errors. Library-defined codes flow through
   *  `ValidationError.code` when thrown; per-message classification is at
   *  the validator's discretion. */
  errors: string[]
}
```

The `NormalizedNewAssertion` parameter type is part of the contract: by the
time `validate()` is called, `writeAssertion()` has already coerced any
omitted nullable fields (`validUntil`, `supersedesId`, `entityId`,
`entityType`) to `null`. Validators may rely on this — they will never see
`undefined` in those positions. Validators run synchronously; async
validators are an explicit non-goal for v0.3 (Open Question).

### ConnectionVerifier

The default verifier:

1. Confirms `sqlite-vec` functions are available when vector retrieval is used.
2. Enables and verifies foreign-key enforcement.
3. Warns when WAL is unavailable or not active.
4. Reports through the configured `Logger`.

### RetrievalMiddleware

Middleware remains available, but any mutation that produces an invalid query is
rejected by the public input validator before SQLite execution.

### FTS5Tokenizer

Tokenizer configuration is validated before migration DDL is generated.

```typescript
interface FTS5TokenizerConfig {
  /** Built-in: 'unicode61' | 'ascii' | 'porter' | 'trigram'. Anything else
   *  is treated as a custom tokenizer name and requires
   *  trustedCustomTokenizer: true. */
  tokenizer: 'unicode61' | 'ascii' | 'porter' | 'trigram' | string
  /** Validated against a strict character class for built-in tokenizers.
   *  For custom tokenizers (with trustedCustomTokenizer: true), passed
   *  through verbatim. */
  tokenizerArgs?: string[]
  /** Required when tokenizer is anything other than a built-in. Marks the
   *  config as trusted-code; the library will not attempt to validate args. */
  trustedCustomTokenizer?: boolean
}
```

**Built-in tokenizer allow-list** (validation policy):

- `tokenizer` MUST be one of the documented built-ins OR `trustedCustomTokenizer`
  MUST be true.
- For built-ins, each entry in `tokenizerArgs` MUST match the regex
  `^[A-Za-z0-9_=-]+$` (alphanumeric plus the small set of characters
  required by `unicode61`/`ascii`/`porter` arguments). Quote characters and
  whitespace are rejected in untrusted built-in args; custom/raw tokenizer
  strings require `trustedCustomTokenizer: true`. Failing entries throw
  `SchemaExtensionError` at `init()` time.
- The validated tokenizer string is interpolated into the FTS5 `CREATE
  VIRTUAL TABLE ... USING fts5(..., tokenize='<config>')` DDL exactly once,
  at the moment a brand-new `trl_fts` table is created — never against a
  populated database. The latter case is rejected by the migration system
  with `MigrationCompatibilityError(kind: 'rebuild-fts')`; callers must
  invoke `store.rebuildFts({ tokenizer })` to actually swap.

The `trl_fts` table is **global per-database** (one per file, not one per
namespace). The allow-list applies to newly created `trl_fts` tables in
databases that haven't yet run v001. Existing databases retain their
tokenizer configuration unchanged unless `rebuildFts()` is invoked.

### SchemaExtensions

Raw SQL schema extensions remain possible because some callers need full SQLite
power. v0.3 clarifies that raw schema SQL is **trusted code** — never an
end-user or tenant configuration surface. A constrained builder API may be
added in a future version for configuration-driven products (Open Question).

```typescript
interface SchemaExtensions {
  columns?: ColumnExtension[]
  tables?: TableExtension[]
}

interface ColumnExtension {
  /** Library-managed table to extend. */
  table: 'trl_assertions' | 'trl_episodes' | 'trl_links'
  /** Custom column name. Must not start with `trl_` and must not collide
   *  with any library-defined column on the target table. */
  column: string
  /** Trusted-code SQL fragment: type, optional DEFAULT, optional CHECK,
   *  etc. Library applies as ALTER TABLE ADD COLUMN. Never source from
   *  user input. */
  definition: string
  description?: string
}

interface TableExtension {
  tableName: string
  /** Trusted-code SQL: a single idempotent CREATE TABLE statement.
   *  Library applies this verbatim. Never source from user input. */
  createSQL: string
  /** When true, the extension stores rows scoped to a namespace and MUST
   *  pair with namespaceColumn so deleteNamespace() can remove them. */
  referencesNamespace?: boolean
  /** The column on this table that holds the namespace name. Required when
   *  referencesNamespace is true. The library generates and prepares
   *  `DELETE FROM <quoted tableName> WHERE <quoted namespaceColumn> = ?`
   *  for use during deleteNamespace(). */
  namespaceColumn?: string
  description?: string
}
```

**Validation at `init()` time** (not deferred to `deleteNamespace()`):

- `referencesNamespace: true` without `namespaceColumn` → `SchemaExtensionError`.
- `namespaceColumn` is validated against the same identifier-quoting rules
  used elsewhere in the schema-extension API.
- After running `createSQL`, the library calls
  `PRAGMA table_info(<quoted tableName>)` and verifies a column matching
  `namespaceColumn` (case-sensitive) exists. If not, `SchemaExtensionError`
  with violation `'namespaceColumn "<col>" does not exist on table "<table>"
  after createSQL ran.'`

Tables registered via `TableExtension` are NEVER dropped by
`deleteNamespace()`, regardless of options — only per-namespace rows are
removed via the generated DELETE. This protects deployments where a single
extension table holds rows for multiple namespaces.

A raw `cleanupSQL` escape hatch was considered for v0.3 and deferred: see
Open Questions for the rationale (better-sqlite3's `Statement` type exposes no
`parameterCount` API for safe validation of caller-supplied SQL).

### EmbeddingProvider

Embedding providers are additive. Manual vector indexing remains supported.

```typescript
interface EmbeddingProvider {
  readonly name: string
  readonly dimension: number
  embed(texts: readonly string[], options?: EmbedOptions): Promise<Float32Array[]>
}

interface EmbedOptions {
  signal?: AbortSignal
  purpose?: 'assertion' | 'query' | 'reindex'
}
```

`purpose` exists because many modern embedding models (BGE, E5, Nomic, GTE,
Instructor) prepend instruction prefixes that depend on whether the text is a
*document* being indexed or a *query* being matched. Adapters that target such
models must honor `purpose`. Adapters for models without prefix discipline may
ignore it. `'reindex'` is treated as `'assertion'` unless the adapter wants to
distinguish (for example, to emit different telemetry).

Provider adapters are optional and tree-shakable. The core package must not make
large or networked providers hard dependencies. The only providers shipped in
core are `RawVectorProvider` (no embedding; caller passes vectors, useful as the
zero-dependency default) and `MockEmbeddingProvider` (deterministic hashed
output, intended for tests and quickstarts only — explicitly *not* suitable for
real semantic retrieval). `MockEmbeddingProvider` remains a core export in
v0.3 for zero-dependency examples, but it MUST emit a single
`TRGT_MOCK_PROVIDER_NON_PRODUCTION` warning per process when used outside
`NODE_ENV === 'test'`.

#### Provider Adapters

The `EmbeddingProvider` interface is the v0.3 contract; the *packaging* of
external reference adapters (Ollama, Transformers.js, OpenAI) is
**explicitly out of v0.3's public contract**. The 0.3.0 implementation may
ship them as subpath exports (`trageti/providers/ollama`), as companion
packages (`@trageti/provider-ollama`), or both, and may change the
distribution shape in any patch or minor release without it being a
breaking change. Adopters who need stable adapter import paths should pin
to the specific subpath or companion package they consume, or implement
the `EmbeddingProvider` interface themselves.

Reference adapters planned for the initial release:

- `OllamaEmbeddingProvider` — local Ollama HTTP server.
- `TransformersJsEmbeddingProvider` — in-process via `@xenova/transformers`.
- `OpenAIEmbeddingProvider` — OpenAI-compatible HTTP API.

Each adapter declares its own optional peer dependency. The core package
never takes a runtime dependency on an adapter; the `EmbeddingProvider`
interface, `RawVectorProvider`, and `MockEmbeddingProvider` are the only
provider-related surfaces in core, and those are in contract.

#### Failure Semantics in Indexing

`EmbeddingProvider.embed(texts)` is a **batch-call** contract: it accepts an
array of strings and either returns a same-length array of vectors or throws.
Providers that fail mid-batch internally are not required to identify which
item failed — that information is inherently lost across the call boundary.
v0.3 reconciles this with the per-item granularity callers want from
`onProviderError: 'skip'` by changing how the library calls the provider in
each mode:

- **`'fail-fast'` (default).** The library calls `provider.embed(texts)`
  once with the full batch. A throw aborts the operation with
  `EmbeddingProviderError({ batchSize: N, indexed: M, cause })`, where `M`
  is the count of assertions successfully written to vec0 BEFORE the failed
  `embed` call (from prior iterations of the chunked write loop, if the
  caller passed an oversized batch that the library internally chunked by
  `IndexBatchOptions.batchSize`, default 64).
  No `IndexBatchResult` is returned in this mode — the partial-count
  information is on the thrown error. The library cannot promise a
  `failedAt` index because the provider's batch contract does not surface
  per-item failure.
- **`'skip'`.** The library iterates the input one item at a time, calling
  `provider.embed([text])` per assertion. A throw on item N records
  `{ assertionId, reason: 'EMBEDDING_PROVIDER_ERROR', errorCode }` in
  `IndexBatchResult.skipped` and continues with item N+1. `errorCode` is a
  short, sanitized stable identifier derived from the thrown error (e.g.
  the error's `.code`, or `'UNKNOWN'` for plain `Error`); it is NOT the
  raw `Error` object, NOT a stack trace, and NOT the underlying message —
  the result envelope is intended to be safe to log and ship to dashboards
  per the Logger field-sensitivity rules. Callers that need the underlying
  `cause` should use `'fail-fast'` (which surfaces the full error object
  via the thrown `EmbeddingProviderError`). The granularity-vs-latency
  trade-off is that `'skip'` is roughly N× slower than `'fail-fast'` for
  providers whose batch latency is dominated by network round-trips; the
  spec recommends `'fail-fast'` for normal operation and `'skip'` only for
  one-off recovery passes or known-flaky providers.

`reindexNamespace()` honors `onProviderError` on `ReindexOptions`:

- **`'fail-fast'` (default).** Aborts the staging build on the first
  provider throw. With `strategy: 'staging-swap'` (default), the staging
  table is discarded and the previous live index is preserved unchanged.
  With `strategy: 'in-place'`, the namespace is left partially indexed at
  the failure point (the documented trade-off of `'in-place'`).
- **`'skip'`.** Iterates per-item and accumulates failures in
  `ReindexResult.skipped`. With `strategy: 'staging-swap'`:
  - If `skipped.length === 0`, the swap proceeds normally; the new index
    is complete.
  - If `skipped.length > 0` AND `allowPartialSwap === true`, the swap
    proceeds; the new index is missing the skipped assertions (callers
    accept this trade-off explicitly). `swappedAt` is populated.
  - If `skipped.length > 0` AND `allowPartialSwap !== true`, the staging
    table is discarded and `reindexNamespace()` throws `ReindexError` with
    `{ skipped, code: 'REINDEX_PARTIAL_REJECTED', advice: 'pass
    allowPartialSwap: true to accept the partial result, or rerun with
    onProviderError: \'fail-fast\' to surface the cause' }`. The previous
    live index is preserved unchanged. This is the safe default — a
    complete live index is never silently replaced by a partial one.
  - With `strategy: 'in-place'`, `'skip'` builds best-effort and reports
    `skipped[]` in the result; there is no atomic swap to gate.

The earlier "staging swap occurs only after all embeddings are generated
and validated" invariant holds when `onProviderError` is `'fail-fast'`
(default) AND when `'skip'` produced no failures. The `allowPartialSwap`
opt-in is the documented way to relax it — and the only way.

### Logger

```typescript
interface Logger {
  debug(code: string, fields?: Record<string, unknown>): void
  info(code: string, fields?: Record<string, unknown>): void
  warn(code: string, fields?: Record<string, unknown>): void
  error(code: string, fields?: Record<string, unknown>): void
  /** Optional. When present, awaited during `store.close()` so buffered
   *  records are written before the store resolves. May be synchronous or
   *  return a Promise; the library awaits the result either way. */
  flush?(): void | Promise<void>
}
```

Default logs must not include assertion content, episode content, embeddings,
query text, excerpts, secrets, or connection strings.

#### Field Conventions

Library-emitted log records follow a small, stable convention so consumers can
write structured queries against them without parsing free text:

- All log codes use the `TRGT_` prefix and `SCREAMING_SNAKE_CASE` (e.g.
  `TRGT_REINDEX_STAGING_LEFTOVER`). Codes are stable across patch releases and
  follow standard deprecation policy across minor releases.
- Field keys use `camelCase` (e.g. `assertionId`, `namespace`, `tookMs`).
- When applicable, records include `namespace`, plus the most-specific entity
  identifier available (`assertionId`, `episodeId`, `linkId`, `citationId`).
- Records never include `content`, `excerpt`, `queryText`, `embedding`, or any
  `*Secret` / `*Token` / `*Path` field. Adapters that need this for debugging
  must opt in explicitly through the consumer's own logger, not through the
  library default.
- Severity is assigned by intent, not by event source: `debug` for diagnostic
  introspection, `info` for normal lifecycle events (rare), `warn` for
  recoverable inconsistencies the library handled, `error` for state the
  library could not handle on its own.

### Metrics (optional)

Logger captures discrete events; production deployments also need counters and
histograms for alerting. v0.3 defines an optional `Metrics` interface with no
default implementation:

```typescript
interface Metrics {
  incr(name: string, fields?: Record<string, string | number>): void
  observe(name: string, value: number, fields?: Record<string, string | number>): void
}
```

When configured via `TemporalStoreOptions.metrics`, the library emits a small
fixed set of measurements: `trageti.retrieve.tookMs` (observe),
`trageti.retrieve.candidateCount` (observe), `trageti.indexBatch.indexed`
(incr), `trageti.indexBatch.skipped` (incr), `trageti.reindex.tookMs`
(observe), `trageti.embeddingProvider.failures` (incr). Metric names and
required fields are spec-stable. When `metrics` is unset, metric emission is a
no-op and must not allocate fallback collectors or write to the logger.

---

## Namespace Configuration

```typescript
interface TemporalStoreOptions {
  namespace: string
  /** Required for vector-configured namespaces; omit (or pair with no
   *  embeddingProvider) for vectorless namespaces. */
  embeddingDimension?: number
  /** When supplied, makes the namespace vector-configured. Provider's
   *  dimension is the namespace dimension unless embeddingDimension is also
   *  supplied; supplying both with different values throws. */
  embeddingProvider?: EmbeddingProvider
  maxEpisodeContentBytes?: number
  graphAdapter?: GraphQueryAdapter
  scorer?: RetrievalScorer
  defaultFormatter?: ContextFormatter
  validators?: AssertionValidator[]
  connectionVerifier?: ConnectionVerifier
  middleware?: RetrievalMiddleware[]
  fts5Tokenizer?: FTS5TokenizerConfig
  schemaExtensions?: SchemaExtensions
  logger?: Logger
  metrics?: Metrics
  validation?: ValidationOptions
}

interface ValidationOptions {
  /** When true, citations with `excerpt: null` are rejected at write time
   *  instead of warned. Recommended for regulated-domain deployments
   *  (medical, legal, mental health, law enforcement). Default: false. */
  requireCitationExcerpt?: boolean
}

/** Read-side namespace metadata returned by introspection helpers. */
interface NamespaceConfig {
  namespace: string
  /** Null for vectorless namespaces. */
  embeddingDimension: number | null
  createdAt: string
  /** Caller-defined arbitrary metadata; stored as JSON in trl_namespaces.config. */
  config: Record<string, unknown>
}
```

**State at namespace creation time** is determined by the supplied options:
a namespace is created **vector-configured** if either `embeddingDimension`
or `embeddingProvider` is supplied; otherwise it is created **vectorless**
(both `trl_namespaces.embedding_dimension` and `embedding_table` are NULL,
the v003 schema CHECK enforces that pair, and no vec0 table is ever
created).

**On reopen, namespace state is determined by what is already stored**, not
by the supplied options. The relevant cases:

- Stored namespace is vector-configured AND the caller supplies a matching
  `embeddingDimension` (or `embeddingProvider.dimension`) → bind and
  proceed.
- Stored namespace is vector-configured AND the caller supplies a
  non-matching dimension → throw `NamespaceDimensionMismatchError`.
- Stored namespace is vector-configured AND the caller supplies neither
  `embeddingDimension` nor `embeddingProvider` → bind and proceed. The
  stored `embedding_dimension` remains the authoritative dimension for
  the namespace and is used at runtime to validate caller-supplied
  vectors. The exact runtime behavior of vector-touching calls in this
  state, by call family:
  - **Caller-supplied vectors** — `indexAssertion(id, embedding)`,
    `indexBatch([{ assertionId, embedding }, ...])`, and
    `retrieve({ queryEmbedding, ... })` all work normally provided
    `sqlite-vec` is loaded AND `embedding.length === storedDimension`.
    A length mismatch throws `IndexingError(EMBEDDING_DIMENSION_MISMATCH)`
    (indexing) or `RetrievalInputError(RETRIEVAL_DIMENSION_MISMATCH)`
    (retrieve). `sqlite-vec` not loaded throws
    `MissingPeerDependencyError`.
  - **Provider-derived indexing** — calling
    `indexBatch([{ assertionId }, ...])` (no `embedding` supplied) records
    each item in `IndexBatchResult.skipped` with
    `reason: 'NO_EMBEDDING_AND_NO_PROVIDER'`. `indexAssertion(id)`
    (single-target) has no result envelope to surface partial failures
    through, so it throws `IndexingError(NO_EMBEDDING_AND_NO_PROVIDER)`
    instead.
  - **Provider-derived retrieval** — `retrieve({ queryText, ... })` with no
    `queryEmbedding` follows the Step 0 routing rules: hybrid degrades to
    BM25-only with `TRGT_RETRIEVE_VECTOR_SKIPPED reason: 'NO_PROVIDER'`;
    `'vector'` strategy throws `RetrievalInputError(RETRIEVAL_REQUIRES_VECTOR_INPUT)`.

  This shape is intentional: it lets ops tools, audit jobs, and
  manual-vector callers reopen vector-configured stores without having to
  persist or supply the original `embeddingProvider`. The stored dimension
  is sufficient for safe runtime validation.
- Stored namespace is vectorless AND the caller supplies neither → bind
  and proceed (vectorless reopen).
- Stored namespace is vectorless AND the caller supplies dimension or
  provider → throw `NamespaceDimensionMismatchError` with the actionable
  message pointing at `upgradeNamespaceToVector()` (no auto-upgrade — see
  Initialization).

Vectorless → vector-configured upgrade is supported via an explicit upgrade
path that sets `embedding_dimension` and `embedding_table` together inside
one transaction (satisfying the CHECK atomically); see Initialization.
`ensureVectorReady()` itself never performs the upgrade.

---

## Schema and Migrations

### Schema

v0.3 keeps the v0.2 core tables:

- `trl_schema_version`
- `trl_namespaces`
- `trl_episodes`
- `trl_assertions`
- `trl_citations`
- `trl_links`
- `trl_fts`
- one `vec0` embedding table per **vector-configured** namespace (vectorless
  namespaces have NO vec0 table; see Initialization for the vector-configured
  vs vector-ready distinction).

Schema hardening focuses on connection enforcement, validation, indexing
behavior, namespace lifecycle, and the v003 migration that introduces
optional vector storage.

### Migration v003 — Optional vector storage

v003 relaxes `trl_namespaces.embedding_dimension` and `embedding_table` to
nullable, with a `CHECK` constraint enforcing the both-null-or-both-non-null
invariant:

```sql
-- v003: optional vector storage at the namespace level.
-- Column order matches v001 (created_at before config) to keep the schema
-- diff minimal. The INSERT below uses explicit column lists regardless,
-- to prevent positional-mismatch bugs if column order ever drifts.
CREATE TABLE trl_namespaces_v3 (
  namespace            TEXT PRIMARY KEY,
  embedding_dimension  INTEGER,
  embedding_table      TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  config               TEXT NOT NULL DEFAULT '{}',  -- preserved from v001
  CHECK (
    (embedding_dimension IS     NULL AND embedding_table IS     NULL) OR
    (embedding_dimension IS NOT NULL AND embedding_table IS NOT NULL)
  )
);

INSERT INTO trl_namespaces_v3 (
  namespace, embedding_dimension, embedding_table, created_at, config
)
SELECT
  namespace, embedding_dimension, embedding_table, created_at, config
FROM trl_namespaces;

DROP TABLE trl_namespaces;
ALTER TABLE trl_namespaces_v3 RENAME TO trl_namespaces;
```

Existing v0.2 rows always had both fields set, so the migration is
forward-compatible with v0.2 data and preserves all existing namespaces as
vector-configured. The CHECK only constrains future writes.

**Migration-copy invariant.** Every `INSERT ... SELECT` between rebuilt
tables in trageti migrations MUST use explicit column lists on both sides.
`SELECT *` is rejected at code-review time. This applies to v003 and any
future rebuild migration.

### Migration System

Migrations remain versioned. The runner must fail with `MigrationError`
containing the migration version and cause.

```typescript
interface Migration {
  version: number
  name: string
  /** When true, this migration runs OUTSIDE the wrapping transaction so it
   *  can toggle PRAGMA foreign_keys. The migration body MUST NOT BEGIN or
   *  COMMIT — the FK-toggle runner owns the transaction. */
  requiresForeignKeyToggle?: boolean
  up(db: Database): void
}
```

**Standard migrations** are wrapped in a single transaction and the runner
inserts the `trl_schema_version` row inside the same transaction.

**FK-toggle migrations** (`requiresForeignKeyToggle: true`) follow a
runner-owned choreography because `PRAGMA foreign_keys` cannot be changed
inside an active transaction:

```text
runFkToggleMigration(migration, db):
  capturedFk = db.pragma('foreign_keys', { simple: true })
  db.pragma('foreign_keys = OFF')           # outside any transaction
  txn = null
  try:
    txn = db.exec('BEGIN')
    migration.up(db)                         # body MUST NOT BEGIN/COMMIT
    rows = db.pragma('foreign_key_check')
    if rows.length > 0:
      throw MigrationError({
        version: migration.version,
        cause: 'FK violations after migration body',
        violations: rows
      })
    db.prepare('INSERT INTO trl_schema_version ...').run(migration.version, ...)
    db.exec('COMMIT')
    txn = null
  finally:
    if txn !== null: db.exec('ROLLBACK')
    db.pragma(`foreign_keys = ${capturedFk ? 'ON' : 'OFF'}`)
```

This guarantees: the schema change and the `trl_schema_version` insert are
atomic, FK enforcement is restored to its captured value regardless of failure
path, and a failed FK-toggle migration leaves the database at the prior
schema version. Child-table FK references (`trl_episodes.namespace`,
`trl_assertions.namespace`, `trl_links.namespace`) survive the v003 rebuild
because SQLite stores FK definitions in the *referencing* table's schema
string; the post-migration `foreign_key_check` confirms this.

**Operational note:** FK-toggle migrations require the database to be
quiesced — no other connection should hold an active transaction during their
run.

**Tokenizer-incompatible scenarios.** The migration system does not silently
ignore incompatible operator choices such as changing FTS tokenizer
configuration after data exists. v0.3 fails closed with
`MigrationCompatibilityError` carrying a machine-readable `recovery`
descriptor (e.g.
`{ kind: 'rebuild-fts', estimatedRows: number, command: 'store.rebuildFts(...)' }`)
that the caller can act on. Warning-and-proceeding is rejected because it
silently produces wrong results for FTS queries against pre-existing data.

If migration of version `v_n` fails after partial application, the migration
runner rolls back the wrapping transaction (or, for FK-toggle migrations, the
runner-owned transaction) and throws `MigrationError` with
`{ migrationVersion: n, cause }`. The database is left at version `v_(n-1)`,
i.e. fully consistent with the previous schema. Recovery is to fix the
underlying cause and re-run; no manual cleanup is required.

---

## Initialization

### Vector-configured vs vector-ready

v0.3 distinguishes three namespace states:

- **vector-configured namespace** — has either `embeddingDimension` or an
  `EmbeddingProvider` configured at registration time. Both
  `embedding_dimension` AND `embedding_table` columns of `trl_namespaces` are
  populated atomically at registration: dimension comes from the caller (or
  provider), and `embedding_table` is the deterministic name computed by the
  existing namespace-hash helper. The schema CHECK constraint enforces
  both-non-null.
- **vectorless namespace** — neither `embeddingDimension` nor
  `embeddingProvider` configured. Both `embedding_dimension` and
  `embedding_table` columns are NULL. The CHECK enforces both-null.
- **vector-ready namespace** — vector-configured AND `sqlite-vec` is loaded
  AND the per-namespace vec0 virtual table physically exists.

`init()` and `initNamespace()` create the vec0 virtual table only **lazily**.
They never require `sqlite-vec`, regardless of provider configuration. The
`embedding_table` metadata is set at registration whether or not the virtual
table itself has been created — it is the *planned* table name, not proof of
existence (see Maintenance → `getStats`/`getPendingIndexing`). This is what
makes the optional-peer story work: `npm install trageti better-sqlite3`
(no `sqlite-vec`) suffices for stores that operate vectorlessly or in
hybrid mode with text-only inputs.

### Recommended Path — `TemporalStore.create()`

```typescript
const store = await TemporalStore.create({
  database: 'rag.db',
  namespace: 'case-123',
  embeddingProvider: provider,
})
```

```typescript
interface CreateOptions extends TemporalStoreOptions {
  /** Filename, ':memory:', or an already-prepared better-sqlite3 Database. */
  database: string | Database
  /** Forwarded to prepareDatabase() when `database` is a string. */
  prepare?: PrepareDatabaseOptions
  /** Controls whether store.close() also closes the underlying
   *  better-sqlite3 Database handle.
   *
   *  Default is **ownership-driven**:
   *  - When `database` is a string (trageti opened the handle), defaults
   *    to `true` — closing the store closes the handle trageti owns.
   *  - When `database` is a Database instance (caller opened the handle),
   *    defaults to `false` — caller retains ownership and is responsible
   *    for closing it.
   *
   *  Explicitly set this to override. Set `false` with a filename input
   *  when the underlying handle should outlive the store (rare); set
   *  `true` with a caller-supplied Database to transfer ownership to
   *  trageti. */
  closeDatabaseOnStoreClose?: boolean
}

namespace TemporalStore {
  function create(options: CreateOptions): Promise<TemporalStore>
}
```

`TemporalStore.create()` is async because `EmbeddingProvider` initialization
may itself be async (model load, server handshake). The factory is the
recommended path for >95% of consumers and handles: opening or accepting the
database; loading `sqlite-vec` (when `prepare.loadSqliteVec` is true);
applying recommended pragmas; running migrations; verifying connection state;
registering the namespace; and returning a fully initialized store.

The factory returns a plain `TemporalStore`. v0.3 deliberately does NOT brand
the returned type as `InitializedTemporalStore` (a previous design proposed
this); type-branding instance methods would require a `this:` parameter on
every method, which is verbose, hostile to extension, and provides marginal
safety over the runtime guards. Instead, every public method calls an
internal `requireOpen()` guard that throws `StoreClosedError` if the store
was closed, and `NamespaceNotInitializedError` if the namespace's lazy init
has not completed. The factory ensures both conditions are satisfied at
return time.

### Low-Level Path

Advanced callers may still provide their own database and call initialization
explicitly:

```typescript
const db = prepareDatabase('rag.db')
const store = new TemporalStore(db, {
  namespace: 'case-123',
  embeddingDimension: 768,
})
await store.init()
```

This path exists for embedding in larger applications that already control
database lifecycle. The constructor + `init()` pair remains synchronous to
construct but `init()` is async (matching the all-async public API policy).

### `prepareDatabase()`

```typescript
/** Re-exported alias for better-sqlite3's constructor options, so callers
 *  can pass strongly-typed forwarding options without importing
 *  better-sqlite3's types directly. */
export type BetterSqlite3Options = import('better-sqlite3').Database.Options

interface PrepareDatabaseOptions {
  /** When true (default), attempts to require('sqlite-vec') and load it.
   *  When false, the caller must load the extension or accept that vector
   *  operations on this database will fail. */
  loadSqliteVec?: boolean
  /** PRAGMA journal_mode value. Default 'WAL'. */
  journalMode?: 'WAL' | 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'OFF'
  /** PRAGMA busy_timeout in milliseconds. Default 5000. */
  busyTimeoutMs?: number
  /** PRAGMA temp_store value. Default 'MEMORY'. */
  tempStore?: 'DEFAULT' | 'FILE' | 'MEMORY'
  /** Additional pragmas applied verbatim after defaults. */
  pragmas?: Record<string, string | number>
  /** Forwarded to `new Database(filename, options)` when source is a
   *  filename. Ignored when source is an existing Database. */
  betterSqlite3?: BetterSqlite3Options
}

function prepareDatabase(
  source: string | Database,
  options?: PrepareDatabaseOptions,
): Database
```

If `source` is a string, a new `better-sqlite3` database is opened. If it is
an existing `Database` handle, the same instance is returned with pragmas
applied in place. When `loadSqliteVec` is true and `sqlite-vec` is not
installed, `prepareDatabase()` throws `MissingPeerDependencyError`
(`{ packageName: 'sqlite-vec', installCommand: 'npm install sqlite-vec',
alternative: "set loadSqliteVec: false and use vectorless namespaces or
load the extension manually" }`).

**`prepareDatabase()` is intentionally the one synchronous public function
in v0.3.** It wraps only synchronous operations: `new Database(...)` from
`better-sqlite3`, `db.loadExtension(...)` for `sqlite-vec` (synchronous),
and `db.pragma(...)` calls. There is no async work to await, so a
Promise-returning wrapper would be ceremony without payoff. It is safe to
call indirectly from inside `await TemporalStore.create({ database: 'rag.db' })`
(which the factory does on the caller's behalf when `database` is a string).

### `ensureVectorReady()` — single chokepoint for vec0-touching paths

The library never creates the per-namespace vec0 virtual table at init time.
Instead, an internal `ensureVectorReady(namespace)` helper guards every code
path that needs the vec0 table to exist:

```text
ensureVectorReady(namespace):
  - If namespace is not vector-configured:
    throw RetrievalInputError(RETRIEVAL_NAMESPACE_VECTORLESS)
        or IndexingError(INDEXING_NAMESPACE_VECTORLESS) per call site.
  - If sqlite-vec is not loaded:
    throw MissingPeerDependencyError({
      packageName: 'sqlite-vec',
      installCommand: 'npm install sqlite-vec',
      alternative: "use retrievalStrategy: 'bm25'"
    }).
  - If the vec0 table for the namespace does not exist:
    CREATE it now using the stored embedding_dimension and the stored
    embedding_table name. Existence MUST be checked with sqlite_master
    before CREATE VIRTUAL TABLE; do not rely on CREATE VIRTUAL TABLE IF
    NOT EXISTS because sqlite-vec vec0 support for that syntax varies by
    version. (Both fields were populated atomically at
    namespace registration; ensureVectorReady() does NOT patch
    embedding_table because the schema CHECK forbids the partial state
    where dimension is set but table name is not. If ensureVectorReady
    encounters that impossible state, it throws an internal error —
    indicates a corrupt trl_namespaces row.)
  - Return.

Called by:    indexAssertion, indexBatch, reindexNamespace,
              retrieve Step 2 (vector candidate selection).
NOT called by: writes (writeEpisode, writeAssertion, writeCitation, writeLink),
              retrieve Step 1 (temporal filter),
              retrieve Step 2-bm25 (FTS-only candidate selection),
              retrieve Step 3 (keyword re-ranking — FTS-based, not vector),
              graph traversal (getConnected, findPath),
              snapshots/history (getEntityHistory, getEntityTrajectory,
                                 getTemporalSnapshot),
              stats (getStats), explain, close,
              schema introspection (getMigrations, getCurrentSchemaVersion),
              getPendingIndexing.
```

A vectorless namespace can be upgraded to vector-configured only via the
explicit `store.upgradeNamespaceToVector()` API (see Maintenance), which
sets `embedding_dimension` and `embedding_table` together inside one
transaction, satisfying the CHECK constraint atomically. **Reopening a
vectorless namespace with `embeddingProvider` or `embeddingDimension` set in
`TemporalStoreOptions` does NOT auto-upgrade**: `init()` throws
`NamespaceDimensionMismatchError` with the message
`"namespace '<name>' is vectorless; pass it to
store.upgradeNamespaceToVector() to add a vector configuration."` This
fail-closed behavior makes upgrade an explicit, auditable operation rather
than a side effect of changing call-site options. `ensureVectorReady` never
performs the upgrade — it only operates on already-configured namespaces.

---

## API

**All public `TemporalStore` methods return Promises.** v0.3 adopts a uniform
async contract across writes, retrieval, indexing, introspection, and
lifecycle. Internal repositories and the migration runner remain synchronous —
the async boundary is the public API, not the storage layer. This is an
intentional clean-break migration cost: it avoids permanently splitting the API
into sync and async variants as soon as a call path can involve embedding
providers, middleware, lifecycle hooks, remote/vector backends, or future async
extension points such as validators. Consumers pay the `await` migration once
instead of learning which methods are conditionally async based on runtime
configuration.

### Writing

```typescript
store.writeEpisode(episode: Omit<Episode, 'createdAt'>): Promise<Episode>
store.writeAssertion(input: NewAssertionInput): Promise<Assertion>
store.writeCitation(citation: NewLateCitation): Promise<AssertionCitation>
store.writeLink(link: Omit<AssertionLink, 'createdAt'>): Promise<AssertionLink>
```

`writeAssertion(input)` is the canonical supersession API. The first step
inside `writeAssertion()` normalizes any omitted nullable fields to `null`
(see Core Concepts → Assertion); structural invariants, configured
`AssertionValidator.validate()` calls, and repository writes all run on the
normalized shape. When `supersedesId` is non-null after normalization, the
store atomically sets the predecessor's `validUntil` to the new assertion's
`validFrom` inside the same transaction. Direct calls to
`supersedeAssertion()` are not part of the primary v0.3 API. The retained
escape hatch for closing an assertion without a replacement is
`store.advanced.closeAssertion()`, which emits the standard
`TRGT_DEPRECATED_USAGE` warning when used as a migration bridge from older
call sites.

### Indexing

```typescript
interface IndexBatchItem {
  assertionId: string
  /** Optional pre-computed embedding. Required if no EmbeddingProvider is
   *  configured for the namespace. */
  embedding?: Float32Array | number[]
}

interface IndexBatchOptions {
  /** Behavior when EmbeddingProvider throws on a single item. Default 'fail-fast'. */
  onProviderError?: 'fail-fast' | 'skip'
  /** Provider batch size for fail-fast mode. Default 64. Ignored when
   *  onProviderError is 'skip' because skip mode embeds one item at a time. */
  batchSize?: number
  /** Cooperative cancellation. */
  signal?: AbortSignal
}

interface IndexBatchResult {
  indexed: number
  /** Per-item failures collected when onProviderError is 'skip', plus
   *  any caller-input failures (e.g. NO_EMBEDDING_AND_NO_PROVIDER). The
   *  errorCode is a short sanitized stable identifier — never a raw
   *  Error, message, or stack trace. When present, errorCode MUST be a
   *  non-empty string; otherwise omit the property. */
  skipped: Array<{ assertionId: string; reason: string; errorCode?: string }>
}

store.indexAssertion(
  assertionId: string,
  embedding?: Float32Array | number[],
): Promise<void>

store.indexBatch(
  items: IndexBatchItem[],
  options?: IndexBatchOptions,
): Promise<IndexBatchResult>

store.getPendingIndexing(namespace: string): Promise<Array<{ id: string; content: string }>>
```

Both `indexAssertion` and `indexBatch` call `ensureVectorReady(namespace)`
internally before any vec0 write, regardless of whether the embedding came
from the caller or from a configured provider. A vectorless namespace causes
both calls to throw `IndexingError(INDEXING_NAMESPACE_VECTORLESS)`; a
vector-configured namespace without `sqlite-vec` loaded throws
`MissingPeerDependencyError`.

If an `EmbeddingProvider` is configured, `embedding` may be omitted and
generated from assertion content. Without a provider, vectors remain
required and an omitted `embedding` is recorded in
`IndexBatchResult.skipped` with `reason: 'NO_EMBEDDING_AND_NO_PROVIDER'`.

**Unknown assertion IDs.** When `indexBatch()` is called with an
`assertionId` that does not exist in `trl_assertions` for the namespace,
the item is recorded in `IndexBatchResult.skipped` with
`reason: 'ASSERTION_NOT_FOUND'`. `onProviderError` does not apply (no
provider call is made for a non-existent assertion); the entry appears in
`skipped[]` regardless of mode. This makes ingestion bugs auditable instead
of silent (the v0.2 behavior of silently dropping unknown IDs is removed —
that was a flagged P1).

`indexAssertion()` (single-target) takes the stricter path: an unknown
`assertionId` throws `IndexingError(ASSERTION_NOT_FOUND)`. Single-target
calls do not have a result envelope to surface partial failures through, so
fail-closed is the only safe behavior.

`IndexBatchResult` invariants: `skipped[]` preserves input order, and
`indexed + skipped.length === items.length` for every non-throwing batch call.
In fail-fast mode, `EmbeddingProviderError.indexed` reflects only rows written
before the failed provider batch; because provider calls are chunked by
`IndexBatchOptions.batchSize`, callers should not infer a failed item index
from that count.

`getPendingIndexing()` semantics across the four observable
`(sqlite-vec loaded × vec0 exists)` states are documented under
Maintenance → `getStats` and `getPendingIndexing` below.

### Retrieval

```typescript
type RetrievalStrategy = 'hybrid' | 'vector' | 'bm25'
type RetrievalMode = 'snapshot' | 'trajectory'
type QueryTextMode = 'phrase' | 'fts5'

interface RetrievalQuery {
  namespace: string
  queryEmbedding?: Float32Array | number[]
  queryText?: string
  queryTextMode?: QueryTextMode
  temporalAnchor: number
  temporalWindow?: { from?: number; to?: number }
  entityTypes?: string[]
  assertionTypes?: string[]
  minConfidence?: number
  includeSuperseded?: boolean
  expandLinks?: boolean
  maxDepth?: number
  limit?: number
  /** Default 'snapshot'. Selects whether retrieval returns the assertion at
   *  temporalAnchor (snapshot) or follows the supersession chain
   *  (trajectory). Distinct from retrievalStrategy. */
  mode?: RetrievalMode
  /** Default 'hybrid'. Selects which retrieval signals are required and run.
   *  Distinct from mode. */
  retrievalStrategy?: RetrievalStrategy
  scorer?: RetrievalScorer
  middleware?: RetrievalMiddleware[]
  /** Cooperative cancellation. Honored at every step boundary and propagated
   *  to EmbeddingProvider.embed(). */
  signal?: AbortSignal
  /** Per-step introspection hook for development and profiling. */
  debug?: RetrievalDebug
}

interface RetrievalResult {
  results: RetrievedAssertion[]
  meta: {
    namespace: string
    temporalAnchor: number
    limit: number
    candidateCount: number
    /** Which signals actually contributed to the result. */
    retrievalStrategy: RetrievalStrategy
    vectorApplied: boolean
    bm25Applied: boolean
    queryTextMode: QueryTextMode | null
    tookMs?: number
    warnings: Array<{ code: string; message: string }>
  }
}

interface RetrievedAssertion extends Assertion {
  /** Final score from the configured RetrievalScorer; higher = better. */
  score: number
  /** Raw scorer inputs, always populated for transparency and audit. */
  scoreComponents: {
    /** Cosine distance from sqlite-vec; lower = more similar. Null when
     *  this candidate was selected by BM25-only path (Step 2-bm25) or
     *  when the vector step was skipped via hybrid fallback. */
    semanticDistance: number | null
    /** Raw FTS5 BM25 score; null when this candidate did not contribute
     *  to (or did not match) the BM25 step. More-negative = better. */
    bm25Score: number | null
    /** The assertion's validFrom, used for recency. */
    position: number
  }
  /** Populated only when query.expandLinks === true. Graph-expanded
   *  neighbors out to query.maxDepth, with full citations. */
  linkedAssertions?: Assertion[]
  /** Populated only when query.mode === 'trajectory'. Contains all *prior*
   *  versions of this assertion in chronological order (oldest first),
   *  each with full citations. Empty array means trajectory mode was
   *  requested but this result has no predecessors. Absent in snapshot
   *  mode (the default). */
  supersessionChain?: Assertion[]
}

store.retrieve(query: RetrievalQuery): Promise<RetrievalResult>
```

**Per-strategy input invariants** (rejected early as `RetrievalInputError`):

- **`'hybrid'` (default).** At least one of `queryEmbedding` or non-empty
  `queryText` MUST be supplied. Hybrid runs whichever signals are available
  and silently degrades the optional vector step when capabilities are
  missing — see the degradation rules under Retrieval Implementation below.
- **`'vector'`.** `queryEmbedding` MUST be supplied directly OR (`queryText`
  + an `EmbeddingProvider` configured for the namespace). `sqlite-vec` MUST
  be loaded; otherwise throws `MissingPeerDependencyError`.
- **`'bm25'`.** Non-empty `queryText` MUST be supplied. `queryEmbedding` is
  ignored if supplied. No provider needed. No `sqlite-vec` needed. This is
  the path that supports the BM25-only / vectorless deployment shape from
  the Quickstart.

Concrete error codes are listed under Error Model. Note: there is no
`RETRIEVAL_REQUIRES_VECTOR_BACKEND` code — that condition raises
`MissingPeerDependencyError`, the single canonical error for "sqlite-vec
not loaded."

### Context Assembly

```typescript
interface ContextAssemblyOptions {
  namespace: string
  /** Optional in v0.3 (was required in v0.2). Required only when the
   *  resolved retrievalStrategy reaches Step 2 (vector candidate
   *  selection) AND no queryText + EmbeddingProvider combination is
   *  available to derive it. */
  queryEmbedding?: Float32Array | number[]
  queryText?: string
  queryTextMode?: QueryTextMode
  temporalAnchor: number
  /** Soft cap on rendered context size; the formatter respects it and
   *  reports actual usage in AssembledContext.tokenEstimate. */
  tokenBudget: number
  expandLinks?: boolean
  maxDepth?: number
  /** Default 'snapshot'. Propagates to retrieve(). Distinct from
   *  retrievalStrategy. */
  mode?: RetrievalMode
  /** Default 'hybrid'. Propagates to retrieve(). Distinct from mode. */
  retrievalStrategy?: RetrievalStrategy
  scorer?: RetrievalScorer
  middleware?: RetrievalMiddleware[]
  /** Per-call formatter override. */
  formatter?: ContextFormatter
  signal?: AbortSignal
  debug?: RetrievalDebug
}

interface AssembledContext {
  /** Rendered text from the configured formatter. */
  text: string
  /** The full RetrievedAssertion[] used to compose `text`, post-truncation. */
  assertions: RetrievedAssertion[]
  /** Formatter's estimate of the rendered output's token cost. */
  tokenEstimate: number
  /** True iff the formatter dropped assertions to fit tokenBudget. */
  truncated: boolean
  /** Formatter-specific metadata; opaque to the library. */
  metadata: Record<string, unknown>
  /** Coverage stats relative to retrieval. `totalAssertions` is what
   *  retrieve() returned; `includedAssertions` is what survived
   *  truncation. */
  coverage: {
    totalAssertions: number
    includedAssertions: number
    /** validFrom range across the included assertions. */
    positionRange: { from: number; to: number }
  }
}

store.assembleContext(options: ContextAssemblyOptions): Promise<AssembledContext>
```

Context assembly synthesizes a `RetrievalQuery` from `ContextAssemblyOptions`,
calls `retrieve()` internally, then applies the configured (or
per-call-overridden) `ContextFormatter` to produce the envelope. The
formatter contract must expose included count explicitly through the
returned envelope; context assembly must not infer truncation state from
formatter-private keys.

### Temporal Snapshot, Entity History, Trajectory

```typescript
store.getTemporalSnapshot(namespace: string, temporalAnchor: number): Promise<Assertion[]>
store.getEntityHistory(namespace: string, entityId: string): Promise<Assertion[]>
store.getEntityTrajectory(namespace: string, entityId: string): Promise<Assertion[]>
```

These return assertions valid at (or evolving through) the requested position.
None call `ensureVectorReady()` — they are pure SQL paths over `trl_assertions`
and never touch vec0.

`getEntityTrajectory()` follows v0.2 semantics: within the entity's assertion
set, walks `supersedesId` relationships from leaf assertions backward; merges
discovered rows with non-chain entity assertions (each as a one-element
trajectory) into a single array ordered by `validFrom` ASC. Distinct from
`getEntityHistory()` only in the underlying walk (the `supersedesId` graph);
for entities with no supersession structure, the two methods return the same
rows.

### Graph Traversal

```typescript
interface TraversalOptions {
  namespace: string
  /** Source assertion(s) to traverse from. Single id for getConnected;
   *  findPath uses the dedicated fromAssertionId on PathOptions. */
  fromAssertionId: string
  temporalAnchor: number
  /** No hard cap; caller and adapter negotiate practical limits. */
  maxDepth: number
  /** undefined = all link types. */
  linkTypes?: string[]
  /** Include links to assertions whose validUntil has passed at
   *  temporalAnchor. Default false. */
  includeSuperseded?: boolean
}

interface PathOptions extends Omit<TraversalOptions, 'fromAssertionId'> {
  fromAssertionId: string
  toAssertionId: string
}

store.getConnected(options: TraversalOptions): Promise<Assertion[]>
store.findPath(options: PathOptions): Promise<AssertionLink[] | null>
```

`findPath()` returns the complete ordered path: `path[0].fromId === fromAssertionId`,
each adjacent link connects, and the final link's `toId === toAssertionId`.
If `fromAssertionId === toAssertionId`, `findPath()` returns `[]` (zero-hop
path) without consulting graph links. Cycle protection uses a visited assertion
set; a returned path never repeats an assertion ID. When multiple paths exist,
the default adapter returns the first deterministic shortest path within
`maxDepth` using the same stable ordering as retrieval (`createdAt ASC`,
`id ASC` for otherwise equal links); if no path is found within `maxDepth`, it
returns `null`. This is inherited baseline behaviour shared with v0.2.

### Maintenance

```typescript
interface DeleteNamespaceOptions {
  /** When true, runs DELETE FROM <table> WHERE <namespaceColumn> = ? for every
   *  extension table marked referencesNamespace: true. Without it, those
   *  extensions cause deleteNamespace() to throw ReferencedExtensionTableError
   *  listing them. */
  cascade?: boolean
}

interface ReindexOptions {
  /** New dimension when re-embedding through a different model. Omit to
   *  keep the namespace's existing dimension. */
  newDimension?: number
  /** Required if newDimension is set or assertions need (re)embedding.
   *  Falls back to the namespace's configured provider otherwise. */
  embeddingProvider?: EmbeddingProvider
  /** Default 'staging-swap'. 'in-place' is an advanced option that loses the
   *  prior index if the provider fails mid-run. */
  strategy?: 'staging-swap' | 'in-place'
  /** Per-batch size for embedding calls. Default 64. */
  batchSize?: number
  /** Behavior when EmbeddingProvider throws on an item during the staging
   *  build. Default 'fail-fast' (entire reindex aborts; staging table is
   *  discarded; previous live index is preserved when strategy is
   *  'staging-swap'). 'skip' iterates per-item and accumulates failures in
   *  ReindexResult.skipped. Same trade-off as IndexBatchOptions.onProviderError. */
  onProviderError?: 'fail-fast' | 'skip'
  /** Required to perform the staging swap when 'skip' produced any
   *  ReindexResult.skipped entries — without it, a partial staging build
   *  is rejected so a complete live index is never silently replaced by
   *  one missing skipped rows. Has no effect with 'fail-fast' (no
   *  skipped[] possible). Has no effect with 'in-place' (no atomic swap
   *  occurs). Default false. */
  allowPartialSwap?: boolean
  signal?: AbortSignal
}

interface ReindexResult {
  reindexed: number
  /** Per-item failures collected when onProviderError is 'skip'. Same
   *  sanitization rules as IndexBatchResult.skipped — errorCode is a
   *  short stable identifier, never a raw Error, message, or stack. */
  skipped: Array<{ assertionId: string; reason: string; errorCode?: string }>
  /** ISO 8601. Present only when strategy: 'staging-swap' actually swapped
   *  (either skipped.length === 0, or skipped.length > 0 with
   *  allowPartialSwap: true). Absent for 'in-place' (no atomic swap
   *  occurs), for failures, and for partial builds that were rejected for
   *  lack of allowPartialSwap. */
  swappedAt?: string
  durationMs: number
}

interface RebuildFtsOptions {
  /** New tokenizer config. Validated against the v0.3 allow-list. Omit to
   *  keep current config (rebuild remains useful for repair). */
  tokenizer?: FTS5TokenizerConfig
  /** Per-batch row size during rebuild. Default 1000. */
  batchSize?: number
  signal?: AbortSignal
}

interface RebuildFtsResult {
  reindexedRows: number
  /** The tokenizer active after rebuild. If options.tokenizer was omitted
   *  for a repair-only rebuild, this is the previously configured tokenizer. */
  newTokenizer: FTS5TokenizerConfig
  durationMs: number
}

interface NamespaceStats {
  /** Echo of the requested namespace. */
  namespace: string
  /** Null for vectorless namespaces; otherwise the dimension recorded in
   *  trl_namespaces.embedding_dimension at registration time. */
  embeddingDimension: number | null
  /** True iff sqlite-vec is loaded AND the namespace's vec0 virtual table
   *  physically exists. False for: vectorless namespaces; vector-configured
   *  namespaces whose vec0 has not yet been lazily created; vector-configured
   *  namespaces reopened in a process that did not load sqlite-vec. */
  vectorReady: boolean
  /** Episodes registered in trl_episodes for this namespace. */
  episodeCount: number
  /** All assertions in trl_assertions for this namespace, including
   *  superseded ones. */
  assertionCount: number
  /** Active assertions (validUntil IS NULL) in trl_assertions for this
   *  namespace. */
  activeAssertionCount: number
  /** Closed/superseded assertions (validUntil IS NOT NULL). */
  supersededCount: number
  /** Citations in trl_citations whose parent assertion belongs to this
   *  namespace. */
  citationCount: number
  /** Links in trl_links for this namespace. */
  linkCount: number
  /** Vectors in the namespace's vec0 table, when introspectable.
   *  - vectorReady === true: COUNT(*) FROM <vec0>.
   *  - vectorReady === false: 0 (the library does not introspect vec0
   *    when sqlite-vec is unavailable; emits TRGT_STATS_VEC_NOT_INTROSPECTED
   *    at debug for the vec0-exists-but-no-sqlite-vec case so the gap is
   *    observable in logs). */
  indexedCount: number
  /** validFrom range across active assertions for this namespace.
   *  - When the namespace has zero active assertions: { min: null, max: null }.
   *    (Both fields are null together; the library does not emit { min: 0,
   *    max: 0 } or any other sentinel that could be confused with a real
   *    position.)
   *  - Otherwise: { min: <smallest validFrom>, max: <largest validFrom> }. */
  positionRange: { min: number | null; max: number | null }
}

type UpgradeNamespaceToVectorOptions =
  | {
      /** Dimension for the new vector configuration. */
      embeddingDimension: number
      /** Provider to attach. Optional; when supplied, provider.dimension
       *  MUST match embeddingDimension. */
      embeddingProvider?: EmbeddingProvider
    }
  | {
      /** Provider to attach. The provider's dimension becomes the namespace
       *  dimension. */
      embeddingProvider: EmbeddingProvider
      embeddingDimension?: never
    }

interface InitNamespaceOptions {
  /** When supplied, the new namespace is vector-configured with this
   *  dimension. */
  embeddingDimension?: number
  /** When supplied, the new namespace is vector-configured. Provider's
   *  dimension is the namespace dimension unless embeddingDimension is
   *  also supplied (in which case they MUST match). */
  embeddingProvider?: EmbeddingProvider
  /** Caller-defined arbitrary metadata; stored as JSON in
   *  trl_namespaces.config. */
  config?: Record<string, unknown>
}

// Four valid shapes:
//   {}                                        → vectorless namespace
//   { embeddingDimension }                    → vector-configured (manual vectors)
//   { embeddingProvider }                     → vector-configured (dimension from provider)
//   { embeddingDimension, embeddingProvider } → vector-configured (the two MUST agree)

store.initNamespace(
  namespace: string,
  options?: InitNamespaceOptions,
): Promise<NamespaceConfig>

store.deleteNamespace(namespace: string, options?: DeleteNamespaceOptions): Promise<void>
store.reindexNamespace(namespace: string, options?: ReindexOptions): Promise<ReindexResult>
store.rebuildFts(options?: RebuildFtsOptions): Promise<RebuildFtsResult>
store.upgradeNamespaceToVector(
  namespace: string,
  options: UpgradeNamespaceToVectorOptions,
): Promise<void>
store.getStats(namespace: string): Promise<NamespaceStats>
store.getPendingIndexing(namespace: string): Promise<Array<{ id: string; content: string }>>
store.explain(query: RetrievalQuery): Promise<RetrievalExplainResult>
```

```typescript
type RetrievalStep =
  | 'validate' | 'temporal-filter' | 'semantic' | 'keyword'
  | 'score' | 'rank' | 'graph-expand' | 'trajectory-expand'

interface RetrievalExplainStep {
  step: RetrievalStep
  /** Prepared-statement SQL that would run for this step. Omitted for
   *  steps with no SQL (e.g. 'score'). */
  sql?: string
  /** Output of `EXPLAIN QUERY PLAN` for the step's SQL, when applicable. */
  queryPlan?: string
  /** Adapter-best-effort row estimate, when cheaply available. */
  estimatedRows?: number
  /** For 'semantic' only: whether the namespace is vector-ready at
   *  explain time. False indicates the step would either lazily create
   *  vec0 (if sqlite-vec is loaded) or trigger the documented hybrid
   *  fallback. */
  vectorReady?: boolean
}

interface RetrievalExplainResult {
  /** Echo of the input. */
  query: RetrievalQuery
  /** The strategy that would run (after defaults and routing). */
  retrievalStrategy: RetrievalStrategy
  /** Ordered list of steps the pipeline would execute, given current
   *  state. */
  steps: RetrievalExplainStep[]
  /** True iff Step 2 (vector candidate selection) would actually run. */
  wouldApplyVector: boolean
  /** True iff Step 2-bm25 or Step 3 (keyword re-ranking) would run. */
  wouldApplyBm25: boolean
  /** Human-readable notes the explain pass produced (e.g. "would fall
   *  back to BM25-only: no EmbeddingProvider configured"). */
  notes: string[]
}
```

`store.explain(query)` does NOT execute the query. It produces the planned
shape: which steps would run given current namespace state, which SQL each
step would prepare, and which capabilities are missing. Safe to call against
production stores for tuning.

`initNamespace(namespace, options?)` registers an additional namespace
beyond the default one supplied to `TemporalStore.create()` /
`TemporalStoreOptions.namespace`. Multi-namespace stores ARE supported:
write/index/retrieve methods all accept arbitrary `namespace` strings, but
each namespace must have been registered via either the constructor's
default-namespace path OR `initNamespace()` first. Calling a
namespace-bearing method against an unregistered namespace throws
`NamespaceNotInitializedError`.

**Idempotence and persisted state.** `trl_namespaces` persists `namespace`,
`embedding_dimension`, `embedding_table`, `created_at`, and `config` —
NOT `embeddingProvider` identity, which is process-local configuration only.
Idempotence is therefore defined entirely on stored state:

- For an **existing vector-configured namespace**: re-calling
  `initNamespace()` succeeds (no-op on the DB row, returns the existing
  `NamespaceConfig`) when:
  - `embeddingDimension` is supplied AND matches the stored
    `embedding_dimension`; OR
  - `embeddingProvider` is supplied (no `embeddingDimension`) AND the
    provider's `dimension` matches the stored `embedding_dimension`; OR
  - Neither `embeddingDimension` nor `embeddingProvider` is supplied — no
    supplied-dimension comparison is needed at the call site, because none
    was supplied. The stored `embedding_dimension` remains authoritative
    and is still used at runtime to validate caller-supplied vectors per
    the rules in Namespace Configuration. (This is the supported manual-vector
    reopen path: a process can index/retrieve with caller-supplied vectors
    against a vector-configured namespace it never re-declares the
    embedding configuration for.)
  - When `embeddingDimension` AND/OR `embeddingProvider` is supplied and
    mismatches the stored value, throws `NamespaceDimensionMismatchError`.

  The `embeddingProvider` argument is bound to the in-process namespace
  registry when supplied, but it is never compared against any persisted
  provider identity (none exists). Two processes legitimately may use
  different providers against the same vector-configured namespace,
  provided dimensions agree; one process may use a provider while another
  supplies vectors manually.
- For an **existing vectorless namespace**: re-calling `initNamespace()`
  with no `embeddingDimension` and no `embeddingProvider` is a no-op.
  Re-calling with either set throws `NamespaceDimensionMismatchError` with
  the same actionable message documented under Initialization (vectorless
  → vector upgrade requires `upgradeNamespaceToVector()`, not a re-call
  of `initNamespace()`).
- For a **new namespace**: the call inserts the row and returns the new
  `NamespaceConfig`. Vectorless namespaces are created by passing neither
  `embeddingDimension` nor `embeddingProvider`.

`upgradeNamespaceToVector(namespace, options)` is the only path that converts
a vectorless namespace into a vector-configured one. It is rejected if the
namespace is already vector-configured (use `reindexNamespace()` to change
dimension instead). The operation runs inside a single transaction:
populates `trl_namespaces.embedding_dimension` and `embedding_table`
together (satisfying the v003 CHECK), and records the change in the audit
log via `TRGT_NAMESPACE_VECTOR_UPGRADED` at info. The vec0 virtual table
itself is created lazily on the first vector-touching operation per the
standard `ensureVectorReady()` contract — `upgradeNamespaceToVector` does
not require `sqlite-vec` to be loaded at the moment of upgrade, only at the
moment of the first index/retrieve.

Operational note: callers must quiesce other writers before running
`upgradeNamespaceToVector()`. The library does not coordinate multi-process
writes; concurrent readers may observe either the old vectorless metadata or
the new vector-configured metadata depending on transaction timing.

`deleteNamespace()` looks up `embedding_table` from `trl_namespaces`
(DB-authoritative, not from process-local cache). The namespace's own vec0
virtual table IS dropped when present (it belongs to a single namespace by
construction, so the drop is unambiguous). **Extension tables are never
dropped**, regardless of `cascade` — they may hold rows for other
namespaces. When `cascade` is true and any extension is registered with
`referencesNamespace: true`, the library runs the generated
`DELETE FROM <quoted tableName> WHERE <quoted namespaceColumn> = ?` for
each inside the same transaction (per-namespace row removal, no DDL).
Without `cascade`, those extensions cause `deleteNamespace()` to throw
`ReferencedExtensionTableError` listing them. The deletion is transactional —
namespace rows in `trl_namespaces`/`trl_episodes`/`trl_assertions`/
`trl_citations`/`trl_links`/`trl_fts`, the namespace's own vec0 DROP, and
every extension's row-DELETE succeed or fail together. The previous
warn-and-proceed behavior and the `DELETE_NAMESPACE_HAS_REFERENCES` log
code are retired.

`reindexNamespace()` defaults to `'staging-swap'`: builds into a staging vec
table, atomically swaps on success, drops the old table. Under the
`'fail-fast'` default for `onProviderError`, a provider failure preserves
the previous live index unchanged. Under `'skip'`, partial-build behavior
is governed by `allowPartialSwap` (see the Failure Semantics in Indexing
section): without `allowPartialSwap: true`, a partial build is rejected and
the previous live index is preserved; with `allowPartialSwap: true`, the
swap proceeds with the partial new index. `'in-place'` is supported for
callers that explicitly accept the partial-on-failure trade-off.

`rebuildFts()` drops and recreates the global per-database `trl_fts` table
and re-populates from `trl_assertions` in batches inside one write
transaction. The rowid invariant is mandatory: rebuild MUST insert with
`INSERT INTO trl_fts(rowid, content) SELECT rowid, content FROM trl_assertions`
so `trl_fts.rowid === trl_assertions.rowid` remains true for BM25 rowid
joins. Used to switch tokenizers on a populated database (the path the
migration system flags via `MigrationCompatibilityError` with
`{ kind: 'rebuild-fts', ... }`). Throws `MigrationCompatibilityError` if
the new tokenizer fails the v0.3 allow-list.

**Tokenizer config metadata.** The "current tokenizer config" referenced
by `RebuildFtsOptions.tokenizer` defaults is read from library-managed
metadata (a dedicated `trl_fts_config` row inserted by the v001 migration
and updated by every `rebuildFts()` call), NOT parsed from `sqlite_master`'s
stored CREATE statement — SQL DDL parsing is brittle and version-dependent.
The persisted metadata is the source of truth for "what is `trl_fts`
actually tokenized with."

**Re-tokenization.** `rebuildFts()` re-tokenizes **every row in
`trl_assertions`** because tokenizer changes invalidate the index
contents — there is no in-place tokenizer upgrade. With a large corpus
this can be a multi-second-to-minute operation; `batchSize` (default 1000)
controls memory pressure per chunk but does not bound total runtime.

**Operational impact.** The rebuild runs inside one write transaction;
SQLite serializes concurrent writes for its duration, and reads of
`trl_fts` block until the transaction commits. Callers MUST schedule
`rebuildFts()` as a service-impacting maintenance operation and SHOULD
quiesce write traffic to the database first. `signal` allows cooperative
cancellation between batches but cannot interrupt a running SQLite
statement; cancellation granularity is per-batch.

#### `getStats()` and `getPendingIndexing()` — vec0-state matrix

Recall: `vectorReady ⇔ (sqlite-vec loaded) AND (vec0 exists for this
namespace)`. The four observable states for a vector-configured namespace
plus the vectorless case:

| sqlite-vec | vec0 table | vectorReady |
|---|---|---|
| loaded     | exists  | `true`  |
| loaded     | missing | `false` (lazy-create has not run) |
| not loaded | exists  | `false` (vec0 was created in a prior session) |
| not loaded | missing | `false` |
| vectorless namespace | n/a | `false` |

```text
getStats(namespace): Promise<NamespaceStats>  — never calls ensureVectorReady().
                                                Never throws *due to vector
                                                readiness*. Like every public
                                                store method, it still calls
                                                requireOpen() first and may
                                                throw StoreClosedError or
                                                NamespaceNotInitializedError
                                                if the store is in those
                                                states.
  - sqlite-vec loaded   + vec0 exists:    indexedCount = COUNT(*) FROM <vec0>;
                                          vectorReady = true.
  - sqlite-vec loaded   + vec0 missing:   indexedCount = 0;
                                          vectorReady = false.
  - sqlite-vec NOT loaded + vec0 exists:  indexedCount = 0;
                                          vectorReady = false.
                                          (Library does not query vec0
                                          because the module isn't loaded;
                                          emits TRGT_STATS_VEC_NOT_INTROSPECTED
                                          at debug, once per call. Callers
                                          that need the true count must load
                                          sqlite-vec and re-call.)
  - sqlite-vec NOT loaded + vec0 missing: indexedCount = 0;
                                          vectorReady = false.
  - vectorless namespace:                 indexedCount = 0;
                                          vectorReady = false;
                                          embeddingDimension = null.

getPendingIndexing(namespace): Promise<Array<{ id, content }>>
                                — never calls ensureVectorReady(). Like every
                                public store method, calls requireOpen() and
                                may throw StoreClosedError /
                                NamespaceNotInitializedError. May also throw
                                MissingPeerDependencyError in the specific
                                vec0-exists-but-sqlite-vec-not-loaded case
                                below (failing closed avoids catastrophic
                                false-positive re-indexing).
  - sqlite-vec loaded   + vec0 exists:    returns assertions whose id is not
                                          present as assertion_id in the
                                          namespace's vec0 table. (vec0 is
                                          keyed by `assertion_id TEXT
                                          PRIMARY KEY`, not rowid; see
                                          EmbeddingRepository.ensureVec0Table.)
  - sqlite-vec loaded   + vec0 missing:   returns ALL active assertions
                                          (everything is "pending").
  - sqlite-vec NOT loaded + vec0 exists:  THROWS MissingPeerDependencyError
                                          ({ packageName: 'sqlite-vec',
                                             alternative: 'reopen with
                                             loadSqliteVec: true to introspect
                                             indexing status' }).
                                          Reason: returning "all assertions
                                          as pending" against a vec0 table
                                          that may already be fully populated
                                          would trigger catastrophic
                                          false-positive re-indexing. Failing
                                          closed is the only safe choice.
  - sqlite-vec NOT loaded + vec0 missing: returns ALL active assertions.
                                          (Same as the "vec0 missing"
                                          case above — vec0 truly does not
                                          exist, so there is no false-positive
                                          risk; the namespace simply has not
                                          been indexed yet.)
  - vectorless namespace:                 returns [];
                                          emits TRGT_PENDING_INDEXING_VECTORLESS
                                          at debug.
```

The `embedding_table` value in `trl_namespaces` is a **planned table name**
computed deterministically from the namespace at registration time; its
presence in metadata does not prove the virtual table exists. Code paths
that need the existence answer must query `sqlite_master` or use
`getStats().vectorReady`.

**Unregistered namespaces.** `getStats(namespace)` and
`getPendingIndexing(namespace)` both throw `NamespaceNotInitializedError`
when the supplied `namespace` is not present in `trl_namespaces`. This is
consistent with every other public store method: the `requireOpen()` guard
treats unknown namespaces as a precondition failure, not as an empty
result. To distinguish "namespace exists but is vectorless" (returns
`{ ..., vectorReady: false, embeddingDimension: null, ... }`) from
"namespace was never registered" (throws), callers should either always
register via `initNamespace()` first or catch
`NamespaceNotInitializedError` explicitly.
`getStats()` and `getPendingIndexing()` use this same `sqlite_master` lookup
for vec0 existence; they do not infer existence from the planned
`embedding_table` value in `trl_namespaces`.

Required regression test: open a file-backed DB, write assertions, index
them with `sqlite-vec` loaded, close, reopen WITHOUT loading `sqlite-vec`,
then call `getStats()` (must succeed with `vectorReady = false`) and
`getPendingIndexing()` (must throw `MissingPeerDependencyError`).

### Schema Introspection

```typescript
interface MigrationDescriptor {
  version: number
  name: string
  appliedAt: string | null
}

store.getMigrations(): Promise<readonly MigrationDescriptor[]>
store.getCurrentSchemaVersion(): Promise<number>
```

`MigrationDescriptor` is the **read-side, public introspection view** of a
migration — a flat record describing version, name, and applied timestamp.
It is distinct from the executable `Migration` shape used internally by the
migration runner (which carries the `up(db)` body and the
`requiresForeignKeyToggle` flag; see Schema and Migrations). Consumers
never construct or implement `Migration` directly; they observe applied
state through `MigrationDescriptor`.

These exist for ops dashboards, schema-drift monitoring, and pre-deploy
checks. They are pure introspection and do not mutate state.

### Lifecycle

```typescript
store.close(): Promise<void>
```

`close()` marks the store unusable, disposes any middleware or observers
that implement an optional `dispose()` method, flushes the configured logger
if it exposes a `flush()` hook, and resolves. After `close()`, every other
method throws `StoreClosedError`.

Whether `close()` also closes the underlying `better-sqlite3` database
handle is governed by `CreateOptions.closeDatabaseOnStoreClose`, which
defaults to **ownership-driven**: trageti closes the handle iff it opened
it. Concretely:

- `TemporalStore.create({ database: 'rag.db' })` → store opened the
  handle → `close()` closes it. Callers do not need to track the handle.
- `TemporalStore.create({ database: existingDb })` → caller opened the
  handle → `close()` leaves it open. Caller closes when ready.
- Explicit `closeDatabaseOnStoreClose: true | false` overrides the default
  in either direction.

This means the common path — `await TemporalStore.create({ database: 'rag.db' })`
+ `await store.close()` — does not leak the connection. The low-level
`prepareDatabase()` + `new TemporalStore(db, opts)` path is unchanged:
caller owns `db`, caller closes `db`.

`close()` is idempotent.

---

## Retrieval Implementation

### Step 0: Validate, Normalize, and Route

Validate public query fields. Resolve `retrievalStrategy` (default `'hybrid'`)
and apply the per-strategy input invariants from the API section. Normalize
defaults. Resolve namespace dimension.

After validation, Step 0 makes an explicit **routing decision** that
determines whether Step 2 (vector candidate selection) runs at all:

```text
Routing for retrievalStrategy: 'bm25'
  Always skip Step 2; always run Step 2-bm25.

Routing for retrievalStrategy: 'vector'
  Always run Step 2 (input invariants already guaranteed an embedding can
  be obtained — caller supplied queryEmbedding directly, or queryText +
  EmbeddingProvider). Never falls back to BM25.

Routing for retrievalStrategy: 'hybrid' (default)
  - queryEmbedding supplied:                 run Step 2 (Step 2 may throw
                                              MissingPeerDependencyError if
                                              sqlite-vec is missing — it
                                              propagates per the named-input
                                              rule).
  - queryText only + EmbeddingProvider:      first check vector backend
                                              availability and namespace vector
                                              configuration WITHOUT calling
                                              the provider. If sqlite-vec is
                                              missing or the namespace is
                                              vectorless, emit
                                              TRGT_RETRIEVE_VECTOR_SKIPPED and
                                              run Step 2-bm25. Otherwise,
                                              derive query embedding via the
                                              provider, then run Step 2
                                              (which may lazily create vec0);
                                              provider failures propagate as
                                              EmbeddingProviderError.
  - queryText only + no EmbeddingProvider:   skip Step 2 entirely (no
                                              embedding to run it with);
                                              emit TRGT_RETRIEVE_VECTOR_SKIPPED
                                              at info with reason: 'NO_PROVIDER';
                                              run Step 2-bm25.
  - queryEmbedding + queryText:              run Step 2 with the supplied
                                              embedding (provider not
                                              consulted); Step 3 attaches
                                              BM25 to vector candidates.
```

The text-only fallback branches are decided at Step 0 before any provider call:
if no provider is bound, fallback reason is `'NO_PROVIDER'`; if a provider is
bound but vector backend/configuration is unavailable, fallback reason is
`'NO_SQLITE_VEC'` or `'NAMESPACE_VECTORLESS'`. This avoids loading a model or
making a network call when the vector backend cannot be used. Once Step 0
derives a query embedding from a provider, provider failures propagate as
`EmbeddingProviderError`; the pipeline does not hide provider outages behind
BM25 fallback.

### Step 1: Temporal Filter

Select assertion IDs valid at `temporalAnchor`, filtered by namespace,
temporal window, entity type, assertion type, confidence, and supersession
policy. Same SQL pattern as today; never touches vec0; never requires
`sqlite-vec`.

### Step 2 (vector | hybrid-with-vector-available): Semantic Candidate Selection

Use `sqlite-vec` cosine distance over the namespace's vec0 table. Calls
`ensureVectorReady(namespace)` first; throws `MissingPeerDependencyError`
(no `sqlite-vec`) or `RetrievalInputError(RETRIEVAL_NAMESPACE_VECTORLESS)`
(vectorless namespace) when capabilities are missing. Validates query vector
dimension before passing the vector to SQLite.

For `'hybrid'`, Step 2 runs only when Step 0 routed here (i.e., a query
embedding was either supplied directly or successfully derived via the
configured provider). Step 0 is responsible for graceful text-only fallback
when vector backend/configuration is unavailable before provider embedding.
Step 2 may still lazily create a missing vec0 table via `ensureVectorReady()`;
if a readiness error is raised because state changed between Step 0 and Step 2,
the same fallback policy applies only when the caller supplied no
`queryEmbedding`:

- `MissingPeerDependencyError` (`sqlite-vec` not loaded) — caught; emit
  `TRGT_RETRIEVE_VECTOR_SKIPPED` at info with `reason: 'NO_SQLITE_VEC'`;
  route to Step 2-bm25.
- `RetrievalInputError(RETRIEVAL_NAMESPACE_VECTORLESS)` (vectorless
  namespace) — caught; emit `TRGT_RETRIEVE_VECTOR_SKIPPED` with
  `reason: 'NAMESPACE_VECTORLESS'`; route to Step 2-bm25.

The third documented `reason` value, `'NO_PROVIDER'`, is emitted by Step 0
(not Step 2) per the routing table above — Step 2 never runs in that case.

Named-input rule: if `queryEmbedding` was supplied directly by the caller,
errors from Step 2 propagate (the call throws `MissingPeerDependencyError`
or the relevant `RetrievalInputError`). Hybrid never silently downgrades a
caller-supplied vector input.

### Step 2-bm25 (bm25 | hybrid fallback): FTS Candidate Selection

Runs in two cases:

- `retrievalStrategy === 'bm25'` (explicit BM25-only).
- `retrievalStrategy === 'hybrid'` AND Step 2 was skipped via text-only
  fallback (per the rule above).

SQL pattern (must preserve the BM25 rowid-join invariant for FTS5
external-content tables):

```sql
SELECT a.id AS assertion_id, bm25(trl_fts) AS bm25_score
FROM trl_fts
JOIN trl_assertions a ON a.rowid = trl_fts.rowid
WHERE trl_fts MATCH ?
  AND a.id IN (SELECT value FROM json_each(?))   -- temporal-filter IDs
ORDER BY bm25(trl_fts) ASC
LIMIT ?
```

FTS5 external-content tables cannot read UNINDEXED columns directly; all
`assertion_id` reads must come from `trl_assertions` via the `rowid` join.
The v0.3 BM25-only branch must obey this stable SQL invariant. Step 2-bm25
never loads
`sqlite-vec` and never touches vec0 — it is the path that supports the
"BM25-only retrieval works without sqlite-vec" claim in Peer Dependencies.

### Step 3 (hybrid only): Keyword Re-ranking

When `queryText` is supplied AND Step 2 ran (i.e., not the BM25 fallback),
attach BM25 scores to vector-selected candidates that match `queryText`.
Uses the same FTS5 rowid-join pattern as Step 2-bm25. Reads
`queryTextMode` to decide between safe phrase mode (default in v0.3) and raw
FTS5 expression mode (`queryTextMode: 'fts5'`).

### Step 4: Hydrate

Load assertions + citations for the selected IDs. `semanticDistance` is
`null` for candidates produced by Step 2-bm25; `bm25Score` is `null` for
hybrid candidates that did not match `queryText`.

### Step 5: Score

Call `scoreBatch()` when the configured scorer implements it; otherwise call
per-candidate `score()`. `DefaultScorer` handles all four `(semanticDistance,
bm25Score)` nullity cases per Extension Interfaces → RetrievalScorer.

### Step 6: Rank, Truncate, Envelope

Sort by score descending, apply `limit`, produce `RetrievalResult`. The
`meta` envelope carries `retrievalStrategy`, `vectorApplied`, `bm25Applied`,
plus `tookMs` and any `warnings` accumulated during the run.

**Determinism contract.** For a given `(database state, query)` pair,
retrieval MUST return the same results in the same order across invocations.
Tie-breaking is deterministic and lexicographic across `(score DESC,
validFrom DESC, createdAt ASC, id ASC)`. This holds independent of scorer
choice provided the scorer itself is deterministic per the `RetrievalScorer`
contract. The contract is part of the public API: regulated-domain consumers
may rely on it for audit reproducibility. The single-BM25 / equal-BM25 case
(`scoreBatch` `range === 0`) is well-defined per the `DefaultScorer` contract.
`createdAt` values used in ordering MUST be canonical ISO 8601 strings with
consistent precision, so lexicographic order matches temporal order. The final
`id ASC` tie-break assumes SQLite's default BINARY text collation; trageti
managed IDs and ordering columns must not be declared with `COLLATE NOCASE`.

### Step 7: Graph Expansion

When `expandLinks: true`, attach linked assertions with citations. Respect
`maxDepth` and temporal validity. Never touches vec0.

### Step 8: Trajectory Expansion

When `mode: 'trajectory'`, attach prior versions from the supersession chain,
oldest first, with citations. Never touches vec0.

---

## Logging and Observability

All warnings and operational events pass through `Logger`.

Required log codes:

| Code | Severity | Emitted by |
|---|---|---|
| `TRGT_NON_WAL_MODE` | warn | `DefaultConnectionVerifier` |
| `TRGT_FOREIGN_KEYS_ENABLED` | debug | `DefaultConnectionVerifier` — emitted once on successful enablement. The failure path is a thrown `ConnectionVerificationError`, NOT a log. |
| `TRGT_CITATION_EXCERPT_MISSING` | warn | `writeAssertion`/`writeCitation` (only when `validation.requireCitationExcerpt` is false) |
| `TRGT_EPISODE_CONTENT_LARGE` | warn | `writeEpisode` |
| `TRGT_INDEX_BATCH_SKIPPED` | warn | `indexBatch` (one record per call, with skipped count) |
| `TRGT_REINDEX_STAGING_LEFTOVER` | warn | `reindexNamespace` recovery |
| `TRGT_CROSS_NAMESPACE_LINK` | warn | `writeLink` |
| `TRGT_MIGRATION_TOKENIZER_INCOMPATIBLE` | error | migration runner (paired with `MigrationCompatibilityError`) |
| `TRGT_RETRIEVE_VECTOR_SKIPPED` | info | `retrieve` (hybrid graceful degradation; `reason: 'NO_PROVIDER' \| 'NO_SQLITE_VEC' \| 'NAMESPACE_VECTORLESS'`) |
| `TRGT_STATS_VEC_NOT_INTROSPECTED` | debug | `getStats` (sqlite-vec not loaded but vec0 exists; once per call) |
| `TRGT_PENDING_INDEXING_VECTORLESS` | debug | `getPendingIndexing` (vectorless namespace; once per call) |
| `TRGT_NAMESPACE_VECTOR_UPGRADED` | info | `upgradeNamespaceToVector` successful metadata transition |
| `TRGT_MOCK_PROVIDER_NON_PRODUCTION` | warn | `MockEmbeddingProvider` used outside `NODE_ENV === 'test'`; once per process |
| `TRGT_RETRIEVAL_DEBUG_HOOK_ERROR` | warn | `retrieve` (and `assembleContext` indirectly) when a `RetrievalDebug.onStep()` handler throws. The library wraps and swallows the throw so retrieval still completes; the log carries the step name and the thrown error's stable `code` (or `'UNKNOWN'`) but never the raw `Error` instance or stack trace per the field-sensitivity rules. |
| `TRGT_DEPRECATED_USAGE` | warn | any deprecated symbol; once per process per symbol (suppressible via `Logger`) |

`store.explain(query)` returns a structured description of SQL plans, candidate
counts, active filters, and whether semantic and keyword scoring are used.

### RetrievalDebug

Per-retrieval introspection is exposed via an optional debug hook on the query
itself, separate from `Logger` (which is store-scoped):

```typescript
interface RetrievalDebug {
  onStep?(step: RetrievalStep, info: RetrievalStepInfo): void
}

type RetrievalStep =
  | 'validate' | 'temporal-filter' | 'semantic' | 'keyword'
  | 'score' | 'rank' | 'graph-expand' | 'trajectory-expand'

interface RetrievalStepInfo {
  step: RetrievalStep
  candidateCount: number
  tookMs: number
  notes?: Record<string, unknown>
}
```

Pass via `RetrievalQuery.debug?: RetrievalDebug`. Hook invocations are
synchronous and must not throw; throwing handlers are wrapped and logged at
`warn`. Hook is intended for development and ad-hoc profiling, not for
production telemetry — production observability flows through `Metrics`.

---

## Error Model

Existing error classes remain. v0.3 adds:

```typescript
class NamespaceDimensionMismatchError extends TragetiError {}
class EmbeddingProviderError extends TragetiError {}
class IndexingError extends TragetiError {}
class RetrievalInputError extends TragetiError {}
class ReindexError extends TragetiError {}
class StoreClosedError extends TragetiError {}
class ReferencedExtensionTableError extends TragetiError {}
class MissingPeerDependencyError extends TragetiError {}
class MigrationCompatibilityError extends TragetiError {}
```

`MissingPeerDependencyError` carries
`{ packageName: string; installCommand: string; alternative?: string }` so
adopters can act on the message without parsing prose. It is the **single**
error type for "sqlite-vec not loaded" — there is no
`RETRIEVAL_REQUIRES_VECTOR_BACKEND` code.

`RetrievalInputError` codes:

| Code | Raised by |
|---|---|
| `RETRIEVAL_INPUT_EMPTY` | retrieve() when no `queryEmbedding` and no non-empty `queryText` is supplied (any strategy) |
| `RETRIEVAL_REQUIRES_QUERY_TEXT` | `retrievalStrategy: 'bm25'` with no `queryText` |
| `RETRIEVAL_REQUIRES_VECTOR_INPUT` | `retrievalStrategy: 'vector'` with no `queryEmbedding` and no `(queryText + EmbeddingProvider)` |
| `RETRIEVAL_DIMENSION_MISMATCH` | supplied `queryEmbedding.length !== namespace.embeddingDimension` |
| `RETRIEVAL_INVALID_LIMIT` | `limit < 1` or non-integer |
| `RETRIEVAL_INVALID_MAX_DEPTH` | `maxDepth < 0` or non-integer |
| `RETRIEVAL_NAMESPACE_VECTORLESS` | `retrievalStrategy: 'vector'` against a vectorless namespace, OR `ensureVectorReady()` invoked on a vectorless namespace from a vector-required path |

`IndexingError` codes:

| Code | Raised by |
|---|---|
| `INDEXING_NAMESPACE_VECTORLESS` | `indexAssertion`/`indexBatch` against a vectorless namespace |
| `ASSERTION_NOT_FOUND` | `indexAssertion` (single-target) against an unknown `assertionId`. `indexBatch` records the same condition in `skipped[]` with `reason: 'ASSERTION_NOT_FOUND'` instead of throwing. |
| `EMBEDDING_DIMENSION_MISMATCH` | `indexAssertion` (single-target) when the supplied `embedding.length` does not match the namespace's stored dimension. `indexBatch` records the same condition in `skipped[]` with `reason: 'EMBEDDING_DIMENSION_MISMATCH'`. |
| `NO_EMBEDDING_AND_NO_PROVIDER` | `indexAssertion` (single-target) when no `embedding` is supplied and no `EmbeddingProvider` is bound to the namespace. `indexBatch` records the same condition in `skipped[]` with `reason: 'NO_EMBEDDING_AND_NO_PROVIDER'`. |

All errors include stable `.code` values and structured fields where useful.
Error messages must be actionable without exposing source content, query
text, embedding data, or secrets.

**Internal-invariant violations** that indicate a programming bug rather
than a caller error are surfaced as plain `TragetiError` with a stable
`.code` drawn from the following table. These are part of the public
contract (they may appear in caller stack traces and SHOULD be filtered
on `.code` rather than instance-of), even though they should be
unreachable in correctly-used library code:

| Code | Raised by |
|---|---|
| `SCORER_NO_USABLE_SIGNAL` | `DefaultScorer` (and any custom scorer following the same contract) when a candidate reaches scoring with both `semanticDistance` and `bm25Score` null — indicates the pipeline failed to filter unscorable candidates before Step 5. |
| `NAMESPACE_VECTOR_METADATA_INCONSISTENT` | `ensureVectorReady` when `trl_namespaces.embedding_dimension` is set but `embedding_table` is NULL (or vice versa) — the v003 schema CHECK should prevent this; if encountered, the row is corrupt. |

---

## Security Considerations

**User query text is untrusted.** Default keyword retrieval must escape or quote
text so ordinary user input cannot crash the query parser or unexpectedly invoke
FTS5 operators.

**Schema extension SQL is trusted code.** Applications must not expose raw
extension SQL to users or tenants. Use a constrained builder for configuration
surfaces.

**Tokenizer configuration is operator-controlled.** Custom tokenizers and args
are powerful and must be validated or explicitly marked trusted.

**Logs are low-sensitivity by default.** Library logs must avoid assertion
content, episode content, excerpts, embeddings, query text, secrets, and file
paths unless the caller explicitly opts in.

**At-rest protection is caller-managed.** SQLite encryption, SQLCipher,
filesystem ACLs, backups, retention, and secure deletion are outside the core
library but must be documented for regulated domains.

---

## Testing Strategy

v0.3 requires integration and E2E coverage using real `better-sqlite3`,
`sqlite-vec`, FTS5, migrations, and file-backed databases. No mocks for the
storage layer.

Required test classes:

- **File-backed lifecycle.** Create, write assertions, close, reopen,
  retrieve.
- **Multi-instance namespace lifecycle.** Deleting a namespace created by
  another store instance — verifies the v0.3 DB-authoritative
  `deleteNamespace` lookup.
- **Namespace dimension mismatch on reopen.** Verifies
  `NamespaceDimensionMismatchError`.
- **Vectorless namespace + BM25-only retrieval.** End-to-end with no
  `sqlite-vec` loaded; covers the `prepare: { loadSqliteVec: false }` path,
  vectorless namespace creation, BM25 retrieve, and the `vectorReady = false`
  assertion on `getStats()`.
- **`getStats` / `getPendingIndexing` matrix.** All four observable
  `(sqlite-vec loaded × vec0 exists)` states for a vector-configured
  namespace, plus the vectorless case. Specifically: open file-backed DB
  with `sqlite-vec`, write and index, close, reopen WITHOUT `sqlite-vec`,
  verify `getStats()` succeeds with `vectorReady = false` and
  `getPendingIndexing()` throws `MissingPeerDependencyError`.
- **Lazy vec0 creation.** Vector-configured namespace, no vec0 yet, then
  first `indexAssertion()` call creates the table. Verify
  `trl_namespaces.embedding_table` was already populated at registration
  time (planned-name invariant).
- **Hybrid retrieval graceful degradation.** `queryText` only with no
  provider → BM25 fallback emits `TRGT_RETRIEVE_VECTOR_SKIPPED` with
  `reason: 'NO_PROVIDER'`. `queryText` only with no `sqlite-vec` →
  fallback emits with `reason: 'NO_SQLITE_VEC'`. `queryEmbedding` supplied
  with no `sqlite-vec` → throws `MissingPeerDependencyError`.
- **FK-toggle migration runner failure paths.** Migration body throws,
  `foreign_key_check` returns rows, COMMIT fails — in each case,
  `foreign_keys` is restored to its captured value and the schema row is not
  inserted.
- **Complete multi-hop `findPath()`.** Property test on randomly generated
  small DAGs: `path[0].fromId === fromAssertionId`, every adjacent pair of
  links connects, `path[path.length - 1].toId === toAssertionId`. Plus
  `fromAssertionId === toAssertionId` (`[]`), cycle protection, no repeated
  assertion IDs in returned paths, deterministic shortest-path selection, and
  `maxDepth` boundary tests.
- **FTS adversarial inputs.** Quotes, parens, FTS5 operators (`AND`, `OR`,
  `NOT`, `NEAR`), asterisks, unicode combining marks, empty and
  whitespace-only strings — all in BOTH `queryTextMode: 'phrase'` (default)
  AND `queryTextMode: 'fts5'` modes.
- **`rebuildFts()` rowid preservation.** Rebuild with and without a new
  tokenizer, then verify BM25 rowid joins still return assertion IDs via
  `trl_assertions.rowid = trl_fts.rowid` and `newTokenizer` is the resolved
  active config.
- **Reindex provider failure preserves old embeddings** (staging-swap
  invariant).
- **`indexBatch()`** returns skipped IDs (with `onProviderError: 'skip'`)
  or throws (`'fail-fast'`); verifies input-order `skipped[]`, non-empty
  `errorCode` when present, and `indexed + skipped.length === items.length`
  for non-throwing calls.
- **`deleteNamespace()` with extension tables** marked
  `referencesNamespace: true`. Tables are NOT dropped; only per-namespace
  rows are removed via the generated DELETE. Without `cascade: true`,
  throws `ReferencedExtensionTableError`.
- **`namespaceColumn` validation at init() time.** Typos detected via
  `PRAGMA table_info` after `createSQL` runs.
- **Invalid public options fail before SQLite execution.** Negative
  `limit`, bad `maxDepth`, dimension-mismatched `queryEmbedding`, etc.
- **`writeAssertion()` normalization order.** Custom validator receives
  `NormalizedNewAssertion`; omitted nullable fields arrive as `null`, not
  `undefined`.
- **`DefaultScorer` four cases.** Hybrid (A), vector-only (B), BM25-only
  (C), both-null (D, must throw). Plus `scoreBatch()` `range === 0` case
  (single BM25, all-equal BM25).
- **`MockEmbeddingProvider` non-production warning.** Emits
  `TRGT_MOCK_PROVIDER_NON_PRODUCTION` once per process outside
  `NODE_ENV === 'test'`; does not emit in tests.
- **Determinism contract.** Same query against same DB state returns same
  results in same order across invocations; tie-breaking by
  `(score DESC, validFrom DESC, createdAt ASC, id ASC)`, including canonical
  `createdAt` string ordering and BINARY `id` collation assumptions.
  Custom-scorer determinism is covered with a deterministic stub scorer.
- **E2E scenarios with realistic temporal drift.** Replacement,
  accumulation, contradiction, resolution, citation-rich context assembly;
  domain-flavored fixtures for at least one of medical / legal / mental
  health to exercise the full provenance + supersession + retrieval path.
- **Public type compile coverage.** Every type the spec exports as part of
  the v0.3 contract (per Contract Scope) can be imported and used in a
  consumer-side `.ts` file without compile errors. Catches missing exports,
  broken cross-references between types, and stale alias targets. Runs in
  CI as `tsc --noEmit` against a test fixture that imports each public type.
- **`RetrievedAssertion` envelope shape.** Vector-only result populates
  `scoreComponents.semanticDistance: number` and `bm25Score: null`;
  BM25-only result populates `bm25Score: number` and `semanticDistance: null`;
  hybrid populates both; trajectory-mode results carry `supersessionChain`;
  `expandLinks: true` results carry `linkedAssertions`.
- **`AssembledContext` envelope shape.** Returned `text`, `assertions: RetrievedAssertion[]`,
  `tokenEstimate`, `truncated`, `metadata`, and `coverage` are all populated
  correctly. `coverage.includedAssertions === assertions.length`.
- **`store.explain()` result shape.** Returns `RetrievalExplainResult`
  without executing the query. `wouldApplyVector` / `wouldApplyBm25` match
  the routing rules; `steps[].vectorReady` is correctly reported for the
  current `(sqlite-vec, vec0)` state; `notes[]` documents any fallback
  reasons.
- **`getStats` unknown namespace.** `await store.getStats('nonexistent')`
  throws `NamespaceNotInitializedError`. Same for `getPendingIndexing`.
  Distinguishes from vectorless-but-registered (which returns
  `{ ..., vectorReady: false, embeddingDimension: null, ... }`).
- **FTS tokenizer metadata round-trip.** `prepareDatabase` → `initNamespace` →
  write assertions → `rebuildFts({ tokenizer })` → close → reopen → confirm
  the tokenizer config readable from the library-managed `trl_fts_config`
  row matches the post-rebuild config (NOT parsed from `sqlite_master`).
- **FK verifier fail-closed.** A `ConnectionVerifier` against a DB where
  `PRAGMA foreign_keys = ON` cannot be enabled throws
  `ConnectionVerificationError`; no `TRGT_FOREIGN_KEYS_UNAVAILABLE` log is
  ever emitted; on success, exactly one `TRGT_FOREIGN_KEYS_ENABLED` debug
  log is emitted.

Coverage thresholds (raised from v0.2):

```typescript
lines: 95
functions: 95
statements: 95
branches: 85
```

---

## Package Structure

Proposed additions:

```text
src/
  providers/
    embedding/
      index.ts
      RawVectorProvider.ts              # in core, no extra deps
      MockEmbeddingProvider.ts          # in core, tests/quickstart only
      OllamaEmbeddingProvider.ts        # optional adapter (subpath or companion)
      TransformersJsEmbeddingProvider.ts # optional adapter (subpath or companion)
      OpenAIEmbeddingProvider.ts        # optional adapter (subpath or companion)
  defaults/
    logging/
      ConsoleLogger.ts
      NoopLogger.ts
  db/
    prepareDatabase.ts
  observability/
    explain.ts
```

Optional adapters with extra runtime dependencies are exposed as subpath
exports or separate packages — see Extension Interfaces → Provider Adapters
and Open Questions for the out-of-contract packaging carve-out. Adapters
never become hard runtime dependencies of the core `trageti` import.

---

## Peer Dependencies

Core runtime dependency posture:

- `better-sqlite3` is a **required peer** for the default database path. The
  library does not bundle a SQLite binding.
- `sqlite-vec` is an **optional peer** declared with
  `peerDependenciesMeta.sqlite-vec.optional = true`. Vector retrieval (and
  any context assembly built on top of vector retrieval) requires it.
  Non-vector use cases that work without `sqlite-vec` installed: writes
  (`writeEpisode`/`writeAssertion`/`writeCitation`/`writeLink`); BM25-only
  retrieval (`retrievalStrategy: 'bm25'`); BM25-only context assembly
  (`assembleContext` with a query that resolves to BM25-only via the Step 0
  routing rules); graph traversal (`getConnected`/`findPath`); snapshot and
  history utilities; schema introspection; and `getStats()`. Anything that
  reaches Step 2 (vector candidate selection) — including a hybrid query
  that derives an embedding via a configured provider — requires
  `sqlite-vec`. `prepareDatabase()` attempts a dynamic require and throws
  `MissingPeerDependencyError` with an install message if `loadSqliteVec`
  is true and the package is not present.

Provider adapters declare their own optional peer dependencies (e.g.
`@xenova/transformers` for `TransformersJsEmbeddingProvider`, `openai` for
`OpenAIEmbeddingProvider`, none for `OllamaEmbeddingProvider` since it talks
to Ollama over HTTP; callers are responsible for running an Ollama instance).
The core `trageti` import never carries these.

`MockEmbeddingProvider` and `RawVectorProvider` ship in core with zero extra
dependencies. `MockEmbeddingProvider` is test/quickstart-only and emits the
non-production warning described under Provider Adapters.

---

## What This Library Does Not Do

- It does not decide whether an assertion is true.
- It does not provide medical, legal, safety, or investigative judgment.
- It does not encrypt the database or manage backup retention.
- It does not coordinate multi-process writes without caller-provided locking.
- It does not make raw schema-extension SQL safe for untrusted users.
- It does not require a specific embedding vendor or model.
- It does not provide its own embeddings unless an `EmbeddingProvider` adapter
  is configured. The in-core `MockEmbeddingProvider` is for tests and
  quickstarts only and produces semantically meaningless vectors.

---

## Versioning Policy

The 0.x series is pre-stable. The library may introduce breaking changes in any
0.y release, accompanied by a migration guide.

From 1.0 onward:

- Breaking API changes require a major version bump. A breaking change is any
  modification that requires consumer code edits to keep working: removed
  exports, narrowed types, renamed methods, signature changes, or behavioral
  changes that violate documented invariants (including the determinism
  contract).
- Deprecations live for at least one minor version before removal in the next
  major version. Deprecated symbols emit a single `TRGT_DEPRECATED_USAGE`
  warning per process per symbol, suppressible via the `Logger`.
- Schema migrations are forward-only. A v0.x → v1.0 migration path is
  guaranteed; pre-1.0 schemas without a 1.0-compatible migration will be
  documented and the affected releases marked.
- Log codes (`TRGT_*`) are part of the public surface; renaming or removing a
  code is a breaking change.
- Metric names (`trageti.*`) are part of the public surface under the same
  policy as log codes.
- The determinism contract for retrieval is a public invariant; changing
  tie-breaking order is a breaking change.

### 1.0 Stabilization Criteria

The library will tag 1.0 when all of the following hold:

- All Phase 3 surfaces have shipped and have integration coverage.
- No known correctness P1 issues remain open.
- Three independent consumers have reported production use of v0.3.x without
  filing P1 regressions for two consecutive minor versions.
- Documentation includes at least one fully worked example per regulated
  domain claim (medical, legal, mental health) showing trust-boundary
  configuration.

---

## Migration Guide v0.2 to v0.3

### All public store methods are async

v0.3 adopts a uniform `await store.method(...)` contract across writes,
retrieval, indexing, introspection, and lifecycle. Update call sites by
adding `await` (or `.then(...)`) to every `store.*` invocation. The methods
do no async work beyond what they did in v0.2 for writes and introspection —
the change is contract-level, intended to make the API uniform and
future-proof for async middleware, remote vector backends, and any other
extension that becomes async later. The migration intentionally avoids a
permanent sync/async split where method behavior depends on whether providers
or async hooks are configured. Internal storage and scoring remain synchronous;
nothing about hot-path performance changes.

```typescript
// v0.2
const ep  = store.writeEpisode({ /* ... */ })
const a   = store.writeAssertion({ /* ... */ })
const hx  = store.getEntityHistory(ns, id)
const stt = store.getStats(ns)
const path = store.findPath({ /* ... */ })
const r   = store.retrieve(q)

// v0.3
const ep  = await store.writeEpisode({ /* ... */ })
const a   = await store.writeAssertion({ /* ... */ })
const hx  = await store.getEntityHistory(ns, id)
const stt = await store.getStats(ns)
const path = await store.findPath({ /* ... */ })
const { results, meta } = await store.retrieve(q)
```

### Supersession

```typescript
// Before (broken in v0.2 README — second call throws)
store.writeAssertion({ id: 'new', supersedesId: 'old', /* ... */ })
store.supersedeAssertion('old', { validUntil: 5, replacedById: 'new' })

// After (single canonical call)
await store.writeAssertion({ id: 'new', validFrom: 5, supersedesId: 'old', /* ... */ })
```

### Optional nullable assertion fields

`NewAssertionInput` makes `validUntil`, `supersedesId`, `entityId`, and
`entityType` optional. Omitted = `null` at the boundary. Callers that
previously passed explicit `null`s still compile.

```typescript
// Before (v0.2 — six required-null fields per assertion)
store.writeAssertion({
  id: 'a-1', namespace: 'demo', type: 'observation', content: '...',
  validFrom: 1, validUntil: null, confidence: 1.0,
  sourceEpisodeId: 'ep-1',
  supersedesId: null, entityId: null, entityType: null,
  citations: [...],
})

// After (v0.3 — nullables omitted; default to null via writeAssertion's normalization)
await store.writeAssertion({
  id: 'a-1', namespace: 'demo', type: 'observation', content: '...',
  validFrom: 1, confidence: 1.0,
  sourceEpisodeId: 'ep-1',
  citations: [...],
})
```

### Custom loggers

v0.2 emitted structured warnings through a single `structuredWarn(code, fields)`
function. v0.3 replaces this with the `Logger` interface, which requires
four methods (`debug`, `info`, `warn`, `error`). Adopters who wrote custom
v0.2 wrappers around `structuredWarn` must implement all four methods on
their custom `Logger`. The four-method shape is required so the library can
emit at the appropriate severity for each event class (debug for
introspection, info for normal lifecycle, warn for recoverable
inconsistencies, error for unhandlable state) and so severity-aware log
shipping (Datadog, Sumo, Cloud Logging) routes records correctly without
prefix parsing.

The defaults shipped in core:

- `ConsoleLogger` — writes structured records to stderr at `warn` and
  `error`; silent at `debug` and `info`. Matches the v0.2 stderr behavior
  for the warn-level events that v0.2 already emitted.
- `NoopLogger` — drops everything; useful in tests.

Migrate by either using `ConsoleLogger` (default, no code changes needed
on the warn path) or supplying a custom implementation that satisfies the
four-method `Logger` shape.

### Custom validators

If you typed your `AssertionValidator.validate()` parameter as `NewAssertion`,
change it to `NormalizedNewAssertion`. The two types are structurally
identical to the v0.2 `NewAssertion` (every nullable field is required and
non-undefined), so the validator body needs no changes — only the parameter
type annotation.

```typescript
// Before (v0.2)
class MyValidator implements AssertionValidator {
  validate(a: NewAssertion): ValidationResult { /* ... */ }
}

// After (v0.3)
class MyValidator implements AssertionValidator {
  validate(a: NormalizedNewAssertion): ValidationResult { /* ... */ }
}
```

If you kept the parameter inferred (`validate: AssertionValidator['validate'] = (a) => ...`),
no change needed.

### Retrieval result envelope

```typescript
// Before
const results = store.retrieve(query)

// After
const { results, meta } = await store.retrieve(query)
```

### Retrieval strategy (BM25-only / vectorless deployments)

v0.3 introduces `retrievalStrategy: 'hybrid' | 'vector' | 'bm25'`. Default
is `'hybrid'`, which preserves v0.2 behavior on the hot path. If you want
trageti without `sqlite-vec` (compliance review, structured-document
indexing), declare the namespace vectorless and use `'bm25'`:

```typescript
const store = await TemporalStore.create({
  database: 'rag.db',
  namespace: 'compliance',
  prepare: { loadSqliteVec: false },
  // No embeddingDimension, no embeddingProvider — namespace is vectorless.
})
const { results, meta } = await store.retrieve({
  namespace: 'compliance',
  queryText: 'liability waiver',
  retrievalStrategy: 'bm25',
  temporalAnchor: 100,
})
```

### Keyword querying — default mode flip

`queryTextMode` default flips to `'phrase'` in 0.3.0. Callers jumping
0.1.x → 0.3.0 directly experience a silent default flip; pass
`queryTextMode: 'fts5'` explicitly to preserve the v0.1.x raw FTS5 behavior.

```typescript
// 0.1.x / 0.2.x default (raw FTS5 syntax interpreted)
await store.retrieve({ queryText: 'alpha AND beta', /* ... */ })

// v0.3 equivalent — preserve raw FTS5 semantics explicitly
await store.retrieve({ queryText: 'alpha AND beta', queryTextMode: 'fts5', /* ... */ })

// v0.3 default — safe phrase mode (alpha AND beta is a literal three-word phrase)
await store.retrieve({ queryText: 'alpha AND beta', /* queryTextMode: 'phrase' */ })
```

### Batch indexing — result envelope

```typescript
// Before
store.indexBatch(items)

// After
const result = await store.indexBatch(items)
if (result.skipped.length > 0) {
  logger.warn('INDEX_BATCH_SKIPPED', { count: result.skipped.length })
}
```

### Reindexing — staging-swap default

```typescript
// Before
await store.reindexNamespace(ns, { newDimension, embeddingProvider })

// After (staging-swap is now the default; explicit form shown for clarity)
const result = await store.reindexNamespace(ns, {
  newDimension,
  embeddingProvider,
  strategy: 'staging-swap',
})
```

### Store lifecycle

```typescript
// Before
const store = new TemporalStore(db, options)
store.init()
// ... use ...
db.close()

// After
const store = await TemporalStore.create({ database: 'rag.db', ...options })
// ... use ...
await store.close()
```

The common filename path — `TemporalStore.create({ database: 'rag.db' })`
+ `await store.close()` — now closes the underlying `better-sqlite3`
handle automatically; the v0.3 ownership-driven default (see
`CreateOptions.closeDatabaseOnStoreClose`) is "trageti closes what it
opened." Override only when needed:

- Pass `closeDatabaseOnStoreClose: false` with a filename input when the
  handle should outlive the store (rare).
- Pass `closeDatabaseOnStoreClose: true` with a caller-supplied
  `Database` when you intentionally want to transfer ownership of the
  handle to trageti.

### Additive APIs

v0.3 adds `initNamespace()` and `upgradeNamespaceToVector()` as additive
multi-namespace and vectorless-upgrade APIs. Existing single-namespace
v0.2 code requires no migration to either; reach for them only when the
new capability is needed:

- **`initNamespace(name, options?)`** when a single store registers more
  than one namespace beyond the constructor's default.
- **`upgradeNamespaceToVector(name, options)`** when a vectorless
  namespace needs to gain a vector configuration after the fact
  (vectorless → vector-configured is the only state transition the
  library supports for an existing namespace; the reverse is not).

---

## Open Questions

Items intentionally left to later versions or to implementation discretion,
with working assumptions noted where the spec already takes a position.
None block v0.3; each is tractable for a future release without re-opening
the v0.3 contract.

- **Embedding-adapter packaging — out of v0.3 contract.** Whether the
  reference adapters (Ollama, Transformers.js, OpenAI) ship as subpath
  exports of core (`trageti/providers/ollama`) or as companion packages
  (`@trageti/provider-ollama`) is an implementation decision, not a v0.3
  contract decision (see Extension Interfaces → Provider Adapters). The
  initial 0.3.0 implementation will pick one; the choice may evolve
  without breaking the v0.3 contract because the adapter import paths
  are explicitly carved out.
- **`supersedeAssertion()` retention — RESOLVED.** Removed from the primary
  API. v0.3 retains the narrow escape hatch as `store.advanced.closeAssertion()`
  for closing assertions with no replacement (for example, data correction
  where the predecessor is invalid and no replacement exists).
- **Constrained schema-extension builder.** A typed builder API that gates
  raw SQL for configuration-driven products. v0.3 ships only the
  trust-boundary documentation and the declarative `namespaceColumn`
  helper; a full builder is a future addition.
- **Raw `cleanupSQL` extension hook.** Considered for v0.3 and deferred
  pending demand and a safer parameter-count validator: `better-sqlite3`'s
  `Statement` type exposes no `parameterCount` API, so a code-level guard
  for "exactly one positional parameter" requires either a SQL tokenizer
  written by trageti or a `db.prepare()`+savepoint dance. v0.3 ships only
  the declarative `namespaceColumn` path; raw `cleanupSQL` is a v0.4
  candidate.
- **Vectorless → vector upgrade — RESOLVED.** v0.3 ships
  `store.upgradeNamespaceToVector(namespace, options)` as the only path. Reopening
  a vectorless namespace with `embeddingProvider`/`embeddingDimension` set in
  `TemporalStoreOptions` does NOT auto-upgrade; `init()` throws
  `NamespaceDimensionMismatchError` with an actionable message pointing at
  the upgrade API. This makes upgrade an explicit, auditable operation
  rather than a side effect of changing call-site options. Vec0 virtual
  table creation remains lazy via `ensureVectorReady()`.
- **Async validators.** `AssertionValidator.validate()` stays synchronous in
  v0.3 because async validators would create a sync/async split inside the
  validator chain that defeats the consistency the all-async public API
  buys. A future version may introduce a separate
  `AsyncAssertionValidator` interface or extend `validate()` to allow
  `Promise<ValidationResult>`. Cost/benefit is open.
- **Multi-process write coordination.** Caller-managed today (the library
  documents that single-process writes are the supported pattern). A
  first-party file-lock or advisory-lock helper is a candidate; not
  designed yet.
- **Quantized vectors.** sqlite-vec supports `int8` and `bit` vector
  storage. v0.3 stays at `FLOAT[N]`. Quantization halves (or 32x for bit)
  memory at modest accuracy cost — meaningful for on-device deployments.
- **`EmbedOptions.purpose` openness.** Closed enum (`'assertion' | 'query'
  | 'reindex'`) vs open string for adapter-defined values (e.g.
  `'similarity'`, `'classification'`). *Working assumption: closed; open is
  more honest about model heterogeneity but harder to validate.*
- **`TRGT_RETRIEVE_PARTIAL` warning.** Whether retrieval should emit this
  when graph expansion is truncated by `maxDepth`, so consumers can detect
  "I would have returned more if you'd asked." Cheap to add; defer until a
  consumer asks.
- **Encryption / SQLCipher integration.** v0.3 documents at-rest protection
  as caller-managed. A future version may ship a `prepareDatabase` flag
  for SQLCipher key configuration, but the storage contract is unchanged
  either way.
