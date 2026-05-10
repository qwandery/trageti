# trageti
## Package Specification v0.3 (DRAFT rev 2)

**Status:** DRAFT design specification - not yet implemented
**Date:** May 2026
**License intent:** MIT
**Target runtime:** Node.js 18+ / TypeScript 5+

---

## Specification Changelog

This changelog tracks changes to the specification, not to the implementation.
v0.3 is a clean-break specification for a broader-adoption package: safer
defaults, stronger integrity guarantees, clearer developer experience, and
better operational visibility.

---

### v0.3 - Draft, May 2026

**Breaking changes are intentional.** The design goal is a professional-use
library that can be adopted safely by teams who will not read the source.

#### Correctness and Integrity - BREAKING

- **Foreign keys are enforced by default.** The default connection verifier must
  enable `PRAGMA foreign_keys = ON`, re-check it, and fail closed if enforcement
  is unavailable. Warning-only FK behavior is removed.
  Migration note: callers that intentionally disable FK checks must provide a
  custom `ConnectionVerifier` and accept full responsibility for integrity.
- **Namespace dimension mismatch is rejected.** Reopening an existing namespace
  with a different embedding dimension throws `NamespaceDimensionMismatchError`
  unless the caller runs `reindexNamespace()`.
  Migration note: callers must persist and reuse the namespace dimension, or
  explicitly reindex.
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
- **`findPath()` returns a complete path.** A successful path result must contain
  every link in order from source assertion to target assertion.
  Migration note: callers that only need existence can use `path.length > 0` or
  a future `pathExists()` convenience helper.
- **Public inputs are validated.** Invalid `limit`, `maxDepth`, temporal
  windows, token budgets, confidence bounds, and embedding dimensions throw
  `RetrievalInputError` or `ValidationError` before SQLite execution.
  Migration note: callers relying on SQLite errors will now receive typed
  library errors earlier.
- **Supersession has one canonical write path.** The canonical replacement path
  is `writeAssertion({ supersedesId })`, which atomically closes the predecessor.
  `supersedeAssertion()` is deprecated or removed from the primary API.
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
`getEntityTrajectory()`, and raw BM25 score delivery to scorers.

### v0.1 - April 2026

Initial specification for temporal assertions, namespace storage, SQLite schema,
semantic retrieval, graph traversal, and extension interfaces.

---

## Release Plan

v0.3 is a clean break, but the correctness fixes inside it do not have to wait
for the redesign to ship. The work is staged so consumers receive safety
improvements as soon as they are ready.

### Phase 1 — Correctness patches (target: 0.2.1, no API changes)

Ships as a patch release against the current public surface. No breaking
changes; no new abstractions.

- Fix the broken README supersession example: replace the two-call sequence
  with a single `writeAssertion({ supersedesId })` call.
- `findPath()` returns the complete ordered link path.
- Default `ConnectionVerifier` enables and verifies `PRAGMA foreign_keys = ON`,
  failing closed if enforcement is unavailable.
- `NamespaceRepository` rejects dimension changes on reopen by comparing the
  configured dimension against the stored dimension, throwing
  `NamespaceDimensionMismatchError`.
- `deleteNamespace()` looks up the embedding table from `trl_namespaces` rather
  than the in-memory cache.
- Public retrieval inputs are validated (negative `limit`, bad `maxDepth`,
  empty embedding, dimension mismatch) before SQLite execution.
- Regression tests for each: file-backed reopen, multi-instance namespace
  lifecycle, multi-hop `findPath()`, dimension mismatch on reopen,
  `indexBatch()` unknown-id surfacing.

### Phase 2 — Safety hardening (target: 0.2.2, additive)

Adds new optional behavior. Existing call sites continue to work.

- `queryText` defaults to safe phrase mode. Raw FTS5 expressions require
  `queryTextMode: 'fts5'`.
- FTS5 tokenizer configuration is validated against an allow-list at migration
  time; unknown tokenizers and unsafe argument characters fail closed.
- Identifier-quoting audit: every dynamic table or column name passes through
  the existing `sql-ident` helper, even when sourced from trusted hashes.
