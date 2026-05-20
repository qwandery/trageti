# Migrating from trageti v0.2 to v0.3

v0.3 is a substantial API redesign. The biggest changes affect every caller:
the public surface is uniformly async, the retrieval signature has a strategy
field and an envelope-style result, namespaces can be vectorless, and there
is a real lifecycle (`create()` / `close()`) with ownership semantics.

The migration is mechanical for most call sites. This guide covers the
changes you have to make and the new affordances you can opt into.

## Required: every call site adds `await`

All `TemporalStore` methods now return `Promise`.

```diff
- const store = new TemporalStore(db, { namespace: 'rag', embeddingDimension: 768 })
- store.init()
- store.writeEpisode({...})
- const results = store.retrieve({...})            // v0.2: bare array
+ const store = new TemporalStore(db, { namespace: 'rag', embeddingDimension: 768 })
+ await store.init()
+ await store.writeEpisode({...})
+ const { results, meta } = await store.retrieve({...})   // v0.3: envelope
```

Tests that used `expect(() => store.fn(...)).toThrow(Err)` must become
`await expect(store.fn(...)).rejects.toThrow(Err)`.

## Required: `retrieve()` returns an envelope, not a bare array

In v0.2, `retrieve()` returned `RetrievedAssertion[]`. In v0.3 it returns a
`RetrievalResult` — `{ results, meta }`. Destructure it:

```diff
- const results = await store.retrieve({ ... })
- for (const r of results) { ... }
+ const { results, meta } = await store.retrieve({ ... })
+ for (const r of results) { ... }
+ console.log(meta.retrievalStrategy, meta.candidateCount, meta.tookMs)
```

`meta` carries `namespace`, `temporalAnchor`, `limit`, `candidateCount`,
`retrievalStrategy`, `vectorApplied`, `bm25Applied`, `queryTextMode`,
`tookMs`, and `warnings`.

## Recommended: switch to `TemporalStore.create()`

```diff
- const db = new Database('rag.db')
- sqliteVec.load(db)
- db.pragma('journal_mode = WAL')
- const store = new TemporalStore(db, { namespace: 'rag', embeddingDimension: 768 })
- await store.init()
+ const store = await TemporalStore.create({
+   database: 'rag.db',
+   namespace: 'rag',
+   embeddingDimension: 768,
+ })
+ // …later:
+ await store.close()
```

`create()` opens the database, applies the v0.3 default pragmas (WAL,
`busy_timeout = 5000`, `temp_store = MEMORY`), loads `sqlite-vec`, and
runs `init()`. Because the store opened the handle, `close()` closes it.

If you already manage a `Database` instance, pass it directly:

```typescript
const db = new Database('rag.db')
const store = await TemporalStore.create({
  database: db,
  namespace: 'rag',
  embeddingDimension: 768,
})
// `db` is yours; close it yourself when ready. Pass closeDatabaseOnStoreClose: true
// to delegate that responsibility to the store.
```

The constructor + `init()` path remains supported for advanced callers.

## Retrieval: strategy routing and query-text escaping

```typescript
const { results, meta } = await store.retrieve({
  namespace: 'rag',
  queryEmbedding: vec,
  queryText: 'merger antitrust',
  temporalAnchor: 12,
  // retrievalStrategy: 'hybrid', // default — 'hybrid' | 'vector' | 'bm25'
  // queryTextMode:    'phrase',  // default — escapes FTS5 operators
})
```

- `retrievalStrategy: 'vector'` skips BM25; `queryEmbedding` is required.
- `retrievalStrategy: 'bm25'` skips vector; `queryText` is required.
- `retrievalStrategy: 'hybrid'` (default) uses whatever inputs are present.
- `queryTextMode: 'phrase'` (default) wraps user input as a literal FTS5
  phrase. To preserve the old v0.2 raw-operator behavior pass
  `queryTextMode: 'fts5'`.

`ScoredCandidate.semanticDistance` is now `number | null` (null when the
candidate came from a BM25-only branch). `bm25Score` is `null` when the
candidate came from a vector-only branch. Custom scorers that consumed both
fields should handle the null cases or implement `scoreBatch` for
cross-candidate normalization.

## Vectorless namespaces

Omit `embeddingDimension` to register a namespace that supports BM25-only
retrieval without `sqlite-vec`:

```typescript
const store = await TemporalStore.create({
  database: 'rag.db',
  namespace: 'logs',
  // no embeddingDimension → vectorless
})
await store.retrieve({
  namespace: 'logs',
  queryText: 'foo',
  temporalAnchor: 1,
  retrievalStrategy: 'bm25',
})
```

Calling `indexAssertion` / `indexBatch` / vector-only retrieval on a
vectorless namespace throws `IndexingError(INDEXING_NAMESPACE_VECTORLESS)`
or `RetrievalInputError(RETRIEVAL_NAMESPACE_VECTORLESS)`. To add vectors
later:

```typescript
await store.upgradeNamespaceToVector('logs', { embeddingDimension: 768 })
```

## Embedding providers

`EmbeddingProvider` is the new contract for deriving embeddings:

```typescript
interface EmbeddingProvider {
  readonly name: string
  readonly dimension: number
  embed(texts: readonly string[], options?: EmbedOptions): Promise<Float32Array[]>
}
```

Core ships `MockEmbeddingProvider` (deterministic hashing; tests/quickstarts
only — emits `TRGT_MOCK_PROVIDER_NON_PRODUCTION` outside `NODE_ENV=test`)
and `RawVectorProvider` (for callers that already have embeddings). Adapters
for real embedding services (Ollama, Transformers.js, OpenAI) are not part
of v0.3's stable public contract — implement the `EmbeddingProvider`
interface directly against whichever service you use.

`indexBatch` now returns `{ indexed: number, skipped: Array<{ assertionId,
reason, errorCode? }> }`. Unknown IDs land in `skipped[]` with
`errorCode: 'ASSERTION_NOT_FOUND'`; under `onProviderError: 'skip'`,
provider failures land in `skipped[]` with a sanitized stable code.

## Logger and metrics

Pass a `Logger` to capture structured records:

```typescript
const store = await TemporalStore.create({
  database: 'rag.db',
  namespace: 'rag',
  embeddingDimension: 768,
  logger: {
    debug: () => {},
    info: (code, fields) => observability.info(code, fields),
    warn: (code, fields) => observability.warn(code, fields),
    error: (code, fields) => observability.error(code, fields),
  },
})
```

Default is `ConsoleLogger` (warn/error to stderr). Pass `NoopLogger` to
silence the library in tests.

Pass a `Metrics` sink for counters and observations. **There is no default
implementation** — emission is a guarded no-op when `metrics` is unset.

## Error codes

Every library-thrown error now carries a stable `.code`. Match on
`ErrorCode.*` instead of message strings:

```typescript
try {
  await store.indexAssertion(id)
} catch (err) {
  if (err instanceof IndexingError && err.code === ErrorCode.INDEXING_ASSERTION_NOT_FOUND) {
    // queue for re-ingestion
  } else {
    throw err
  }
}
```

## Schema migration

Existing v0.2 databases upgrade automatically the first time you call
`init()` (or `create()`). Migration v003 rebuilds `trl_namespaces` with
nullable embedding columns under an FK-toggle transaction and adds a new
`trl_fts_meta` table to track the active tokenizer. Migration v004 backfills
`created_at` columns to canonical ISO-8601. Migration v005 then renames every
library table from the `trl_` prefix to `trageti_` (core tables,
`trageti_fulltext`, `trageti_tokenizer`, indexes, and per-namespace
`trageti_embeddings_<hash>` vec0 tables); the schema-version table is renamed
by the runner itself. The runner verifies referential integrity
(`PRAGMA foreign_key_check`) before committing each FK-toggle migration.

After the upgrade, code that reads library tables directly (custom
`ConnectionVerifier`s, raw SQL, `ColumnExtension.table`) must use the
`trageti_` names — see the v0.3 Specification Amendment for the full map.

## Removed / deprecated

- `RetrievalQuery.queryEmbedding` was required; it is now optional —
  supply `queryText`, `queryEmbedding`, or both, and select behavior with
  `retrievalStrategy`.
- The implicit "sqlite-vec must be loaded" precondition is gone. `sqlite-vec`
  is an optional peer dependency; calls that actually touch vector storage
  throw `MissingPeerDependencyError` if it is missing.
- `supersedeAssertion()` is removed from the primary API. Replace an
  assertion by writing its successor with `writeAssertion({ supersedesId })`
  (atomic). For the rare no-replacement close, use
  `store.advanced.closeAssertion(id, { validUntil })`.
- `retrieve()` no longer returns a bare array — it returns the
  `{ results, meta }` envelope (see above).
