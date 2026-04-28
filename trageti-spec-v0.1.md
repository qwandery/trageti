# trageti
## Package Specification v0.1

**Status:** Design specification — not yet implemented  
**Date:** April 2026  
**License intent:** MIT  
**Target runtime:** Node.js 18+ / TypeScript 5+

---

## What This Is

`trageti` is a lightweight TypeScript library for temporally-aware retrieval-augmented generation over a SQLite database. It stores, indexes, and retrieves *episodic assertions* — discrete, typed claims with explicit validity windows — with retrieval that respects temporal position as a first-class constraint alongside semantic similarity.

The core problem it solves: standard vector similarity retrieval is temporally blind. The same text at two different points in a sequence may carry completely different meaning. This library makes temporal position an explicit retrieval filter — not a scoring hint — ensuring that "what was understood as of position N" is always answerable correctly regardless of when assertions were recorded.

It depends only on:
- `better-sqlite3` (or any compatible SQLite binding)
- `sqlite-vec` (SQLite vector extension)

It works with any SQLite database. Encryption, connection lifecycle, and extension loading are the caller's responsibility. The library operates on whatever connection it receives.

---

## Design Principles

**Temporal position is a retrieval dimension, not metadata.** Every assertion has a validity window defined by two numeric positions — when it became true and when (if ever) it was superseded. These numbers have no intrinsic meaning assigned by the library. They are caller-defined ordinal values: consistent, comparable, and stable within a namespace. Retrieval queries specify a temporal anchor; assertions outside their validity window are excluded before any scoring begins.

**Assertions, not chunks.** The unit of storage is a discrete, interpretable claim — not a raw text chunk. Assertions embed cleanly, retrieve precisely, and carry enough semantic content to be useful without surrounding context.

**Supersession is explicit.** When new information changes the meaning of a prior assertion, the prior assertion is not deleted or overwritten — it is marked as superseded with a pointer to the assertion that replaced it. History is always preserved; current state is always unambiguous.

**Provenance is non-negotiable.** Every assertion traces back to a source episode — the input event that produced it. Retrieval results always include provenance so callers can cite, audit, or verify.

**Extensibility over prescription.** The library ships default implementations of all major subsystems — scoring, graph traversal, context formatting, validation, connection verification. Every subsystem is replaceable by the caller through a defined interface. The library never requires a caller to accept a default that doesn't fit their domain.

**Bring your own connection.** The library does not open, close, or manage database connections. The caller is fully responsible for connection lifecycle, configuration, and any extensions loaded before `init()` is called.

**Bring your own embeddings.** The library does not call any embedding model. The caller provides embeddings as `Float32Array` or `number[]`. The embedding model, its dimensions, and its runtime are entirely the caller's concern.

---

## Core Concepts

### Episode

An **episode** is a source input event — the raw material from which assertions are derived. Episodes provide provenance: every assertion traces back to the episode that produced it.

```typescript
interface Episode {
  id: string
  namespace: string
  position: number        // caller-defined ordinal: consistent, comparable, stable
  occurredAt: string      // ISO 8601 — real-world time of the event; display and audit only
  type: string            // caller-defined; opaque to the library
  content: string         // source material; see content size guidance below
  createdAt: string       // ISO 8601 — when the system recorded this episode
}
```

`position` is the primary temporal axis. The library assigns no meaning to this number — it is a caller-defined ordinal that places the episode in the sequence of events within a namespace. The caller decides what constitutes a position unit (a document index, a version number, a chapter number, a Unix timestamp) and is responsible for assigning positions consistently. The only constraints enforced by the library: positions must be numeric, and within a namespace they must increase monotonically for new episodes.

`occurredAt` is stored for display and audit purposes. It does not participate in retrieval ordering.

`content` stores the source material for provenance. There is no enforced size limit. However: large content values increase storage cost and slow namespace operations that iterate over episodes. Callers are strongly encouraged to store compact representations (summaries, excerpts) rather than full source documents. A warning is emitted at write time if content exceeds the configured `maxEpisodeContentBytes` threshold (default: 8,192 bytes; set to 0 to disable).

### Assertion

An **assertion** is a discrete, interpretable claim derived from one or more episodes. It is the fundamental unit of storage and retrieval.

```typescript
interface Assertion {
  id: string
  namespace: string
  type: string            // caller-defined; see recommended taxonomy below
  content: string         // the claim, in natural language
  validFrom: number       // position at which this became true
  validUntil: number | null  // position at which superseded; null = currently valid
  confidence: number      // 0.0–1.0; caller-assigned
  sourceEpisodeId: string // FK → episodes.id
  supersedesId: string | null  // FK → assertions.id — the assertion this replaces
  entityId: string | null      // optional: groups assertions about the same entity
  entityType: string | null    // optional: caller-defined entity classification
  createdAt: string       // ISO 8601 — when the system recorded this assertion
}
```