- `Logger` interface is added with a backward-compatible default that preserves
  the current stderr behavior.
- Schema-extension surfaces gain explicit "trusted code" docstrings and types.

### Phase 3 — DX redesign (target: 0.3.0, breaking)

The full v0.3 surface described in this spec.

- `TemporalStore.create()` factory; `prepareDatabase()` helper.
- `EmbeddingProvider` interface and `RawVectorProvider` default in core; named
  reference adapters as subpath exports or companion packages.
- `RetrievalResult` envelope with metadata.
- `RetrievalDebug` hook and `store.explain()`.
- Lifecycle `.close()` and `StoreClosedError`.
- Supersession consolidated to `writeAssertion({ supersedesId })`.
- `reindexNamespace()` defaults to atomic staging-swap.
- Coverage thresholds raised to 95/95/95/85.
- Version, README, CHANGELOG, and changesets aligned at 0.3.0.

Phase 1 and Phase 2 may interleave with Phase 3 design work; nothing in
Phase 3 should block Phase 1 from shipping when ready.

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

The drop-in story in ten lines. Pick any embedding provider; the example uses
the in-package `MockEmbeddingProvider` so the snippet runs without external
dependencies (results from the mock are not semantically meaningful — see
`EmbeddingProvider` below).

```typescript
import { TemporalStore, MockEmbeddingProvider } from 'trageti'

const store = await TemporalStore.create({
  database: 'rag.db',
  namespace: 'demo',
  embeddingProvider: new MockEmbeddingProvider({ dimension: 384 }),
})

await store.writeEpisode({ id: 'ep-1', namespace: 'demo', position: 1, content: 'Initial intake notes.' })
await store.writeAssertion({
  id: 'a-1', namespace: 'demo', type: 'observation',
  content: 'Patient reports occasional insomnia.',
  validFrom: 1, confidence: 0.9, sourceEpisodeId: 'ep-1',
  citations: [{ id: 'c-1', assertionId: 'a-1', episodeId: 'ep-1', sourceRef: 'intake#L4', excerpt: 'occasional insomnia' }],
})
await store.indexBatch([{ assertionId: 'a-1' }])

const { results, meta } = await store.retrieve({
  namespace: 'demo', queryText: 'sleep problems', temporalAnchor: 1,
})

await store.close()
```

For a real RAG path, replace `MockEmbeddingProvider` with a production adapter
such as `OllamaEmbeddingProvider`, `TransformersJsEmbeddingProvider`, or
`OpenAIEmbeddingProvider` (see Provider Adapters).

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

Episodes are source input events. Each episode belongs to a namespace and has a
caller-defined `position`, display/audit timestamp, type, content, and creation
timestamp.

v0.3 keeps the v0.2 episode shape. The write path validates required fields and
warns through the configured logger when content exceeds
`maxEpisodeContentBytes`.

### Assertion

Assertions are discrete claims. v0.3 keeps the v0.2 assertion shape:

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

`writeAssertion()` is the canonical way to create a replacement. When
`supersedesId` is non-null, the store validates the predecessor and atomically
sets the predecessor's `validUntil` to the new assertion's `validFrom`.

### AssertionCitation

Citations remain required for new assertions. Citation metadata is JSON. Citation
excerpts may be `null`, but the default validator/logger emits a structured
warning because uncited or unverifiable claims are weak inputs for high-stakes
RAG systems.

### AssertionLink

Links connect assertions without implying replacement unless the caller assigns
such semantics to the link type. Links retain their own validity windows and
source episode references.

Accumulation/linking remains distinct from supersession. If new information
layers on an older assertion, callers should keep both assertions valid and
connect them with a link such as `deepens`, `qualifies`, `contextualizes`,
`contradicts`, or `measures`.

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

The default CTE adapter must include cycle protection and tests for direct,
multi-hop, cyclic, expired-link, and max-depth scenarios.

### RetrievalScorer

Scorers continue to receive semantic distance, optional BM25 score, candidate
position, and scoring context. Batch scoring remains the preferred hook for
cross-candidate normalization.

### ContextFormatter

