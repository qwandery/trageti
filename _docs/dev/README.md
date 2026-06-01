# Developer Guide

This guide is for engineers working **on** trageti — extending the library, fixing bugs, writing tests, cutting releases. For consumer-facing API documentation, see the top-level [README](../../README.md). For the behavioural contract, see [`_docs/specs/trageti-spec-v0.3.md`](../specs/trageti-spec-v0.3.md).

---

## Table of contents

1. [Quick start](#quick-start)
2. [Project layout](#project-layout)
3. [Architectural overview](#architectural-overview)
4. [Critical invariants](#critical-invariants)
5. [Error codes and log codes](#error-codes-and-log-codes)
6. [Tooling](#tooling)
7. [Local development workflow](#local-development-workflow)
8. [Testing](#testing)
9. [Linting, formatting, typechecking](#linting-formatting-typechecking)
10. [Building](#building)
11. [Adding features](#adding-features)
12. [Database migrations](#database-migrations)
13. [Production-integration guidance](#production-integration-guidance)
14. [Versioning and releases](#versioning-and-releases)
15. [Publishing](#publishing)
16. [Debugging](#debugging)
17. [Performance considerations](#performance-considerations)

---

## Quick start

```bash
git clone https://github.com/qwandery/trageti.git
cd trageti
npm install
npm run typecheck
npm test
npm run build
```

Requirements:

- **Node.js >= 18** (the package targets Node 18; the CI matrix runs 18 / 20 / 22)
- **npm** (used for lockfile + scripts; pnpm/yarn untested)
- A C++ toolchain for `better-sqlite3` native compilation (already on most dev machines; on Windows install Visual Studio Build Tools, on Linux install `build-essential`, on macOS the Xcode CLI tools)
- `sqlite-vec` is an **optional** peer dependency. It is installed as a dev dependency so the integration suite can exercise the vector path. The library runs BM25-only without it.

---

## Project layout

```text
trageti/
├── src/
│   ├── index.ts                Top-level barrel — every public name listed here
│   ├── store/
│   │   └── TemporalStore.ts    Public facade. Thin orchestration; no SQL inline
│   ├── domain/
│   │   ├── types.ts            ALL interfaces (domain + contracts) live here
│   │   └── vocabulary.ts       Frozen recommended assertion / link types
│   ├── defaults/               Default implementations of the contracts
│   │   ├── connection/         DefaultConnectionVerifier + prepareDatabase
│   │   ├── formatting/         Prose / Structured / Json formatters
│   │   ├── graph/              CTEGraphAdapter (recursive CTE BFS, cycle-safe)
│   │   ├── providers/          MockEmbeddingProvider, RawVectorProvider
│   │   ├── scoring/            DefaultScorer (semantic 0.6 / bm25 0.3 / recency 0.1)
│   │   └── validation/         DefaultAssertionValidator
│   ├── db/                     Everything that touches the Database object
│   │   ├── candidates.ts       buildCandidateJson — JSON-serialised id list
│   │   ├── migrations/         Code-registered Migration[] + runner
│   │   │   ├── v001_baseline.ts    v0.3 steady-state baseline schema
│   │   │   ├── index.ts            Ordered migration list (version === index + 1)
│   │   │   └── runner.ts           MigrationRunner - baseline bootstrap
│   │   ├── repositories/       Thin DAOs; one per top-level table
│   │   │   ├── AssertionRepository.ts
│   │   │   ├── CitationRepository.ts
│   │   │   ├── EpisodeRepository.ts
│   │   │   ├── LinkRepository.ts
│   │   │   ├── EmbeddingRepository.ts
│   │   │   └── NamespaceRepository.ts
│   │   └── schema/             columns / extensions
│   ├── pipeline/               Retrieval orchestration; no inline SQL outside retrieve
│   │   ├── retrieve.ts         Multi-step retrieval → RetrievalResult envelope
│   │   ├── assemble.ts         retrieve + format + coverage block
│   │   ├── snapshot.ts         Pure temporal filter
│   │   ├── graph.ts            getConnected / findPath wrappers
│   │   ├── middleware.ts       before/after composition over RetrievalResult
│   │   └── reindex.ts          Staging-swap vec0 rebuild; stream re-embed
│   ├── errors/
│   │   └── index.ts            TragetiError + typed subclasses; ErrorCode enum
│   └── internal/               NOT exported from src/index.ts (except Logger types)
│       ├── hash.ts             namespaceToEmbeddingTable (SHA-256 → 16 hex)
│       ├── logger.ts           Logger / Metrics contracts + Console/Noop impls
│       ├── retrieval-defaults.ts  Named retrieval / assembly / graph defaults
│       ├── sql-ident.ts        quoteIdent for safe DDL interpolation
│       └── tokenizer.ts        validateTokenizer — FTS5 tokenizer allow-list
├── test/
│   ├── unit/                   No DB; vitest projects → fast, deterministic
│   ├── integration/            Requires better-sqlite3 (+ sqlite-vec for vector)
│   ├── helpers/openTestDb.ts   :memory: + sqliteVec.load + WAL + FK
│   └── fixtures/scenario.ts    Reusable domain-neutral scenario graph
├── _docs/dev/                  This file
├── _docs/specs/                trageti-spec-v0.3.md (current) + v0.1/v0.2 (historical)
├── .changeset/                 Changeset config (see Versioning)
├── .github/workflows/          ci.yml + publish.yml
├── dist/                       Build output (gitignored)
├── eslint.config.js            Flat ESLint config; @typescript-eslint/strict-type-checked
├── tsconfig.json               Strict; rootDir=src; excludes test
├── tsconfig.test.json          Extends; includes src + test for tsc --noEmit
├── tsconfig.eslint.json        Extends; includes src + test for ESLint type service
├── tsup.config.ts              Dual ESM+CJS; dts; better-sqlite3 externalised
├── vitest.config.ts            Single fork (SQLite determinism); v8 coverage
└── package.json                exports map: ESM types-first; CJS via .d.cts
```

### Layering rules

```text
domain  ←  defaults  ←  pipeline  ←  store
              ↑           ↑
              └── errors ─┘
              ↑
db  ←  pipeline / store / defaults
internal ← (anything; only Logger/Metrics types are re-exported)
```

- `domain/types.ts` is the only file that defines interfaces — domain types **and** the extension-point contracts (`GraphQueryAdapter`, `RetrievalScorer`, `ContextFormatter`, `AssertionValidator`, `ConnectionVerifier`, `RetrievalMiddleware`, `EmbeddingProvider`). There is no separate `contracts/` directory; the v0.2-era re-export barrels were removed in v0.3 as dead code.
- `db/` is the only directory that touches the `Database` object directly.
- `pipeline/` orchestrates repositories and contracts. `retrieve.ts` owns the retrieval SQL; other pipeline files delegate to repositories.
- `internal/` is implementation detail. Only the `Logger` / `Metrics` / `LogFields` **types** are re-exported from `src/index.ts` (consumers must be able to type a custom logger). The runtime helpers in `internal/` are private.

---

## Architectural overview

### Lifecycle: `create()` / `close()`

v0.3 has a uniform async lifecycle. The recommended entry point is the static factory:

```typescript
const store = await TemporalStore.create({
  database: '/path/to/data.db', // path string, or a better-sqlite3 Database
  namespace: 'default',
  embeddingDimension: 768, // omit / null → vectorless namespace
  embeddingProvider, // optional
});
// ... use the store ...
await store.close();
```

`create()` opens (or accepts) the database via `prepareDatabase()`, constructs the store, and runs `init()`. `init()` runs in this order:

1. **Connection verification** — `ConnectionVerifier.verify(db)`. The default verifier **fails closed**: it sets `PRAGMA foreign_keys = ON`, re-reads it, and throws `ConnectionVerificationError` if FK enforcement is unavailable. On success it emits `TRGT_FOREIGN_KEYS_ENABLED` at debug level.
2. **Migrations** — `MigrationRunner.applyMigrations(db)` brings the schema to the current version (idempotent).
3. **Schema extensions** — `SchemaExtensionApplier` validates user-supplied extensions then applies them transactionally.
4. **Namespace registration** — upsert the configured namespace into `trageti_namespaces`.
5. **Extension-cache warm-up** — read `PRAGMA table_info` for every library table and cache user-extension columns. Repositories use this to populate the `extensions` bag on returned rows.

Direct construction (`new TemporalStore(db, options)` + `await store.init()`) still works and is what most integration tests use, but `create()` is the surface consumers should see. After `close()`, every public method throws `StoreClosedError` — guarded by `requireNotClosed()`.

### Uniform async API

Every public method returns a `Promise`, even where the underlying `better-sqlite3` work is synchronous. This is deliberate: it keeps the API stable if an async `EmbeddingProvider` is introduced on a path that is currently sync, and it lets `EmbeddingProvider.embed` (genuinely async) compose without a signature split. `TemporalStore.ts` carries a file-wide, documented `eslint-disable @typescript-eslint/require-await` for the methods that are async-by-contract but sync-by-implementation.

### Hybrid retrieval pipeline

`retrieve(query)` resolves to a `RetrievalResult` envelope — **not** a bare array:

```typescript
const { results, meta } = await store.retrieve({ queryText: '...', namespace: 'default' });
```

- `results: RetrievedAssertion[]` — the ranked hits.
- `meta: RetrievalMeta` — `namespace`, `temporalAnchor`, `limit`, `candidateCount`, `retrievalStrategy`, `vectorApplied`, `bm25Applied`, `queryTextMode`, `tookMs?`, `warnings`.

The pinned step order in `pipeline/retrieve.ts`:

```text
0. Query routing      TS:  resolve retrievalStrategy + query embedding.
                      ↳ hybrid: derive an embedding from queryText via the
                        namespace's EmbeddingProvider when no queryEmbedding
                        is supplied; fall back to BM25 with
                        TRGT_RETRIEVE_VECTOR_SKIPPED if the vector backend
                        is unavailable.
1. Temporal filter    SQL: namespace + temporal window + optional filters → [ids]
2. Vector scoring     SQL: vec_distance_cosine over candidate ids (json_each).
                      ↳ skipped for retrievalStrategy:'bm25' or vectorless ns.
3. FTS5 / BM25        SQL: trageti_fulltext MATCH …; raw BM25 score per candidate.
                      ↳ queryTextMode:'phrase' (default) quotes the query as a
                        single FTS5 phrase; 'fts5' passes raw FTS5 syntax — a
                        malformed expression → RETRIEVAL_INVALID_QUERY_TEXT.
4. Score              TS:  scorer.scoreBatch() — cross-candidate normalisation.
5. Rank + truncate    TS:  sort by the determinism tie-break; slice(limit).
                      ↳ the `rank` step is emitted here, before graph/trajectory.
6. Graph expand       SQL: recursive CTE through trageti_links at temporalAnchor.
7. Trajectory         SQL: recursive CTE through supersedes_id; oldest-first.
```

`retrievalStrategy` is `hybrid` (default), `vector`, or `bm25`. Each retrieval step can be observed via the `RetrievalDebug.onStep` hook; a throwing hook is caught and logged as `TRGT_RETRIEVAL_DEBUG_HOOK_ERROR` (the hook never breaks retrieval). The `RetrievalStep` emission order is `validate → temporal-filter → semantic → keyword → score → rank → graph-expand → trajectory-expand`: `rank` reports the truncated result set, so it precedes the expansion steps that only decorate those results. Numeric defaults (retrieval `limit` 10, candidate oversample ×3, `assembleContext` limit 100, graph depths 3/5) live as named constants in `src/internal/retrieval-defaults.ts`.

The funnel between SQL steps is `buildCandidateJson(ids)` — a JSON-serialised array bound as a single parameter, consumed via `json_each(?)`. This is the **only** mechanism for passing intermediate id sets between SQL stages. See [critical invariants](#critical-invariants).

### `explain()`

`store.explain(query)` returns a `RetrievalExplainResult` with a per-step `RetrievalExplainStep` (`step`, `sql`, `queryPlan`, `estimatedRows`, `vectorReady`) and routing flags (`wouldApplyVector` / `wouldApplyBm25`). It is **non-executing** — it runs `EXPLAIN QUERY PLAN`, never the queries themselves.

### Vectorless namespaces

A namespace registered with `embeddingDimension` of `null` / `0` / `undefined` is **vectorless**: both `embedding_dimension` and `embedding_table` are stored as `NULL`. Vectorless namespaces support BM25-only retrieval and never create a vec0 table. The schema `CHECK` forbids the partial state (dimension set, table name absent), so both columns are written atomically. A vector path on a vectorless namespace throws via the `ensureVectorReady` chokepoint. To add vectors later, call `upgradeNamespaceToVector()` — re-`initNamespace()` with a dimension is rejected with an actionable error pointing at that method.

### Embedding providers

`EmbeddingProvider` (`embed(texts, options?) → Promise<number[][]>`) is a contract. Providers are **process-local — never persisted**. The store keeps an in-process **namespace → provider registry**: a provider can be bound store-wide (the default) or per namespace at `create()` / `initNamespace()` / `upgradeNamespaceToVector()` time. Retrieval Step 0 and `explain()` consult this registry to resolve the right provider for the queried namespace. `RawVectorProvider` is a pass-through for callers that already hold embeddings; `MockEmbeddingProvider` (`new MockEmbeddingProvider({ dimension })`) is deterministic test scaffolding and emits a once-per-process non-production warning.

### Per-namespace embedding tables

Each vector namespace gets its own `vec0` virtual table named `trageti_embeddings_{16hex}`, where `16hex` is the first 16 hex characters of `SHA-256(utf8(namespace))`. Why per-namespace?

- **Dimension can vary** per namespace.
- **Reindex is isolated** — rebuilding one namespace's vec0 table doesn't disturb others.
- **Hash collision is detected** at namespace-registration time → `NamespaceHashCollisionError`.

Table-name resolution is **always** via the `trageti_namespaces.embedding_table` column — the single source of truth. After a staging-swap reindex the stored name deliberately diverges from the hash-derived name; no code may re-derive a table name from the namespace hash. `namespaceToEmbeddingTable()` is used only to seed a _fresh_ namespace's name.

### Staging-swap reindex

`reindexNamespace()` builds a brand-new vec0 table under a collision-safe staging name (`<base>_staging_<epochMillis>`), re-embeds into it, then **atomically repoints** `trageti_namespaces.embedding_table` to the staging table and drops the old one. The swap is a column `UPDATE` — never a vec0 virtual-table rename (vec0 rename support is version-dependent). On any failure the previous index is left fully intact (`ReindexError`). A leftover staging table from an interrupted run is detected and cleaned up with `TRGT_REINDEX_STAGING_LEFTOVER`.

### Citations

Every assertion has at least one citation. The `trageti_citations` table holds them; `CitationRepository` is the DAO. Reads batch-fetch citations via `json_each` against the candidate funnel, so common reads stay O(rows + 1 query). Citations are surfaced on every returned `Assertion` and `RetrievedAssertion`. Strict mode (`validation.requireCitationExcerpt`) upgrades a null excerpt from a `TRGT_CITATION_EXCERPT_MISSING` warning to a `ValidationError`.

### Replacement vs accumulation

`supersedes_id` represents _replacement only_ (strictly new → old). The single-call replacement pattern is `writeAssertion({ supersedesId })`, which atomically closes the predecessor's `valid_until` in the same transaction. For the no-replacement close (a data correction where nothing supersedes the row) use `store.advanced.closeAssertion(id, { validUntil })` — an escape hatch that emits `TRGT_DEPRECATED_USAGE` once per process. There is no top-level `supersedeAssertion` method in v0.3.

When a new assertion _layers on_ an earlier one without replacing it, use `writeLink` with an accumulation link type (`deepens`, `qualifies`, `contextualizes`, `contradicts`, `measures`) and leave both assertions valid. `getEntityTrajectory()` follows replacement only — it does NOT traverse `trageti_links`.

### FTS5 with external content

`trageti_fulltext` is an external-content FTS5 table backed by `trageti_assertions`. Three triggers (`trageti_fulltext_ai`, `trageti_fulltext_ad`, `trageti_fulltext_au`) keep it in sync. The tokenizer config is recorded in the **`trageti_tokenizer`** metadata table.

> **Naming note:** the active v0.3 baseline creates `trageti_tokenizer` directly. The earlier `trl_fts_config` / `trl_fts_meta` names are historical design lineage only.`r`n`r`n`rebuildFts()` rebuilds the index preserving the `rowid` invariant and round-trips the tokenizer config through `trageti_tokenizer`. Tokenizer values are validated against an allow-list (`unicode61` / `ascii` / `porter` / `trigram`) plus a safe-argument character class by `validateTokenizer()` — in the migration factory / runner and in `rebuildFts`, **before** any DDL string is built. A rejected tokenizer throws `MigrationCompatibilityError`.

**External-content FTS5 quirk:** these tables cannot reliably read `UNINDEXED` columns back via the table alias. `runStep3` in `pipeline/retrieve.ts` joins to `trageti_assertions` via `rowid` rather than reading `assertion_id` from `trageti_fulltext` directly. If you change this, run the full integration suite.

### Schema extensions

Users can add columns to library tables and additional tables of their own:

```typescript
await TemporalStore.create({
  database: ':memory:',
  namespace: 'x',
  embeddingDimension: 768,
  schemaExtensions: {
    columns: [{ table: 'trageti_assertions', columnName: 'source_url', columnDef: 'TEXT' }],
    tables: [{ tableName: 'meta', columns: ['k TEXT', 'v TEXT'], referencesNamespace: false }],
  },
});
```

Validation (in `SchemaExtensionApplier.validate`): column names must not shadow `LIBRARY_COLUMNS`, must not be SQLite reserved words; user table names must not start with the reserved library prefix. Application is wrapped in a single `db.transaction()` — all-or-nothing. Extension columns are surfaced on returned rows under `assertion.extensions[colName]`, cached at `init()` time.

### Logging and metrics

`Logger` and `Metrics` are contracts (`internal/logger.ts`). The store is constructed with a `Logger` (default `ConsoleLogger`; `NoopLogger` for silence) and threads that **store-scoped** instance everywhere — there is no process-global logging shim. `emitOnce` deduplicates once-per-process codes (e.g. `TRGT_DEPRECATED_USAGE`); `incr` / `observe` are guarded metric helpers. Metrics emitted: `trageti.retrieve.tookMs`, `trageti.retrieve.candidateCount`, `trageti.indexBatch.indexed`, `trageti.indexBatch.skipped`, `trageti.reindex.tookMs`, `trageti.embeddingProvider.failures`.

### Middleware composition

```text
global.before[0..n]  →  call.before[0..n]  →  retrieveCore  →  call.after[n..0]  →  global.after[n..0]
```

Implemented in `pipeline/middleware.ts:applyMiddleware`, threading the `RetrievalResult` envelope. Note the **reverse** order on `after` — the standard onion-layer idiom.

---

## Critical invariants

These rules are load-bearing. Breaking them breaks the security/correctness story silently.

### 1. Candidate funneling: `json_each` only

`buildCandidateJson(ids: readonly string[]) → string` is the **only** way candidate ID sets reach SQL. Never use `IN (?, ?, …)` parameter unrolling (slow + bind-limit risk), never create TEMP tables for funneling (can spill to disk), never inline ids into the SQL string (injection risk).

### 2. Log/error payloads carry no content

`Logger` methods and `LogFields` accept only primitive metadata (IDs, namespaces, types, counts, codes). Never log or put into an error message: assertion content, embeddings, query text, or raw provider error messages. `indexBatch`'s `skipped[].errorCode` is a short **sanitized** identifier — never the raw provider message.

### 3. `LIBRARY_COLUMNS` is canonical

`src/db/schema/columns.ts` lists every column the library owns. Used for extension shadow-detection and for filtering extension columns out of row mappers. If you add a column in a migration, add it to `LIBRARY_COLUMNS` in the same change.

### 4. Shipped migrations are immutable; new behaviour is a new migration

A numbered migration must NEVER drop a column/table or be edited after release. `v001`–`v004` bodies are frozen. New schema behaviour arrives as a new numbered migration. The runner asserts `migrations[i].version === i + 1` at startup.

### 5. `embedding_table` is the only table-name source of truth

No code derives a vec0 table name from the namespace hash at runtime. Always read `trageti_namespaces.embedding_table`. The hash function seeds a fresh name only; after a reindex swap the stored name diverges and that is correct.

### 6. The connection verifier fails closed on foreign keys

`DefaultConnectionVerifier` enables and re-checks `PRAGMA foreign_keys` and throws if enforcement is unavailable. It does **not** check encryption PRAGMAs, and it does **not** warn about a missing `sqlite-vec` — vectorless / BM25-only operation is fully supported. sqlite-vec absence surfaces only where it actually matters (`prepareDatabase`, `ensureVectorReady`, hybrid fallback).

### 7. Structural invariants live on `TemporalStore`, not the validator chain

Citation presence / sourceRef / episode-namespace and predecessor existence / namespace / ordering checks are enforced by `TemporalStore.writeAssertion()` itself (`enforceStructuralInvariants`, operating on `NormalizedNewAssertion`). Replacing the `validators` array does **not** bypass them. Configured validators run only after structural checks pass.

### 8. Public input is validated before SQLite execution

Every `retrieve` / context call fails fast, before any SQLite execution, with a typed error. `RetrievalInputError` codes: `RETRIEVAL_INPUT_EMPTY`, `RETRIEVAL_REQUIRES_QUERY_TEXT`, `RETRIEVAL_REQUIRES_VECTOR_INPUT`, `RETRIEVAL_INVALID_LIMIT`, `RETRIEVAL_INVALID_MAX_DEPTH`, `RETRIEVAL_DIMENSION_MISMATCH`, `RETRIEVAL_NAMESPACE_VECTORLESS`, `SCORER_INVALID_OUTPUT`.

### 9. Determinism tie-break

Ranked results are ordered `(score DESC, validFrom DESC, createdAt ASC, id ASC)`. `createdAt` must be canonical ISO-8601 (millisecond precision) for the lexicographic tie-break to hold — repositories generate `new Date().toISOString()` explicitly, and migration v004 backfills pre-existing rows.

### 10. `src/internal/` is private

Nothing in `src/internal/` is re-exported from `src/index.ts` except the `Logger` / `Metrics` / `LogFields` **types**. Treat any change to internal runtime APIs as an internal refactor.

> **Table naming:** every active library table uses the `trageti_` prefix and is created directly by the v0.3 baseline migration. `trl_` names are historical only and must not appear in active runtime SQL.`r`n`r`n---

## Error codes and log codes

### Error model

All errors extend `TragetiError`, which carries a stable `code` from the `ErrorCode` enum. Typed subclasses (exported from `src/index.ts`): `NamespaceNotInitializedError`, `NamespaceHashCollisionError`, `NamespaceDimensionMismatchError`, `SchemaExtensionError`, `ReferencedExtensionTableError`, `ValidationError`, `MigrationError`, `MigrationCompatibilityError`, `ConnectionVerificationError`, `StoreClosedError`, `IndexingError`, `RetrievalInputError`, `ReindexError`, `EmbeddingProviderError`, `MissingPeerDependencyError`.

When adding an error: add the code to `ErrorCode`, throw the most specific subclass, never embed content in the message (IDs / namespaces / types only), and add a test that asserts on `.code`.

### Log codes

Log codes are stable `TRGT_*` strings passed as the first argument to `Logger` methods. They are part of the observable contract — renaming one is a breaking change and must be reflected in `CHANGELOG.md`. Notable codes: `TRGT_FOREIGN_KEYS_ENABLED`, `TRGT_RETRIEVE_VECTOR_SKIPPED`, `TRGT_PENDING_INDEXING_VECTORLESS`, `TRGT_STATS_VEC_NOT_INTROSPECTED`, `TRGT_MIGRATION_TOKENIZER_INCOMPATIBLE`, `TRGT_RETRIEVAL_DEBUG_HOOK_ERROR`, `TRGT_DEPRECATED_USAGE`, `TRGT_REINDEX_STAGING_LEFTOVER`, `TRGT_CITATION_EXCERPT_MISSING`.

---

## Tooling

| Concern     | Tool                                                             | Why                                                                                                  |
| ----------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Build       | `tsup` (esbuild)                                                 | Zero-config dual ESM+CJS, dts generation, fast                                                       |
| Test runner | `vitest`                                                         | Native ESM, TS support, single-fork mode for SQLite determinism                                      |
| Lint        | `eslint` 9 flat config + `typescript-eslint` strict-type-checked | Catches type-unsafe patterns at static analysis time                                                 |
| Format      | `prettier`                                                       | Non-negotiable formatting; integrated via `eslint-config-prettier`                                   |
| Coverage    | `@vitest/coverage-v8`                                            | Native v8 coverage; thresholds enforced                                                              |
| Native dep  | `better-sqlite3` (peer) + `sqlite-vec` (optional peer; dev dep)  | better-sqlite3 is synchronous (matches our transactional model); sqlite-vec ships pre-built binaries |

### TypeScript configuration

Three tsconfig files:

- **`tsconfig.json`** — build and editor. `rootDir: "src"`, excludes `test/`. Strict plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`.
- **`tsconfig.test.json`** — extends the above; includes `src/` and `test/`. Used by `npm run typecheck`.
- **`tsconfig.eslint.json`** — extends; same includes plus root-level `*.ts` / `*.js`. Used by ESLint's type-aware rules.

If you add a new top-level directory that should be linted, add it to `tsconfig.eslint.json`'s `include`.

### Strict ESLint rules

`eslint.config.js` enables `tseslint.configs.strictTypeChecked` plus: `no-non-null-assertion` (must pair with a why-comment), `consistent-type-imports`, `no-explicit-any` and the `no-unsafe-*` family, `restrict-template-expressions` (allows numbers/booleans/nullish). Tests relax `no-unsafe-*`, `no-non-null-assertion`, `no-unnecessary-condition`, `no-confusing-void-expression`, `require-await`.

`TemporalStore.ts` carries a single documented file-wide `eslint-disable @typescript-eslint/require-await` — the uniform-async-API methods are async-by-contract, sync-by-implementation. Any other `eslint-disable` must be a single line paired with a why-comment.

---

## Local development workflow

```bash
# One-time
npm install

# Iterating
npm run test:watch          # live tests
npm run typecheck           # full type check (src + test)
npm run lint                # ESLint
npm run lint:fix            # ESLint with autofix
npm run format              # Prettier write
npm run format:check        # CI mirror

# Before pushing — the green-only gate
npm run lint && npm run format:check && npm run typecheck && npm run build && npm test
```

`prepublishOnly` runs `lint` + `typecheck` + `build` + `test:coverage`, so an accidental `npm publish` cannot ship code that fails the gate or the coverage thresholds.

---

## Testing

### Test taxonomy

| Tier        | Location                       | Command                    | DB                        | Speed    |
| ----------- | ------------------------------ | -------------------------- | ------------------------- | -------- |
| Unit        | `test/unit/`                   | `npm run test:unit`        | none                      | <1s      |
| Integration | `test/integration/`            | `npm run test:integration` | `:memory:` (+ sqlite-vec) | ~1s      |
| E2E         | `test/integration/e2e.test.ts` | part of integration        | `:memory:` / file-backed  | included |

Every bug fix gets a regression test in the integration suite — there is no separate regression tier.

### Single-fork pool

`vitest.config.ts` sets `pool: 'forks'`, `singleFork: true`. SQLite and better-sqlite3 are not safe across worker boundaries; a single process keeps the suite deterministic. Don't change this without testing on Windows + macOS + Linux.

### Fixtures

`test/helpers/openTestDb.ts` opens `:memory:`, loads sqlite-vec, sets WAL + foreign_keys + temp_store. `test/fixtures/scenario.ts` writes a reusable domain-neutral scenario graph (episodes, assertions including supersession chains, links of varied types). Reuse them; avoid duplicating fixtures.

### Test against the public surface

Prefer exercising the v0.3 primary surface — `TemporalStore.create()` / `prepareDatabase()` / `close()` — not just the low-level constructor. A test that only uses `new TemporalStore(db, …)` is not exercising the path consumers use.

### Coverage thresholds

`vitest.config.ts` enforces **95 / 95 / 95 / 85** (lines / functions / statements / branches). Run `npm run test:coverage` to print the table. Type-only modules (`domain/types.ts`, `index.ts`, `defaults/index.ts`) are excluded — no executable code.

### Adding a test

1. Pick the right tier — needs a DB? → integration.
2. Reuse `openTestDb` and the scenario fixture where possible.
3. `beforeEach` to recreate state; never share state across tests.
4. Assert on **observable behaviour**, not implementation details. For errors, assert on `.code`.

---

## Linting, formatting, typechecking

```bash
npm run lint               # exits 0 on clean
npm run typecheck          # tsc --noEmit on both src and test
npm run format:check       # prettier --check (CI uses this)
npm run format             # prettier --write
```

CI runs all four. A change that fails any of them is blocked. Always pair an `eslint-disable` with a why-comment; reviewers reject blanket disables.

---

## Building

```bash
npm run build
```

Outputs to `dist/`: `index.js` (ESM) + `index.cjs` (CJS), `index.d.ts` + `index.d.cts`, and source maps. Configured in `tsup.config.ts` — targets Node 18, `external: ['better-sqlite3']`, `dts: true`, cleans `dist/` first.

The `package.json#exports` map puts the `"types"` condition **first** within each branch (modern Node + TS resolution requirement). Don't reorder. `package.json#files` ships only `dist`, `README.md`, `LICENSE`, `CHANGELOG.md` — source does not ship to npm.

---

## Adding features

### Adding a public API method

1. Add the method to `TemporalStore` (likely delegating to a `pipeline/` function). Guard it with `requireNotClosed()`.
2. Add domain types to `src/domain/types.ts` for new option/result shapes.
3. Re-export new types from `src/index.ts`.
4. Write integration tests — happy path + at least one typed-error case.
5. Update [`_docs/specs/trageti-spec-v0.3.md`](../specs/trageti-spec-v0.3.md) if you change a contract, and the consumer README.

### Adding a contract / extension point

1. Define the interface in `src/domain/types.ts`.
2. Provide a default implementation in `src/defaults/{category}/MyDefault.ts`.
3. Wire it into `TemporalStoreOptions` / `CreateStoreOptions` and the constructor defaults.
4. Pass it down to the consuming pipeline function.
5. Unit-test the default; integration-test that an override works.

### Adding a default implementation variant

E.g. a new formatter: implement `ContextFormatter` in `src/defaults/formatting/`, set `metadata.formatter`, honour `tokenBudget` (`truncated: true` + `includedCount` when items are dropped), re-export from `src/index.ts`, and add to `test/unit/formatters.test.ts` + `test/integration/context-assembly.test.ts`.

---

## Database migrations

v0.3 is pre-beta and has a flattened migration model. Migrations are code-registered in `src/db/migrations/index.ts`; the active package currently ships one baseline migration at schema version `1`.

### The runner

`MigrationRunner` (`src/db/migrations/runner.ts`) owns the `trageti_schema_version` bootstrap table. On a fresh database it creates the baseline `trageti_` schema and records version `1`. There is no active legacy `trl_schema_version` copy-forward path and no FK-toggle migration choreography in the flattened v0.3 baseline.

### Current migration history

| Version | File               | Mode     | Purpose                                      |
| ------- | ------------------ | -------- | -------------------------------------------- |
| v001    | `v001_baseline.ts` | baseline | Steady-state v0.3 `trageti_` schema directly |

The former v001-v005 development chain was flattened before beta because there are no known v0.2 consumers. The captured steady-state fixture in `test/fixtures/schema-v001-v005-steady-state.ts` is retained to verify that the baseline creates the same durable schema objects.

### Adding a migration

```typescript
// src/db/migrations/v0NN_my_change.ts
import type { Database } from 'better-sqlite3';
import type { Migration } from '../../domain/types.js';

export function createV0NNMigration(): Migration {
  return {
    version: NN,
    name: 'v0NN_my_change',
    description: 'Add foo column to trageti_assertions',
    // requiresForeignKeyToggle: true,   // only if the body rewrites a table
    up(db: Database): void {
      db.exec(`ALTER TABLE trageti_assertions ADD COLUMN foo TEXT`);
    },
  };
}
```

Then: register it in `src/db/migrations/index.ts` (append; never reorder); add the column to `LIBRARY_COLUMNS` in `src/db/schema/columns.ts` in the same change; and add `test/integration/migrations.test.ts` coverage that a fresh DB ends at the new version and re-runs are idempotent.

### Migration constraints

- **Additive after beta.** The v0.3 baseline reset is the explicit pre-beta exception. After beta/release, do not drop columns/tables and do not edit shipped migration bodies.
- **No data dependency on user content.** A migration must succeed on every database regardless of row count.
- **Idempotent / safe to re-run.** Use `IF NOT EXISTS` where applicable and keep migration side effects deterministic.

---

## Production-integration guidance

trageti is a library, not a service. Consumers own the operational concerns below.

### Database lifecycle ownership

When you pass a path string to `create()`, the store opens the connection and `close()` closes it. When you pass an existing `Database`, the store uses it but does **not** own it — `close()` releases store state without closing a caller-supplied handle. Pick one model and be consistent; sharing one `Database` across multiple `TemporalStore` instances is supported but they then share schema and pragmas.

### Pragmas: WAL and busy-timeout

`prepareDatabase()` applies the recommended pragmas (WAL journal mode, foreign keys on, a temp store). For a file-backed multi-reader deployment, also set a `busy_timeout` so a transient writer lock retries instead of erroring immediately. SQLite supports many concurrent readers + one writer under WAL; trageti assumes **one writer at a time** — multi-process writes need external coordination (a lock file, an in-process queue). This is a deployment concern; the library does not enforce it.

### Embedding provider timeouts and cancellation

`EmbeddingProvider.embed` is genuinely async and may call a remote model. Give it its own timeout and respect the `signal` (`AbortSignal`) threaded through `RetrievalQuery` / `ReindexOptions` / `ContextAssemblyOptions`. A provider that throws is surfaced as `EmbeddingProviderError` (retrieval) or recorded in `indexBatch`'s `skipped[]` with a sanitized `errorCode` — never the raw provider message.

### Logging field-sensitivity

Inject a `Logger` that ships to your observability stack, but remember `LogFields` is primitives-only by contract: trageti never logs content, embeddings, or query text, and a custom logger must not be wired to add them. Wire the `Metrics` contract to your metrics backend to track `trageti.retrieve.tookMs`, `candidateCount`, `indexBatch.indexed`/`skipped`, `reindex.tookMs`, `embeddingProvider.failures`.

### Reindex operational impact

`reindexNamespace()` re-embeds every active assertion in the namespace — for a remote provider that is N model calls and can take real time. It is staging-swap safe (the live index serves queries until the atomic repoint), but it is I/O- and cost-heavy: schedule it off-peak, pass `batchSize` to bound memory, and pass a `signal` so it can be cancelled. An interrupted run leaves the old index intact and a staging table behind; the next run cleans it up (`TRGT_REINDEX_STAGING_LEFTOVER`).

---

## Versioning and releases

`package.json` is at `0.3.0`, set directly. [`CHANGELOG.md`](../../CHANGELOG.md) is the authoritative release record and is edited directly — log-code and contract changes must land there in the same change that makes them.

The `.changeset/` directory is configured, and Changesets is the intended mechanism for release-note-worthy changes, including pre-beta changes that alter public behavior. Keep changelog text aligned with the relevant changeset; do not rewrite already-published historical entries.

Pre-1.0 semver: breaking changes may ship as **minor** bumps; reserve a major bump for the 0→1 transition. Call out `BREAKING:` explicitly in the changelog entry regardless.

---

## Publishing

### Required GitHub secrets

| Secret         | Used by             | Notes                                                                       |
| -------------- | ------------------- | --------------------------------------------------------------------------- |
| `GITHUB_TOKEN` | `changesets/action` | Auto-provided by GitHub Actions                                             |
| `NPM_TOKEN`    | `npm publish`       | npm "Automation" token (no 2FA OTP). Repo → Secrets and variables → Actions |

### Automated publish

`publish.yml` runs on pushes to `main`: installs, builds, runs `changesets/action`, and on a merged "Version Packages" PR publishes to npm with `--provenance`. **Do not run `npm publish` from a laptop** — it bypasses provenance and CI gates.

### Manual fallback (only if the workflow is broken)

```bash
npm login
npm run build
npm publish --access public
```

### Verifying a release before publish

```bash
npm run build
npm pack --dry-run     # should list only dist/, README.md, LICENSE, CHANGELOG.md, package.json
```

Source files in the list mean `package.json#files` / `.npmignore` need fixing first.

### Local install testing

`npm pack` → `npm install /path/to/trageti-X.Y.Z.tgz` is the closest fidelity to a real publish (exercises `files` + `exports`). `npm link` is faster but quirky on Windows and with peer deps.

### Unpublishing

npm discourages unpublish. For a broken release: `npm deprecate trageti@X.Y.Z "…"` then ship a fix immediately.

---

## Debugging

### Inspect a specific test

```bash
npx vitest run test/integration/temporal-filter.test.ts
npx vitest run test/integration/temporal-filter.test.ts -t "validAt"
```

### Use `explain()`

`store.explain(query)` returns each step's SQL, `EXPLAIN QUERY PLAN` output, estimated rows, and `vectorReady` — without executing the retrieval. It is the first thing to reach for on a "why did this query do X" question.

### Inspect schema state mid-test

```typescript
console.log(db.prepare('SELECT name, sql FROM sqlite_master').all());
console.log(db.prepare('PRAGMA table_info(trageti_assertions)').all());
console.log(db.prepare('SELECT MAX(version) FROM trageti_schema_version').get());
```

### Reproducing a CI failure locally

CI runs Node 18/20/22 on Ubuntu. To match:

```bash
nvm use 18
npm ci
npm run format:check && npm run lint && npm run typecheck
npm run test:unit && npm run test:integration
npm run build
```

### Common issues

**`Error: vec_version is not a function`** → `openTestDb()` wasn't used, or sqlite-vec isn't installed. Vector-path tests need it; BM25-only tests don't.

**`SQLITE_ERROR: no such column: T.assertion_id`** → the FTS5 join workaround in `pipeline/retrieve.ts` was reverted. External-content FTS5 cannot read `UNINDEXED` columns via alias; join to `trageti_assertions` via rowid.

**`StoreClosedError`** → a method was called after `close()`. Each public method is `requireNotClosed()`-guarded.

**`ConnectionVerificationError`** → FK enforcement could not be enabled on the connection. The default verifier fails closed by design.

**`MigrationCompatibilityError`** → a tokenizer value failed the `validateTokenizer()` allow-list. Use `unicode61` / `ascii` / `porter` / `trigram` with safe arguments.

**`RetrievalInputError`** → a retrieve/context call had bad input (empty query, bad limit, dimension mismatch, vector path on a vectorless namespace, …). The `.code` says which.

**`citations: []` on every read** -> the database is not a v0.3 baseline database. Automatic v0.2 prototype migration is unsupported; rebuild from source data.`r`n
**Lint: "parserOptions.project was not found"** → the file isn't in `tsconfig.eslint.json`'s `include`. Add it.

---

## Performance considerations

### `findPath` is bounded by depth and returns one winning path`r`n`r`n`CTEGraphAdapter.findPath` uses a recursive CTE with cycle protection and SQL ordering/`LIMIT 1` to return one deterministic shortest path. Dense graphs at high depths can still be expensive; use a custom `GraphQueryAdapter` for graph-native workloads.`r`n`r`n### BM25 normalisation is O(candidates)

`runStep3` normalises BM25 across the candidate set before scoring. Cost is proportional to candidate count, not corpus size — fine for typical retrieval sizes.

### Vec0 dimension is interpolated

sqlite-vec's `vec0` virtual table requires the dimension as a DDL literal, not a parameter. `EmbeddingRepository` interpolates it via string concatenation — but only after validating `embedding_dimension` is a positive integer, so injection isn't possible. Don't change this without re-validating the input check.

### Reindex is staging-swap safe but cost-heavy

`reindexNamespace()` keeps the live index serving queries until an atomic column repoint; a mid-run failure preserves the old index. It is not "cheap" though — it re-embeds every active assertion. See [reindex operational impact](#reindex-operational-impact).

### Single-process writes

trageti assumes one writer at a time. WAL gives concurrent readers + one writer; multi-process writes need external coordination. The library does not enforce this.

---

## Where to look next

- [`_docs/specs/trageti-spec-v0.3.md`](../specs/trageti-spec-v0.3.md) — the source of truth for the public contract. v0.1 / v0.2 specs are retained alongside it for history only.
- `src/store/TemporalStore.ts` — the entry point. Read top-to-bottom for the orchestration; `enforceStructuralInvariants` is where citation + predecessor checks live.
- `src/pipeline/retrieve.ts` — the most algorithmically dense file. Step 0 is query routing; Step 7 is trajectory expansion.
- `src/db/migrations/runner.ts` - baseline schema bootstrap and schema-version recording.
- `test/integration/e2e.test.ts` — a tour of the full happy path.