**Validity window constraint:** `validUntil` must be null (currently valid) or a number strictly greater than `validFrom`. The library enforces this at write time and throws on violation. The position values themselves carry no inherent meaning — "position 5 through position 12" is valid regardless of what those numbers represent to the caller.

**Recommended assertion type taxonomy.** The library treats `type` as an opaque string — it does not interpret or validate type values. The following values are recommended as a starting vocabulary that covers common use cases across domains. Callers may use any string values, ignore this taxonomy entirely, or extend it:

```typescript
// Recommended starting vocabulary — not enforced by the library
const RecommendedAssertionTypes = {
  FACT:                'fact',             // a new claim established by this episode
  UPDATE:              'update',           // incremental change to an existing assertion
  RECONTEXTUALIZATION: 'recontextualization', // existing understanding reframed
  RESOLUTION:          'resolution',       // an open question or active state closed
  REGRESSION:          'regression',       // a previously resolved state re-emerging
  ABSENCE:             'absence',          // something expected that was notably absent
  PATTERN:             'pattern',          // an observation that spans multiple episodes
} as const
```

### AssertionLink

An **assertion link** is a typed, temporal relationship between two assertions.

```typescript
interface AssertionLink {
  id: string
  namespace: string
  fromId: string
  toId: string
  linkType: string        // caller-defined; see recommended taxonomy below
  validFrom: number
  validUntil: number | null  // same validity constraint as assertions
  sourceEpisodeId: string
  createdAt: string
}

// Recommended starting vocabulary — not enforced by the library
const RecommendedLinkTypes = {
  RELATED:      'related',       // general relationship
  GENERATIVE:   'generative',    // A gave rise to B
  INHIBITORY:   'inhibitory',    // A blocks or limits B
  SEQUENTIAL:   'sequential',    // B emerged after A resolved
  SUPERSEDES:   'supersedes',    // B explicitly replaces A
} as const
```

---

## Extension Interfaces

All major subsystems are replaceable. Extension interfaces are defined in `types.ts` and exported as part of the public API. Default implementations ship with the library and are used unless overridden at init time.

### GraphQueryAdapter

Replaces the library's default CTE-based graph traversal. Implement this interface to use Cypher, GraphQL, a REST-based graph API, or any other traversal mechanism.

```typescript
interface GraphQueryAdapter {
  /**
   * Find assertions connected to the given assertion IDs via links.
   * Must respect the temporal anchor — only follow links valid at that position.
   */
  findConnected(
    db: Database,
    namespace: string,
    fromIds: string[],
    options: TraversalOptions
  ): AssertionLink[]

  /**
   * Find the shortest path between two assertions via links.
   * Returns null if no path exists within maxDepth.
   */
  findPath(
    db: Database,
    namespace: string,
    fromId: string,
    toId: string,
    options: PathOptions
  ): AssertionLink[] | null
}

interface TraversalOptions {
  temporalAnchor: number
  maxDepth: number          // no hard cap; caller and adapter negotiate this
  linkTypes?: string[]      // null = all types
  includeSuperseded?: boolean
}

interface PathOptions extends TraversalOptions {}

// Default implementation — recursive CTEs, no external dependencies
class CTEGraphAdapter implements GraphQueryAdapter { ... }
```

Register at init time:

```typescript
const store = new TemporalStore(db, {
  namespace: 'my-namespace',
  graphAdapter: new MyCypherAdapter(db)  // optional; defaults to CTEGraphAdapter
})
```

### RetrievalScorer

Replaces the default composite scoring model entirely. The scorer receives raw signal values for each candidate and returns a single numeric score. Higher scores rank higher.

```typescript
interface ScoredCandidate {
  assertion: Assertion
  semanticDistance: number    // cosine distance from sqlite-vec; lower = more similar
  bm25Score: number | null    // BM25 score from FTS5; null if no queryText provided
                              // Note: FTS5 BM25 scores are negative; more negative = better match
  position: number            // assertion's validFrom, for recency calculations
}

interface ScoringContext {
  temporalAnchor: number      // the query's temporal anchor
  namespacePositionRange: {   // min/max positions in this namespace, for normalization
    min: number
    max: number
  }
  query: RetrievalQuery
}

interface RetrievalScorer {
  score(candidate: ScoredCandidate, context: ScoringContext): number
}

// Default implementation — weighted linear combination with normalization
// Weights: semantic 0.6, keyword 0.3, recency 0.1
// Normalization: cosine distance inverted to similarity [0,1];
//   BM25 negated and min-max normalized to [0,1] over candidate set;
//   recency linearly scaled by position within namespace range
class DefaultScorer implements RetrievalScorer { ... }
```