Formatters still receive retrieved assertions with full citations. v0.3 requires
formatters to report included count explicitly in metadata or an envelope field;
context assembly must not infer truncation state from formatter-private keys.

### AssertionValidator

Structural invariants cannot be bypassed by replacing validators. Custom
validators are domain validators and run after library integrity checks.

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
  tokenizer: 'unicode61' | 'ascii' | 'porter' | string
  tokenizerArgs?: string[]
  trustedCustomTokenizer?: boolean
}
```

Custom tokenizers require explicit trust opt-in. Built-in tokenizer args are
validated against known-safe forms.

### SchemaExtensions

Raw SQL schema extensions remain possible because some callers need full SQLite
power. v0.3 clarifies that raw schema SQL is trusted code. A constrained builder
API may be added for configuration-driven products:

```typescript
interface SchemaExtensions {
  columns?: ColumnExtension[]
  tables?: TableExtension[]
}
```

`deleteNamespace()` must either safely handle extension tables marked
`referencesNamespace: true` or fail with a clear cleanup error. Warning-only
deletion is not sufficient when dependent data may remain.

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

Provider adapters are optional and tree-shakable. The core package must not make
large or networked providers hard dependencies.

### Logger

```typescript
interface Logger {
  debug(code: string, fields?: Record<string, unknown>): void
  info(code: string, fields?: Record<string, unknown>): void
  warn(code: string, fields?: Record<string, unknown>): void
  error(code: string, fields?: Record<string, unknown>): void
}
```

Default logs must not include assertion content, episode content, embeddings,
query text, excerpts, secrets, or connection strings.

---

## Namespace Configuration

```typescript
interface TemporalStoreOptions {
  namespace: string
  embeddingDimension?: number
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
}
```

If `embeddingProvider` is supplied, its `dimension` is the namespace dimension
unless `embeddingDimension` is also supplied. Supplying both with different
values is invalid.

If a namespace already exists, initialization compares the configured dimension
with the stored dimension. A mismatch throws `NamespaceDimensionMismatchError`.

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
- one `vec0` embedding table per namespace

No core table rename is required for v0.3. Schema hardening focuses on
connection enforcement, validation, indexing behavior, and namespace lifecycle.

### Migration System

Migrations remain versioned and transaction-wrapped. The runner must fail with
`MigrationError` containing the migration version and cause.

The migration system must not silently ignore incompatible operator choices such
as changing FTS tokenizer configuration after data exists. It should warn or
fail with a clear path to rebuild the affected index.

---

## Initialization

### Recommended Path

```typescript
const store = await TemporalStore.create({
  database: 'rag.db',
  namespace: 'case-123',
  embeddingProvider: provider,
})
```

`TemporalStore.create()` performs the common setup and returns an initialized
store. It may accept either a filename or an existing `better-sqlite3` database.

### Low-Level Path

Advanced callers may still provide their own database and call initialization
explicitly:

```typescript
const db = prepareDatabase('rag.db')
const store = new TemporalStore(db, {
  namespace: 'case-123',
  embeddingDimension: 768,
})
store.init()
```

This path exists for embedding in larger applications that already control
database lifecycle.

---

## API

### Writing

```typescript
store.writeEpisode(episode): Episode
store.writeAssertion(assertion): Assertion
store.writeCitation(citation): AssertionCitation
store.writeLink(link): AssertionLink
```

`writeAssertion({ supersedesId })` is the canonical supersession API. Direct
calls to `supersedeAssertion()` are deprecated or moved to an advanced namespace
with strong warnings because standalone closure can create history without a
replacement assertion.

### Indexing

```typescript
interface IndexBatchResult {
  indexed: number
  skipped: Array<{ assertionId: string; reason: string }>
}

store.indexAssertion(assertionId: string, embedding?: Float32Array | number[]): Promise<void> | void
store.indexBatch(items: IndexBatchItem[]): Promise<IndexBatchResult> | IndexBatchResult
store.getPendingIndexing(namespace: string): Array<{ id: string; content: string }>
```

If an `EmbeddingProvider` is configured, `embedding` may be omitted and generated
from assertion content. Without a provider, vectors remain required.

### Retrieval

```typescript
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
  mode?: 'snapshot' | 'trajectory'
  scorer?: RetrievalScorer
  middleware?: RetrievalMiddleware[]
}

