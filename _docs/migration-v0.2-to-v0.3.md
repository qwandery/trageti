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
- const results = store.retrieve({...})
+ const store = new TemporalStore(db, { namespace: 'rag', embeddingDimension: 768 })
+ await store.init()
+ await store.writeEpisode({...})
+ const results = await store.retrieve({...})
```

Tests that used `expect(() => store.fn(...)).toThrow(Err)` must become
`await expect(store.fn(...)).rejects.toThrow(Err)`.

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
const store = await TemporalStore.create({ database: db, namespace: 'rag', embeddingDimension: 768 })
// `db` is yours; close it yourself when ready. Pass closeDatabaseOnStoreClose: true
// to delegate that responsibility to the store.
```

The constructor + `init()` path remains supported for advanced callers.

## Retrieval: strategy routing and query-text escaping

```diff
- const results = await store.retrieve({
-   namespace: 'rag',
-   queryEmbedding: vec,
-   queryText: 'merger antitrust',
-   temporalAnchor: 12,
- })
+ const results = await store.retrieve({
+   namespace: 'rag',
+   queryEmbedding: vec,
+   queryText: 'merger antitrust',
+   temporalAnchor: 12,
+   // retrievalStrategy: 'hybrid', // default
+   // queryTextMode:    'phrase',  // default — escapes FTS5 operators
+ })
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
await store.retrieve({ namespace: 'logs', queryText: 'foo', temporalAnchor: 1, retrievalStrategy: 'bm25' })
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
and `RawVectorProvider` (for callers that already have embeddings). Real
provider adapters (Ollama, Transformers.js, OpenAI) live in a separate
`trageti-providers` workspace and are not part of v0.3's stable public
contract.

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
`trl_fts_meta` table to track the active tokenizer. The runner verifies
referential integrity (`PRAGMA foreign_key_check`) before committing.

## Removed / deprecated

- `RetrievalQuery.queryEmbedding` was required; it is now optional.
- The implicit "sqlite-vec must be loaded" precondition is gone. Calls
  that actually touch vec0 still throw `MissingPeerDependencyError` if it
  is missing.
- `DELETE_NAMESPACE_HAS_REFERENCES` log code is retired (deleteNamespace
  still warns under that code in the back-compat path; in a future
  release the cascade option becomes mandatory and the warning is
  replaced by `ReferencedExtensionTableError`).