Register at init time:

```typescript
const store = new TemporalStore(db, {
  namespace: 'my-namespace',
  scorer: new MyDomainScorer()  // optional; defaults to DefaultScorer
})
```

### ContextFormatter

Replaces the default context assembly output format. Receives the ranked assertion list and produces whatever string representation the caller needs.

```typescript
interface ContextFormatter {
  format(
    assertions: RetrievedAssertion[],
    options: ContextAssemblyOptions
  ): FormattedContext
}

interface FormattedContext {
  text: string              // the formatted output
  tokenEstimate: number     // caller's best estimate of token cost
  truncated: boolean        // true if token budget caused truncation
  metadata: Record<string, unknown>  // formatter-specific metadata
}

// Default formatters provided by the library:
class ProseFormatter implements ContextFormatter { ... }
class StructuredFormatter implements ContextFormatter { ... }
class JsonFormatter implements ContextFormatter { ... }
```

Register at init time or per `assembleContext()` call:

```typescript
// At init — sets default for all assembleContext() calls
const store = new TemporalStore(db, {
  namespace: 'my-namespace',
  defaultFormatter: new MyXmlFormatter()
})

// Per call — overrides the default for this call only
store.assembleContext({
  ...options,
  formatter: new MyXmlFormatter()
})
```

**Token estimation.** The default formatters use a configurable `tokensPerChar` approximation (default: 0.25). This is a rough estimate and will be wrong for text with unusual tokenization characteristics. Callers who need accurate token counting should implement a custom `ContextFormatter` that uses their actual tokenizer. The `tokenEstimate` field in `FormattedContext` is what the library uses for budget enforcement — a custom formatter controls this value directly.

### AssertionValidator

Registers custom validation logic that runs before any assertion is written to the store. Multiple validators may be registered; all must pass for the write to succeed.

```typescript
interface AssertionValidator {
  validate(assertion: Omit<Assertion, 'createdAt'>): ValidationResult
}

interface ValidationResult {
  valid: boolean
  errors: string[]    // empty if valid
}

// Default validator enforces:
//   - id, namespace, type, content, validFrom, sourceEpisodeId are non-empty
//   - validUntil is null or > validFrom
//   - confidence is in [0.0, 1.0]
//   - sourceEpisodeId references an existing episode in the namespace
class DefaultAssertionValidator implements AssertionValidator { ... }
```

Register at init time:

```typescript
const store = new TemporalStore(db, {
  namespace: 'my-namespace',
  validators: [
    new DefaultAssertionValidator(),  // include if you want default validation plus custom
    new MyDomainValidator()
  ]
})
```

### ConnectionVerifier

Replaces the library's default connection verification logic. Runs during `init()` to confirm the connection meets the library's requirements.

```typescript
interface ConnectionVerifier {
  /**
   * Called during init(). Should throw with a descriptive message
   * if the connection does not meet requirements.
   * Default implementation checks: WAL mode, foreign keys enabled,
   * sqlite-vec loaded. Callers may replace this to adjust requirements
   * or add domain-specific checks.
   */
  verify(db: Database): void
}

class DefaultConnectionVerifier implements ConnectionVerifier {
  verify(db: Database): void {
    // Checks WAL journal mode
    // Checks sqlite-vec is loaded (required for vector operations)
    // Emits warnings (not errors) for: foreign keys disabled, non-WAL journal mode
    // Throws if sqlite-vec is not available
  }
}
```

Register at init time:

```typescript
const store = new TemporalStore(db, {
  namespace: 'my-namespace',
  connectionVerifier: new MyConnectionVerifier()
})
```

### RetrievalMiddleware

Pre- and post-retrieval hooks for logging, caching, mutation, or any other cross-cutting concern. Applied in registration order on the way in, and in reverse order on the way out.

```typescript
interface RetrievalMiddleware {
  before?(query: RetrievalQuery): RetrievalQuery    // may mutate or replace the query
  after?(results: RetrievedAssertion[], query: RetrievalQuery): RetrievedAssertion[]
}

// Example: logging middleware
class LoggingMiddleware implements RetrievalMiddleware {
  before(query) { console.log('retrieving', query.namespace, query.temporalAnchor); return query }
  after(results, query) { console.log('retrieved', results.length, 'assertions'); return results }
}
```