interface RetrievalResult {
  results: RetrievedAssertion[]
  meta: {
    namespace: string
    temporalAnchor: number
    limit: number
    candidateCount: number
    bm25Applied: boolean
    queryTextMode: QueryTextMode | null
    tookMs?: number
    warnings: Array<{ code: string; message: string }>
  }
}
```

If `queryEmbedding` is omitted, an `EmbeddingProvider` must be configured and the
store derives the query embedding from `queryText`.

### Context Assembly

Context assembly consumes `RetrievalResult` and produces an envelope containing
formatted text, included assertions, token estimate, truncation state, and
coverage metadata. The formatter contract must expose included count explicitly.

### Temporal Snapshot

Snapshot APIs remain array-returning utility calls unless debug metadata is
requested. They still return assertions valid at the requested position.

### Graph Traversal

```typescript
store.getConnected(options): Assertion[]
store.findPath(options): AssertionLink[] | null
```

`findPath()` must return the complete ordered path. Tests must verify that
`path[0].fromId === fromAssertionId`, each adjacent link connects, and the final
link's `toId === toAssertionId`.

### Maintenance

```typescript
store.deleteNamespace(namespace: string): void
store.reindexNamespace(namespace: string, options: ReindexOptions): Promise<ReindexResult>
store.getStats(namespace: string): NamespaceStats
store.getMigrations(): readonly Migration[]
store.getCurrentSchemaVersion(): number
store.explain(query: RetrievalQuery): RetrievalExplainResult
```

`deleteNamespace()` must remove core rows and namespace vector storage based on
database state, not process-local cache state.

`reindexNamespace()` must be atomic from the perspective of readers: either the
old index remains in use or the new index is complete.

---

## Retrieval Implementation

### Step 0: Validate and Normalize

Validate public query fields. Normalize defaults. Resolve namespace dimension.
If text embedding is needed, call the configured `EmbeddingProvider`.

### Step 1: Temporal Filter

Select assertion IDs valid at `temporalAnchor`, filtered by namespace, temporal
window, entity type, assertion type, confidence, and supersession policy.

### Step 2: Semantic Candidate Selection

Use `sqlite-vec` cosine distance over the namespace embedding table. Validate
query vector dimension before passing the vector to SQLite.

### Step 3: Keyword Scoring

If `queryText` is supplied, use safe phrase/literal mode by default. Raw FTS5
expression mode requires `queryTextMode: 'fts5'`.

### Step 4: Score

Hydrate candidates with assertions and citations, then call `scoreBatch()` when
available or per-candidate `score()` otherwise.

### Step 5: Rank and Truncate

Sort by score descending, apply `limit`, and produce result metadata.

### Step 6: Graph Expansion

When enabled, attach linked assertions with citations. Respect max depth and
temporal validity.

### Step 7: Trajectory Expansion

When `mode: 'trajectory'`, attach prior versions from the supersession chain,
oldest first, with citations.

---

## Logging and Observability

All warnings and operational events pass through `Logger`.

Required warning codes include:

- `NON_WAL_MODE`
- `FOREIGN_KEYS_UNAVAILABLE`
- `CITATION_EXCERPT_MISSING`
- `EPISODE_CONTENT_LARGE`
- `DELETE_NAMESPACE_HAS_REFERENCES`
- `INDEX_BATCH_SKIPPED`
- `REINDEX_STAGING_LEFTOVER`

`store.explain(query)` returns a structured description of SQL plans, candidate
counts, active filters, and whether semantic and keyword scoring are used.

---

## Error Model

Existing error classes remain. v0.3 adds:

```typescript
class NamespaceDimensionMismatchError extends TragetiError {}
class EmbeddingProviderError extends TragetiError {}
class IndexingError extends TragetiError {}
class RetrievalInputError extends TragetiError {}
class ReindexError extends TragetiError {}
```

Errors include stable `.code` values and structured fields where useful. Error
messages must be actionable without exposing source content, query text, or
embedding data.

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
`sqlite-vec`, FTS5, migrations, and file-backed databases.

Required test classes:

- File-backed create, close database, reopen, retrieve.
- Multi-instance namespace lifecycle, including deleting a namespace created by
  another store instance.
- Namespace dimension mismatch on reopen.
- Complete multi-hop `findPath()` paths, including cycles and max-depth misses.
- FTS adversarial inputs: quotes, parens, operators, asterisks, unicode, and
  empty/whitespace strings.
- Reindex provider failure preserves old embeddings.
- `indexBatch()` returns skipped IDs or throws based on configured policy.
- `deleteNamespace()` with extension tables marked `referencesNamespace: true`.
- Invalid public options fail before SQLite execution.
- E2E scenarios with realistic temporal drift: replacement, accumulation,
  contradiction, resolution, and citation-rich context assembly.

Coverage thresholds:

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
      RawVectorProvider.ts
      OllamaEmbeddingProvider.ts        # optional adapter
      TransformersJsEmbeddingProvider.ts # optional adapter
      OpenAIEmbeddingProvider.ts        # optional adapter
  defaults/
    logging/
      ConsoleLogger.ts
      NoopLogger.ts
  db/
    prepareDatabase.ts
  observability/
    explain.ts
```

