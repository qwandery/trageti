# trageti

Temporally-aware retrieval-augmented generation over SQLite.

`trageti` stores, indexes, and retrieves *episodic assertions* — discrete, typed claims with explicit validity windows — with retrieval that respects temporal position as a first-class constraint alongside semantic similarity and full-text matching.

## Features

- **Temporal validity windows** — every assertion carries `validFrom` / `validUntil` positions; retrieval only returns claims that were current at the requested anchor
- **Hybrid retrieval** — semantic (cosine via sqlite-vec) + BM25 full-text + recency, combined by a pluggable scorer
- **Supersession chains** — update a claim by superseding it; history is preserved and queryable
- **Graph traversal** — follow typed links between assertions with depth limits and temporal filtering
- **Namespace isolation** — separate embedding tables per namespace, full data isolation
- **Schema extensions** — add custom columns or tables while keeping migration safety
- **Pluggable everything** — swap out the scorer, formatter, graph adapter, validator, or middleware

## Installation

```bash
npm install trageti better-sqlite3
npm install sqlite-vec
```

`sqlite-vec` must be loaded into the database connection before creating a `TemporalStore`.

**Platform notes for sqlite-vec:**
- Node.js >= 18 required
- Pre-built binaries ship for Linux x64, macOS (arm64 + x64), and Windows x64
- For other platforms, see the [sqlite-vec documentation](https://alexgarcia.xyz/sqlite-vec)

## Quick start

```typescript
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { TemporalStore } from 'trageti'

const db = new Database('my-store.db')
sqliteVec.load(db)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('temp_store = MEMORY')  // keeps query intermediates in memory

const store = new TemporalStore(db, {
  namespace: 'my-namespace',
  embeddingDimension: 1536,
})
store.init()

// Write an episode (provenance anchor)
store.writeEpisode({
  id: 'ep-1',
  namespace: 'my-namespace',
  position: 1,
  occurredAt: new Date().toISOString(),
  type: 'document',
  content: 'Source document excerpt...',
})

// Write an assertion derived from the episode.
// v0.2: every assertion must carry at least one citation.
store.writeAssertion({
  id: 'a-1',
  namespace: 'my-namespace',
  type: 'fact',
  content: 'The system uses SQLite for storage.',
  validFrom: 1,
  validUntil: null,
  confidence: 0.95,
  sourceEpisodeId: 'ep-1',
  supersedesId: null,
  entityId: null,
  entityType: null,
  citations: [
    {
      id: 'cit-1',
      episodeId: 'ep-1',
      sourceRef: 'chunk:1',
      excerpt: 'Source document excerpt mentioning SQLite for storage...',
    },
  ],
})

// Index with your embedding model
const embedding = await myEmbeddingModel.embed('The system uses SQLite for storage.')
store.indexAssertion('a-1', embedding)

// Retrieve — only returns assertions valid at temporalAnchor
const results = store.retrieve({
  namespace: 'my-namespace',
  queryEmbedding: embedding,
  temporalAnchor: 1,
  limit: 10,
})
```

## Connection configuration

Configure the connection before passing it to `TemporalStore`:

```typescript
db.pragma('journal_mode = WAL')       // recommended for concurrent reads
db.pragma('foreign_keys = ON')        // enforces referential integrity
db.pragma('temp_store = MEMORY')      // keeps query intermediates in memory
```

`trageti` does not manage the database connection. Extension loading, PRAGMA configuration, and connection lifecycle are the caller's responsibility.

## Core concepts

### Episodes

An `Episode` is a provenance anchor — a timestamped record that a piece of information was observed at a given `position` in the timeline. All assertions reference a source episode.

### Assertions

An `Assertion` is a discrete claim. Key fields:
- `validFrom` — the position at which this claim became current
- `validUntil` — the position at which it was superseded (null = still current)
- `confidence` — 0–1 reliability weight
- `entityId` / `entityType` — optional entity tagging for grouped queries

### Positions

`position` is a monotonically increasing numeric value (float). All temporal operations work relative to a `temporalAnchor` that you supply at query time. A position could represent document sequence number, timestamp, turn number, version, or any other ordinal.

### Supersession

When a claim changes, write the new assertion and call `supersedeAssertion` on the old one:

```typescript
store.writeAssertion({ id: 'a-2', ..., validFrom: 5, supersedesId: 'a-1' })
store.supersedeAssertion('a-1', { validUntil: 5, replacedById: 'a-2' })
```

The old assertion's `validUntil` is set; queries at `validAt < 5` still see it, queries at `validAt >= 5` do not.

## Retrieval

```typescript
const results = store.retrieve({
  namespace: 'my-namespace',
  queryEmbedding: embedding,        // required
  queryText: 'storage solution',    // optional — enables BM25 scoring
  temporalAnchor: 10,
  limit: 20,
  minConfidence: 0.7,               // optional filter
  entityTypes: ['concept'],         // optional filter
  expandLinks: true,                // attach graph neighbours
  maxDepth: 2,
  mode: 'snapshot',                 // or 'trajectory' — see below
})
```

Each result includes `score` and `scoreComponents` (semanticDistance, bm25Score, position).

### Trajectory mode

`mode: 'trajectory'` adds the supersession history of each result:

```typescript
const results = store.retrieve({
  namespace: 'my-namespace',
  queryEmbedding: embedding,
  temporalAnchor: 10,
  mode: 'trajectory',
})

for (const r of results) {
  // r.supersessionChain is always present in trajectory mode.
  // It contains all *prior* versions of r in chronological order
  // (oldest first), each with its own citations. Empty array means
  // r has no predecessors. The property is absent in snapshot mode.
  console.log(r.supersessionChain.map((a) => a.id))
}
```

Trajectory mode follows `supersedes_id` chains only — it does **not**
traverse `trl_links`. For accumulation/layering relationships use
`expandLinks: true` together with `getEntityHistory()`.

Quick reference for the four "history-shaped" calls:

- `mode: 'trajectory'` — replacement history of *retrieved* results.
- `expandLinks: true` — assertions related to a result via `trl_links`.
- `getEntityHistory(ns, entityId)` — every assertion ever written for an entity.
- `getEntityTrajectory(ns, entityId)` — supersession chain(s) for an entity (replacement only — does not include `deepens` / `contextualizes` link targets).

### Choosing supersession vs links

When new information arrives about an entity, decide first whether it
*replaces* an earlier assertion or *layers on top of* it:

- **Replacement** — a relationship status flips, a goal is met, a contact
  arrangement ends. Write the new assertion with `supersedesId: <prior>` and
  `validFrom: <new position>`. The library atomically closes the predecessor's
  `valid_until = new.validFrom` in the same transaction. The predecessor
  immediately drops out of snapshot retrieval.
- **Accumulation** — a theme deepens, a contradictory belief coexists, a new
  measurement extends a series. Write the new assertion with
  `supersedesId: null`. Both assertions remain valid. Connect them with
  `writeLink({ linkType: 'deepens' | 'qualifies' | 'contextualizes' | 'contradicts' | 'measures' })`.

```typescript
// Layering: connect related assertions without superseding
store.writeLink({
  id: 'l-1',
  namespace: 'my-namespace',
  fromId: 'a-2',          // the new, deeper observation
  toId: 'a-1',            // the earlier observation it deepens
  linkType: 'deepens',
  validFrom: 11,
  validUntil: null,
  sourceEpisodeId: 'ep-11',
})
```

Setting `supersedesId` is a strong replacement signal — when in doubt, prefer
`writeLink` and keep both assertions valid.

## Citations

Every assertion must carry at least one citation. Citations are the source
references that make retrieval results traceable. The full `AssertionCitation`
shape is defined in [_docs/specs/trageti-spec-v0.2.md](_docs/specs/trageti-spec-v0.2.md).

```typescript
store.writeAssertion({
  id: 'a-1',
  // ...other fields...
  citations: [
    {
      id: 'cit-1',
      episodeId: 'ep-1',
      sourceRef: 'chunk:3',                  // caller-defined; opaque to library
      excerpt: 'verbatim source text',       // strongly recommended; null permitted
      excerptStart: '0:08:14',               // optional positional anchors
      excerptEnd: '0:08:51',
      metadata: { confidence: 0.95 },        // optional caller data
    },
  ],
})
```

If you discover a citation after the assertion has been written, add it via
`store.writeCitation({ ... })`. Citations on every read path (`getById`,
`getAssertions`, `retrieve`, `getEntityHistory`, etc.) are always populated for
v0.2-written assertions; assertions that pre-date v002 read with `citations: []`.

`null` excerpts are permitted but emit a `CITATION_EXCERPT_MISSING` warning at
write time. Replace the validator chain to suppress the warning if your domain
genuinely lacks verbatim excerpts.

## Context assembly

`assembleContext` runs `retrieve` and formats the results for inclusion in a prompt:

```typescript
const ctx = store.assembleContext({
  namespace: 'my-namespace',
  queryEmbedding: embedding,
  temporalAnchor: 10,
  tokenBudget: 4000,
  formatter: new JsonFormatter(),   // or ProseFormatter / StructuredFormatter
})
// ctx.text     — formatted string ready for prompt injection
// ctx.truncated — true if token budget was exceeded
// ctx.coverage  — { totalAssertions, includedAssertions, positionRange }
```

### Formatters

| Class | Output |
|---|---|
| `ProseFormatter` | Narrative text, one paragraph per assertion + provenance |
| `StructuredFormatter` | Grouped by entityType then position |
| `JsonFormatter` | JSON array of assertion objects |

## Graph traversal

```typescript
// Find assertions connected to a-1 within 2 hops
const connected = store.getConnected({
  namespace: 'my-namespace',
  fromAssertionId: 'a-1',
  maxDepth: 2,
  linkTypes: ['related', 'sequential'],  // optional filter
  temporalAnchor: 10,
})

// Find shortest path between two assertions
const path = store.findPath({
  namespace: 'my-namespace',
  fromAssertionId: 'a-1',
  toAssertionId: 'a-5',
  maxDepth: 5,
  temporalAnchor: 10,
})
```

Links carry their own `validFrom` / `validUntil` — expired links are automatically excluded.

## Temporal snapshots

Get all assertions valid at a specific past position:

```typescript
const snapshot = store.getTemporalSnapshot({
  namespace: 'my-namespace',
  atPosition: 5,
  assertionTypes: ['fact', 'update'],  // optional
  entityTypes: ['concept'],            // optional
})
```

## Schema extensions

Add custom columns or tables without breaking migrations:

```typescript
const store = new TemporalStore(db, {
  namespace: 'my-namespace',
  embeddingDimension: 1536,
  schemaExtensions: {
    columns: [
      { table: 'trl_assertions', column: 'source_url', definition: 'TEXT' },
    ],
    tables: [
      {
        tableName: 'my_custom_metadata',
        createSQL: `
          CREATE TABLE IF NOT EXISTS my_custom_metadata (
            assertion_id TEXT NOT NULL REFERENCES trl_assertions(id),
            tag          TEXT
          )
        `,
        referencesNamespace: false,
      },
    ],
  },
})
```

Extension column values appear on returned assertion objects under `assertion.extensions`.

Constraints:
- Column names must not shadow library columns
- Column names must not be SQLite reserved words
- Table names must not use the `trl_` prefix
- Extensions are applied idempotently on every `init()` call

## Middleware

```typescript
const loggingMiddleware: RetrievalMiddleware = {
  before: (query) => {
    console.log('retrieving at anchor', query.temporalAnchor)
    return query
  },
  after: (results) => {
    console.log('got', results.length, 'results')
    return results
  },
}

const store = new TemporalStore(db, {
  namespace: 'my-namespace',
  embeddingDimension: 1536,
  middleware: [loggingMiddleware],
})
```

Middleware runs: global `before` (registration order) → per-call `before` → retrieval core → per-call `after` (reverse) → global `after` (reverse).

## Custom scorer

```typescript
import type { RetrievalScorer, ScoredCandidate, ScoringContext } from 'trageti'

class MyScorer implements RetrievalScorer {
  score(candidate: ScoredCandidate, ctx: ScoringContext): number {
    // Weight purely by recency
    const range = ctx.namespacePositionRange.max - ctx.namespacePositionRange.min || 1
    return (candidate.position - ctx.namespacePositionRange.min) / range
  }
}

const store = new TemporalStore(db, {
  namespace: 'my-namespace',
  embeddingDimension: 1536,
  scorer: new MyScorer(),
})
```

### `scoreBatch` (optional)

For scorers that need cross-candidate normalisation, implement the optional
`scoreBatch` hook. The retrieval pipeline calls it instead of per-candidate
`score()` when present, and validates that the returned array length equals
the candidate count (otherwise throws):

```typescript
class BatchScorer implements RetrievalScorer {
  score(c: ScoredCandidate, ctx: ScoringContext): number {
    return 1 - c.semanticDistance
  }
  scoreBatch(candidates: ScoredCandidate[], ctx: ScoringContext): number[] {
    // ... cross-candidate normalisation here ...
    return candidates.map((c) => this.score(c, ctx))
  }
}
```

### Updating v0.1 custom scorers

v0.2 changed the BM25 contract: `ScoredCandidate.bm25Score` now carries the
**raw FTS5 BM25** value (negative; more-negative = better) instead of the
normalised `[0, 1]` value v0.1 supplied. Scorers that consumed the previous
normalised value must be updated:

```typescript
// v0.1 (pre-normalised, higher = better):
const keywordSignal = candidate.bm25Score ?? 0

// v0.2 (raw FTS5, negative; more-negative = better):
// Per-candidate compression — works without cross-candidate context:
const raw = candidate.bm25Score
const keywordSignal = raw === null ? 0 : 1 / (1 + Math.abs(raw))
// For cross-candidate min-max normalisation, implement scoreBatch.
```

`DefaultScorer.scoreBatch` is a worked reference implementation.

## Migrations

`trageti` manages its own schema via an internal migration runner. The schema version is stored in `trl_schema_version`. Migrations are applied automatically on `init()` and are idempotent.

```typescript
const version = store.getCurrentSchemaVersion()  // 2 after first init (v0.2)
```

## Reindexing

When changing embedding dimensions, call `reindexNamespace`. This drops and recreates the embedding table then re-embeds all assertions:

```typescript
await store.reindexNamespace('my-namespace', {
  newDimension: 3072,
  embeddingProvider: async (id, content) => myModel.embed(content),
})
```

**Note:** Reindexing is not atomic. If the embedding provider throws mid-run, the embedding table will be empty. Resume by calling `reindexNamespace` again — all assertions will be pending. Use `getPendingIndexing` to check state at any time:

```typescript
const pending = store.getPendingIndexing('my-namespace')
// [{ id: 'a-1', content: '...' }, ...]
```

## Multiple namespaces

A single database can host multiple namespaces, each with isolated data and its own embedding table:

```typescript
store.init()                          // initialises the default namespace
store.initNamespace('team-b', { embeddingDimension: 768 })
```

## Known limitations

- **Single-process writes** — no multi-writer coordination. If multiple processes write to the same database concurrently, use an external lock or connection pool with serialised writes.
- **Graph traversal at scale** — the default `CTEGraphAdapter` uses recursive CTEs which can be slow on dense graphs. Implement a custom `GraphQueryAdapter` for large-scale graph workloads.
- **`findPath` finds one path** — the current implementation returns the first shortest path found by BFS. It does not enumerate all paths.
- **Reindexing is not atomic** — see the Reindexing section above.
- **FTS5 tokenizer is set once** — the tokenizer configuration is embedded in the migration. Changing it on a subsequent `init()` emits a warning but does not rebuild the index.

## License

MIT