Register at init time (applied to all retrieve() calls) or per retrieve() call:

```typescript
// Global — all retrieve() calls
const store = new TemporalStore(db, {
  namespace: 'my-namespace',
  middleware: [new LoggingMiddleware(), new CachingMiddleware()]
})

// Per call
store.retrieve({ ...query, middleware: [new DebugMiddleware()] })
```

### FTS5Tokenizer

Configures the FTS5 tokenizer used for keyword indexing. Must be set at init time — the FTS5 virtual table is created once and cannot be re-created without a full data rebuild.

```typescript
interface FTS5TokenizerConfig {
  tokenizer: string          // FTS5 tokenizer name: 'unicode61' | 'ascii' | 'porter' | custom
  tokenizerArgs?: string[]   // tokenizer-specific arguments
}

// Default: unicode61 with diacritics removal
const defaultTokenizer: FTS5TokenizerConfig = {
  tokenizer: 'unicode61',
  tokenizerArgs: ['remove_diacritics', '1']
}
```

**Warning:** The tokenizer is fixed at the time the FTS5 virtual table is created. Changing it requires dropping and rebuilding the FTS table, which is a destructive migration. Choose carefully. The library logs a warning if a different tokenizer config is passed to `init()` after the table already exists.

### SchemaExtensions

Registers caller-owned columns and tables alongside the library's schema. This is the supported path for extending `trl_assertions`, `trl_episodes`, or `trl_links` with application-specific fields, and for registering caller-managed tables that reference library tables.

```typescript
interface ColumnExtension {
  table: 'trl_assertions' | 'trl_episodes' | 'trl_links'
  column: string         // must not start with 'trl_' or shadow any existing library column
  definition: string     // SQL column definition: type + optional DEFAULT + optional CHECK
  description?: string   // documentation only; not stored in the database
}

interface TableExtension {
  tableName: string      // must not start with 'trl_'
  createSQL: string      // full CREATE TABLE IF NOT EXISTS statement
  referencesNamespace: boolean  // if true, deleteNamespace() will warn before proceeding
  description?: string
}

interface SchemaExtensions {
  columns?: ColumnExtension[]
  tables?: TableExtension[]
}
```

**Column extensions.** Registered columns are applied via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` during `init()`, after the library's own schema is in place. If the column already exists it is left untouched. The column definition is recorded so that future library migrations know to preserve it.

Extended columns are surfaced on returned `Assertion` and `Episode` objects as an `extensions` bag:

```typescript
// After registering 'approval_status' on trl_assertions:
const assertion = store.getAssertions(namespace)[0]
assertion.extensions.approval_status  // string | null
```

The library never reads or writes extended columns itself. They are `null` in all library-written rows unless the caller sets them separately via direct SQL or a post-write hook.

**Table extensions.** `init()` runs the provided `createSQL` for each registered table extension. The library records the table name. When `deleteNamespace()` is called, the library checks for registered tables with `referencesNamespace: true` and either cascades (if the caller's table has `ON DELETE CASCADE` on its foreign key) or halts with a descriptive error requiring the caller to clean up dependent data first.

**Safety checks enforced at init time:**
- Column names must not start with `trl_`
- Column names must not shadow any existing library column on the target table
- Column names must not be SQLite reserved keywords
- Table names must not start with `trl_`
- Violations throw with a descriptive error; the library does not partially apply extensions

**Filtering on extended columns.** Extended columns do not participate in the standard `retrieve()` filter API. Callers who need to filter retrieval results on extended column values should do so via `RetrievalMiddleware` (post-retrieval filtering) or via a custom `GraphQueryAdapter` that has full query access.

**Example:**

```typescript
const store = new TemporalStore(db, {
  namespace: 'my-namespace',
  schemaExtensions: {
    columns: [
      {
        table: 'trl_assertions',
        column: 'approval_status',
        definition: "TEXT NOT NULL DEFAULT 'pending'",
        description: 'Application-layer approval state'
      },
      {
        table: 'trl_assertions',
        column: 'source_chunk_index',
        definition: 'INTEGER',
        description: 'Index of the source chunk within the episode'
      }
    ],
    tables: [
      {
        tableName: 'app_assertion_approvals',
        createSQL: `
          CREATE TABLE IF NOT EXISTS app_assertion_approvals (
            assertion_id  TEXT PRIMARY KEY REFERENCES trl_assertions(id),
            status        TEXT NOT NULL DEFAULT 'pending',
            reviewed_at   TEXT,
            reviewed_by   TEXT
          )
        `,
        referencesNamespace: true,
        description: 'Application approval workflow for assertions'
      }
    ]
  }
})
```

---

## Namespace Configuration

Each namespace has its own configuration record, stored in `trl_namespaces`. This enables different namespaces within the same database to use different embedding dimensions, different default settings, and different metadata.

```typescript
interface NamespaceConfig {
  namespace: string
  embeddingDimension: number  // fixed per namespace; changing requires full reindex
  createdAt: string
  config: Record<string, unknown>  // arbitrary caller metadata; stored as JSON
}
```

Embedding dimension is set when a namespace is first initialized and cannot be changed without a full reindex of all assertions in that namespace. The library provides a migration utility for this:

```typescript
// Reindex a namespace with a new embedding dimension
// Requires the caller to provide new embeddings for all assertions
store.reindexNamespace(namespace, {
  newDimension: 768,
  embeddingProvider: async (assertionId: string, content: string) => Float32Array
})
```

---

## Schema and Migrations

### Schema

```sql
-- Namespace configuration (one record per namespace)
CREATE TABLE IF NOT EXISTS trl_namespaces (
  namespace           TEXT PRIMARY KEY,
  embedding_dimension INTEGER NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  config              TEXT NOT NULL DEFAULT '{}'   -- JSON
);