Optional adapters should be subpath exports or separate packages if they require
additional runtime dependencies.

---

## Peer Dependencies

Core runtime dependency posture:

- `better-sqlite3` remains a required peer for the default database path.
- `sqlite-vec` is required for vector retrieval, but the package should avoid
  forcing heavy adapter dependencies. If `prepareDatabase()` imports
  `sqlite-vec`, document the install requirement and consider an optional peer
  or subpath helper.

Provider adapters may declare their own optional peer dependencies.

---

## What This Library Does Not Do

- It does not decide whether an assertion is true.
- It does not provide medical, legal, safety, or investigative judgment.
- It does not encrypt the database or manage backup retention.
- It does not coordinate multi-process writes without caller-provided locking.
- It does not make raw schema-extension SQL safe for untrusted users.
- It does not require a specific embedding vendor or model.

---

## Migration Guide v0.2 to v0.3

### Supersession

Before:

```typescript
store.writeAssertion({ id: 'new', supersedesId: 'old', /* ... */ })
store.supersedeAssertion('old', { validUntil: 5, replacedById: 'new' })
```

After:

```typescript
store.writeAssertion({ id: 'new', validFrom: 5, supersedesId: 'old', /* ... */ })
```

### Retrieval

Before:

```typescript
const results = store.retrieve(query)
```

After:

```typescript
const { results, meta } = await store.retrieve(query)
```

### Keyword Querying

Before:

```typescript
store.retrieve({ queryText: 'alpha AND beta', /* ... */ })
```

After:

```typescript
store.retrieve({ queryText: 'alpha AND beta', queryTextMode: 'phrase', /* ... */ })
store.retrieve({ queryText: 'alpha AND beta', queryTextMode: 'fts5', /* advanced */ })
```

### Batch Indexing

Before:

```typescript
store.indexBatch(items)
```

After:

```typescript
const result = await store.indexBatch(items)
if (result.skipped.length > 0) {
  logger.warn('INDEX_BATCH_SKIPPED', { count: result.skipped.length })
}
```

### Reindexing

Before:

```typescript
await store.reindexNamespace(ns, { newDimension, embeddingProvider })
```

After:

```typescript
const result = await store.reindexNamespace(ns, {
  newDimension,
  embeddingProvider,
  strategy: 'staging-swap',
})
```

---

## Open Questions

- Should `sqlite-vec` be a required peer, optional peer, or isolated behind a
  `prepareDatabase` subpath export?
- Should provider adapters live in the core package, subpath exports, or
  companion packages?
- Should `retrieve()` become async universally to support embedding providers,
  or should manual-vector retrieval remain synchronous with a separate async
  helper?
- Should `supersedeAssertion()` be removed entirely or retained as an advanced
  escape hatch for closing assertions with no replacement?
- Should v0.3 include a constrained schema-extension builder, or only clarify
  the trust boundary?
- Should multi-process write coordination remain caller-managed or become a
  first-party lock helper?