-- Source episodes (provenance anchors)
CREATE TABLE IF NOT EXISTS trl_episodes (
  id                TEXT PRIMARY KEY,
  namespace         TEXT NOT NULL REFERENCES trl_namespaces(namespace),
  position          REAL NOT NULL,    -- numeric ordinal; REAL to support fractional positions
  occurred_at       TEXT NOT NULL,    -- ISO 8601; display and audit only
  type              TEXT NOT NULL,
  content           TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Discrete temporal assertions
CREATE TABLE IF NOT EXISTS trl_assertions (
  id                TEXT PRIMARY KEY,
  namespace         TEXT NOT NULL REFERENCES trl_namespaces(namespace),
  type              TEXT NOT NULL,
  content           TEXT NOT NULL,
  valid_from        REAL NOT NULL,    -- REAL to support fractional positions
  valid_until       REAL,             -- null = currently valid; must be > valid_from if set
  confidence        REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source_episode_id TEXT NOT NULL REFERENCES trl_episodes(id),
  supersedes_id     TEXT REFERENCES trl_assertions(id),
  entity_id         TEXT,
  entity_type       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

-- Typed links between assertions
CREATE TABLE IF NOT EXISTS trl_links (
  id                TEXT PRIMARY KEY,
  namespace         TEXT NOT NULL REFERENCES trl_namespaces(namespace),
  from_id           TEXT NOT NULL REFERENCES trl_assertions(id),
  to_id             TEXT NOT NULL REFERENCES trl_assertions(id),
  link_type         TEXT NOT NULL,
  valid_from        REAL NOT NULL,
  valid_until       REAL,
  source_episode_id TEXT NOT NULL REFERENCES trl_episodes(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

-- Vector index — one table per namespace (dimension varies)
-- Named trl_embeddings_{namespace} to support per-namespace dimensions
-- Created dynamically by TemporalStore.init() for each namespace

-- Full-text search index
CREATE VIRTUAL TABLE IF NOT EXISTS trl_fts USING fts5(
  assertion_id UNINDEXED,
  content,
  content='trl_assertions',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 1'   -- overridden by FTS5TokenizerConfig
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS trl_schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
  description TEXT NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS trl_idx_assertions_ns_pos
  ON trl_assertions(namespace, valid_from, valid_until);
CREATE INDEX IF NOT EXISTS trl_idx_assertions_entity
  ON trl_assertions(namespace, entity_id, entity_type);
CREATE INDEX IF NOT EXISTS trl_idx_assertions_episode
  ON trl_assertions(source_episode_id);
CREATE INDEX IF NOT EXISTS trl_idx_links_from
  ON trl_links(namespace, from_id, valid_until);
CREATE INDEX IF NOT EXISTS trl_idx_links_to
  ON trl_links(namespace, to_id, valid_until);
CREATE INDEX IF NOT EXISTS trl_idx_episodes_ns_pos
  ON trl_episodes(namespace, position);
```

**Note on REAL for position columns.** Position values are stored as REAL (64-bit float) to support fractional positions (e.g., 7.5 to represent an event between position 7 and position 8). Callers who use only integer positions are unaffected. Integer values are represented exactly in IEEE 754 double precision up to 2^53.

**Note on per-namespace embedding tables.** Because embedding dimensions vary per namespace, vector tables are created as `trl_embeddings_{namespace_hash}` where `namespace_hash` is a stable identifier derived from the namespace string. The namespace registry in `trl_namespaces` maps namespace to its embedding table name.

### Migration System

The library manages its own schema migrations. On every `init()` call, the library checks `trl_schema_version` against its internal migration list and applies any pending migrations in order. Migrations are additive — they never drop columns or tables. Destructive changes require explicit caller action.

```typescript
interface Migration {
  version: number
  description: string
  up: (db: Database) => void    // apply the migration
  down?: (db: Database) => void // optional rollback; not all migrations are reversible
}

// Access migrations programmatically
store.getMigrations(): Migration[]
store.getCurrentSchemaVersion(): number
store.applyMigrations(): void   // called automatically by init(); also callable manually
```

Callers who need to extend the schema — adding application-specific columns to `trl_assertions` or `trl_episodes`, or registering application-managed tables that reference library tables — should use the `schemaExtensions` option at init time. See the Schema Extensions section. The `trl_` prefix is reserved for library-managed tables and columns.

---

## Initialization

```typescript
import { TemporalStore } from 'trageti'

interface TemporalStoreOptions {
  namespace: string                    // default namespace for calls that don't specify one
  embeddingDimension: number           // required for new namespaces
  maxEpisodeContentBytes?: number      // content size warning threshold; default 8192; 0 = disabled
  graphAdapter?: GraphQueryAdapter     // default: CTEGraphAdapter
  scorer?: RetrievalScorer             // default: DefaultScorer
  defaultFormatter?: ContextFormatter  // default: ProseFormatter
  validators?: AssertionValidator[]    // default: [DefaultAssertionValidator]
  connectionVerifier?: ConnectionVerifier // default: DefaultConnectionVerifier
  middleware?: RetrievalMiddleware[]   // default: []
  fts5Tokenizer?: FTS5TokenizerConfig  // default: unicode61 with diacritics removal
  schemaExtensions?: SchemaExtensions  // default: none; see Schema Extensions section
}

// Caller fully controls the connection before passing it in
const store = new TemporalStore(db, options)

// init() runs connection verification, applies migrations, creates namespace if new
store.init()
```

**Connection requirements.** The default `ConnectionVerifier` requires sqlite-vec to be loaded before `init()` is called, and warns if WAL mode is not enabled. The library does not enforce WAL mode or foreign keys — it warns. Callers who replace `ConnectionVerifier` control all of this. The library documents what it assumes about connection state; the verifier enforces those assumptions.

**Concurrent writes.** SQLite in WAL mode supports one writer at a time. The library does not add a concurrency layer on top of SQLite's own serialization. For single-process desktop applications, SQLite's built-in write serialization is sufficient. For multi-process scenarios, callers are responsible for coordinating writes. The library does not attempt to detect or resolve write conflicts — it relies on SQLite's ACID guarantees.

---

## API

### Writing

```typescript
// Register or retrieve a namespace
store.initNamespace(namespace: string, config: Partial<NamespaceConfig>): void

// Write a source episode
store.writeEpisode(episode: Omit<Episode, 'createdAt'>): Episode

// Write an assertion — runs all registered validators before writing
store.writeAssertion(assertion: Omit<Assertion, 'createdAt'>): Assertion

// Mark an existing assertion as superseded
store.supersedeAssertion(assertionId: string, options: {
  validUntil: number    // must be > assertion's validFrom
  replacedById?: string // optional FK to the replacing assertion
}): void

// Write a typed link between two assertions
store.writeLink(link: Omit<AssertionLink, 'createdAt'>): AssertionLink
```

### Indexing

```typescript
// Index a single assertion with a caller-provided embedding
store.indexAssertion(assertionId: string, embedding: Float32Array | number[]): void

// Get all assertions in a namespace that have not yet been indexed
// Returns id and content; caller generates embeddings externally
store.getPendingIndexing(namespace: string): Array<{ id: string, content: string }>

// Index a batch of assertions
store.indexBatch(items: Array<{
  assertionId: string,
  embedding: Float32Array | number[]
}>): void
```

### Retrieval

```typescript
interface RetrievalQuery {
  namespace: string
  queryEmbedding: Float32Array | number[]
  queryText?: string           // enables BM25 scoring if provided
  temporalAnchor: number       // retrieve assertions valid AT this position
  temporalWindow?: {
    from?: number
    to?: number
  }
  entityTypes?: string[]
  assertionTypes?: string[]    // string, not enum — any values accepted
  minConfidence?: number
  includeSuperseded?: boolean  // default false
  expandLinks?: boolean        // default false — one hop via GraphQueryAdapter
  maxDepth?: number            // used if expandLinks true; passed to GraphQueryAdapter
  limit?: number               // default 10
  scorer?: RetrievalScorer     // per-call scorer override
  middleware?: RetrievalMiddleware[]  // per-call middleware (appended to global list)
}

interface RetrievedAssertion extends Assertion {
  score: number
  scoreComponents: {           // raw inputs to the scorer; always provided for transparency
    semanticDistance: number
    bm25Score: number | null
    position: number
  }
  linkedAssertions?: Assertion[]
}

store.retrieve(query: RetrievalQuery): RetrievedAssertion[]
```

### Context Assembly

```typescript
interface ContextAssemblyOptions {
  namespace: string
  queryEmbedding: Float32Array | number[]
  queryText?: string
  temporalAnchor: number
  tokenBudget: number
  expandLinks?: boolean
  maxDepth?: number
  scorer?: RetrievalScorer
  middleware?: RetrievalMiddleware[]
  formatter?: ContextFormatter   // per-call override
}

interface AssembledContext {
  text: string
  assertions: RetrievedAssertion[]
  tokenEstimate: number
  truncated: boolean
  metadata: Record<string, unknown>   // formatter-specific
  coverage: {
    totalAssertions: number
    includedAssertions: number
    positionRange: { from: number, to: number }
  }
}

store.assembleContext(options: ContextAssemblyOptions): AssembledContext
```

### Temporal Snapshot

```typescript
store.getTemporalSnapshot(options: {
  namespace: string
  atPosition: number         // renamed from atSequence — position-neutral language
  entityTypes?: string[]
  assertionTypes?: string[]
  includeSuperseded?: boolean
}): Assertion[]
```

### Graph Traversal

```typescript
store.getConnected(options: {
  namespace: string
  fromAssertionId: string
  maxDepth?: number          // no hard cap; passed to GraphQueryAdapter
  linkTypes?: string[]
  temporalAnchor: number
}): Assertion[]

store.findPath(options: {
  namespace: string
  fromAssertionId: string
  toAssertionId: string
  maxDepth?: number
  temporalAnchor: number
}): AssertionLink[] | null
```

### Utility

```typescript
// Get assertions with optional filters
store.getAssertions(namespace: string, options?: {
  entityId?: string
  entityType?: string
  type?: string
  validAt?: number
  includeSuperseded?: boolean
}): Assertion[]

// Full history for an entity including superseded assertions
store.getEntityHistory(namespace: string, entityId: string): Assertion[]

// Episode by ID
store.getEpisode(id: string): Episode | null

// Delete all data for a namespace — irreversible
store.deleteNamespace(namespace: string): void

// Reindex a namespace with a new embedding dimension
store.reindexNamespace(namespace: string, options: {
  newDimension: number
  embeddingProvider: (assertionId: string, content: string) => Promise<Float32Array>
}): Promise<void>

// Namespace statistics
store.getStats(namespace: string): {
  episodeCount: number
  assertionCount: number
  activeAssertionCount: number
  supersededCount: number
  indexedCount: number
  linkCount: number
  positionRange: { min: number, max: number }
}

// Schema and migration access
store.getMigrations(): Migration[]
store.getCurrentSchemaVersion(): number
store.applyMigrations(): void
```

---

## Retrieval Implementation

The `retrieve()` method executes in six steps. Steps 1–3 are SQL; steps 4–6 are TypeScript.

### Step 1: Temporal Filter

```sql
SELECT a.id, a.content, a.valid_from, a.confidence, a.entity_type
FROM trl_assertions a
WHERE a.namespace = :namespace
  AND a.valid_from <= :temporalAnchor
  AND (a.valid_until IS NULL OR a.valid_until > :temporalAnchor)
  AND (:minConfidence IS NULL OR a.confidence >= :minConfidence)
  AND (:includeSuperseded = 1 OR a.supersedes_id IS NULL OR a.valid_until IS NULL)
```

Executed first. No vector computation. Returns the bounded candidate set.

### Step 2: Semantic Scoring

```sql
SELECT
  ae.assertion_id,
  vec_distance_cosine(ae.embedding, :queryEmbedding) AS semantic_distance
FROM trl_embeddings_{ns} ae
WHERE ae.assertion_id IN (/* step 1 results */)
ORDER BY semantic_distance ASC
LIMIT :limit * 3
```

Oversamples by 3× for hybrid reranking.

### Step 3: Keyword Scoring (if queryText provided)

```sql
SELECT f.assertion_id, bm25(trl_fts) AS bm25_score
FROM trl_fts f
WHERE trl_fts MATCH :queryText
  AND f.assertion_id IN (/* step 1 results */)
```

FTS5 BM25 scores are negative (more negative = better match). The scorer receives raw values; normalization is the scorer's responsibility.

### Step 4: Score

Each candidate is passed to the registered `RetrievalScorer` with its raw signal values. The scorer returns a single numeric score. No scoring logic exists outside the scorer interface.

### Step 5: Rank and Truncate

Results sorted by score descending, truncated to `limit`. `scoreComponents` is always populated for transparency regardless of scorer implementation.

### Step 6: Graph Expansion (if expandLinks)

Delegated to the registered `GraphQueryAdapter`. One or more hops depending on `maxDepth`. Linked assertions are attached to their parent result and do not consume ranking slots.

---

## Package Structure

```
trageti/
├── src/
│   ├── index.ts               — public API exports
│   ├── TemporalStore.ts       — main class and init logic
│   ├── schema.ts              — DDL, migrations, version management
│   ├── retrieval.ts           — retrieve(), pipeline orchestration
│   ├── assembly.ts            — assembleContext()
│   ├── graph.ts               — getConnected(), findPath()
│   ├── snapshot.ts            — getTemporalSnapshot()
│   ├── adapters/
│   │   ├── CTEGraphAdapter.ts
│   │   ├── DefaultScorer.ts
│   │   ├── ProseFormatter.ts
│   │   ├── StructuredFormatter.ts
│   │   ├── JsonFormatter.ts
│   │   ├── DefaultAssertionValidator.ts
│   │   └── DefaultConnectionVerifier.ts
│   └── types.ts               — all exported interfaces and types
├── test/
│   ├── temporal-filter.test.ts
│   ├── semantic-retrieval.test.ts
│   ├── graph-traversal.test.ts
│   ├── supersession.test.ts
│   ├── context-assembly.test.ts
│   ├── adapters.test.ts
│   ├── migrations.test.ts
│   ├── schema-extensions.test.ts
│   └── fixtures/
│       └── scenario.ts        — domain-neutral test data
├── package.json
├── tsconfig.json
└── README.md
```

---

## Peer Dependencies

```json
{
  "peerDependencies": {
    "better-sqlite3": ">=9.0.0"
  }
}
```

`sqlite-vec` is not listed as a peer dependency because it is a native binary extension, not an npm package. The README documents installation per platform. The `DefaultConnectionVerifier` will throw with a descriptive error if sqlite-vec is not loaded before `init()` is called.

---

## What This Library Does Not Do

**It does not call embedding models.** Embeddings are provided by the caller as numeric arrays.

**It does not extract assertions from source material.** Extraction pipelines, LLM calls, and assertion derivation logic are application concerns.

**It does not manage database connections, encryption, or extension loading.** The caller owns the connection fully.

**It does not implement approval workflows, pending/draft states, or access control.** These are application concerns. Callers may use the `confidence` field, custom validators, or namespace separation to model these concepts.

**It does not implement any domain-specific logic.** Type values, entity classifications, link taxonomies, and position semantics are defined entirely by the caller.

---

## Future Design Considerations

The following are significant open questions deferred from v0.1. They are noted here because they may have architectural implications for future versions and should not be resolved casually.

- **Namespace isolation guarantees.** The library enforces namespace isolation in queries but does not prevent a caller from writing cross-namespace links. Whether cross-namespace links should be explicitly supported (with defined semantics), silently permitted (current behavior), or actively rejected is an unresolved design question. Resolution may affect the schema and the link write API.

- **FTS5 rebuild after tokenizer change.** The migration path for changing the FTS5 tokenizer after data exists is destructive — the virtual table must be dropped and rebuilt. A managed rebuild utility would reduce the operational risk for callers who discover post-deployment that their domain requires a different tokenizer. Not addressed in v0.1 because the right tokenizer should be chosen at init time.

- **`findPath()` performance at scale.** The default CTE graph adapter’s path-finding implementation may perform poorly for dense graphs or large namespaces. Behavior at scale is uncharacterized. Callers with large graphs should implement a custom `GraphQueryAdapter` backed by a graph-native query engine. This is a known limitation of the default implementation, not of the extension interface.
---

*Specification v0.1 — MIT license intent. General-purpose library; no domain-specific logic.*
