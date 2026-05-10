# Developer Guide

This guide is for engineers working **on** trageti — extending the library, fixing bugs, writing tests, cutting releases. For consumer-facing API documentation, see the top-level [README](../../README.md).

---

## Table of contents

1. [Quick start](#quick-start)
2. [Project layout](#project-layout)
3. [Architectural overview](#architectural-overview)
4. [Critical invariants](#critical-invariants)
5. [Tooling](#tooling)
6. [Local development workflow](#local-development-workflow)
7. [Testing](#testing)
8. [Linting, formatting, typechecking](#linting-formatting-typechecking)
9. [Building](#building)
10. [Adding features](#adding-features)
11. [Database migrations](#database-migrations)
12. [Versioning with changesets](#versioning-with-changesets)
13. [Publishing](#publishing)
14. [Debugging](#debugging)
15. [Performance considerations](#performance-considerations)

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
- **Node.js >= 18** (the package targets Node 18, the CI matrix runs 18 / 20 / 22)
- **npm** (used for lockfile + scripts; pnpm/yarn untested)
- A C++ toolchain for `better-sqlite3` native compilation (already on most dev machines; on Windows install Visual Studio Build Tools, on Linux install `build-essential`, on macOS the Xcode CLI tools)

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
│   ├── contracts/              Pure re-export barrels for the contract names
│   ├── defaults/               Default implementations of the contracts
│   │   ├── connection/         DefaultConnectionVerifier
│   │   ├── formatting/         Prose / Structured / Json formatters
│   │   ├── graph/              CTEGraphAdapter (recursive CTE BFS)
│   │   ├── scoring/            DefaultScorer (semantic 0.6 / bm25 0.3 / recency 0.1)
│   │   └── validation/         DefaultAssertionValidator
│   ├── db/                     Everything that touches the Database object
│   │   ├── candidates.ts       buildCandidateJson — JSON-serialised id list
│   │   ├── migrations/         Code-registered Migration[] + runner
│   │   │   ├── v001_initial.ts Initial schema (v0.1)
│   │   │   └── v002_citations.ts trl_citations + reverse-supersession index (v0.2)
│   │   ├── repositories/       Thin DAOs; one per top-level table
│   │   │   ├── AssertionRepository.ts
│   │   │   ├── CitationRepository.ts (v0.2)
│   │   │   ├── EpisodeRepository.ts
│   │   │   ├── LinkRepository.ts
│   │   │   ├── EmbeddingRepository.ts
│   │   │   └── NamespaceRepository.ts
│   │   └── schema/             columns / extensions / reserved-words
│   ├── pipeline/               Retrieval orchestration; no inline SQL
│   │   ├── retrieve.ts         6-step retrieval (filter → vec → fts → score → rank → expand)
│   │   ├── assemble.ts         retrieve + format + coverage block
│   │   ├── snapshot.ts         Pure temporal filter
│   │   ├── graph.ts            getConnected / findPath wrappers
│   │   ├── middleware.ts       before/after composition
│   │   └── reindex.ts          Drop+recreate vec0; stream re-embed
│   ├── errors/
│   │   └── index.ts            TragetiError + 6 typed subclasses; ErrorCode enum
│   └── internal/               NOT exported from src/index.ts
│       ├── hash.ts             namespaceToTableSuffix (SHA-256 → 16 hex)
│       ├── logger.ts           structuredWarn (no content/embedding leakage)
│       └── sql-ident.ts        quoteIdent for safe DDL interpolation
├── test/
│   ├── unit/                   No DB; vitest projects → fast, deterministic
│   ├── integration/            Requires better-sqlite3 + sqlite-vec
│   ├── helpers/openTestDb.ts   :memory: + sqliteVec.load + WAL + FK
│   └── fixtures/scenario.ts    3 episodes / ~10 assertions / 5 links
├── _docs/dev/                  This file
├── .changeset/                 Pending version bumps
├── .github/workflows/          ci.yml + publish.yml
├── dist/                       Build output (gitignored)
├── eslint.config.js            Flat ESLint config; @typescript-eslint/strict-type-checked
├── tsconfig.json               Strict; rootDir=src; excludes test
├── tsconfig.test.json          Extends; includes src + test for tsc --noEmit
├── tsconfig.eslint.json        Extends; includes src + test for ESLint type service
├── tsup.config.ts              Dual ESM+CJS; dts; better-sqlite3 externalised
├── vitest.config.ts            Single fork (SQLite determinism); v8 coverage
├── package.json                exports map: ESM types-first; CJS via .d.cts
└── trageti-spec-v0.1.md        The source of truth for behaviour
```

### Layering rules

```text
domain  ←  contracts  ←  defaults  ←  pipeline  ←  store
                ↑           ↑
                └── errors ─┘
                ↑
db  ←  pipeline / store / defaults
internal ← (anything; never re-exported)
```

- `domain/types.ts` is the only file that defines interfaces. Contract files just re-export those names. This keeps imports loop-free at TS-resolution time.
- `db/` is the only directory that touches the `Database` object directly.
- `pipeline/` orchestrates repositories and contracts but never writes inline SQL.
- `internal/` is for implementation detail. It is **not** re-exported from `src/index.ts`. Treat it as a private namespace.

---

## Architectural overview

### The `TemporalStore` facade

`TemporalStore` is the single public entry point. Construction is **side-effect-free** — no I/O happens until `init()` is called. `init()` runs in this order:

1. **Connection verification** — `ConnectionVerifier.verify(db)` checks sqlite-vec, warns on non-WAL / FK-disabled.
2. **Migrations** — `MigrationRunner.applyMigrations(db)` brings the schema to the current version (idempotent).
3. **Schema extensions** — `SchemaExtensionApplier` validates user-supplied extensions then applies them transactionally.
4. **Namespace registration** — upsert the default namespace into `trl_namespaces`.
5. **Extension cache warm-up** — read `PRAGMA table_info` for every library table and cache the user-extension columns. Repositories use this to populate the `extensions` bag on returned rows.

After this, the store delegates everything to repositories (writes) and pipeline modules (retrieval).

### Hybrid retrieval pipeline

`retrieve()` has seven pinned steps as of v0.2. They MUST execute in this order; reordering changes the meaning of `temporalAnchor`.

```text
1. Temporal filter        SQL: namespace + temporal window + optional filters → [ids]
                          ↳ v0.2: includeSuperseded:false uses spec wording
                            (a.supersedes_id IS NULL OR a.valid_until IS NULL)
2. Semantic scoring       SQL: vec_distance_cosine over candidate ids (json_each binding)
3. Optional FTS5          SQL: trl_fts MATCH …; raw FTS5 BM25 score per candidate
                          ↳ v0.2: pipeline passes RAW BM25 (negative) into the
                            scorer. Cross-candidate normalisation moved into
                            DefaultScorer.scoreBatch.
4. Score                  TS:  scorer.scoreBatch() if present; else per-candidate
                          score() with the hydrated assertion (with citations)
5. Rank + truncate        TS:  sort by score desc; slice(limit)
6. Optional graph expand  SQL: recursive CTE through trl_links at temporalAnchor
7. Optional trajectory    SQL: recursive CTE through supersedes_id; oldest-first;
                          attached as supersessionChain (excludes the result itself)
```

The funnel between steps is `buildCandidateJson(ids)` — a JSON-serialised array bound as a single parameter and consumed via `json_each(?)`. This is the **only** mechanism for passing intermediate id sets between SQL stages. See [critical invariants](#critical-invariants).

### Citations

Every assertion has at least one citation. The `trl_citations` table (introduced in v002) holds them; `CitationRepository` is the DAO. Reads batch-fetch citations via `json_each` against the candidate funnel — the same mechanism repositories already use for assertion id sets — so common reads stay O(rows + 1 query).

Citations are surfaced on every returned `Assertion` and `RetrievedAssertion`. There is no read path that yields an empty citation array unless the row pre-dates v002 (legacy data only — the validator does not retroactively invalidate such rows).

### Replacement vs accumulation

`supersedes_id` represents *replacement only* (strictly new → old). When a new assertion arrives that *layers on* an earlier one without replacing it, the caller should use `writeLink` with one of the accumulation link types (`deepens`, `qualifies`, `contextualizes`, `contradicts`, `measures`) and leave both assertions valid. `getEntityTrajectory()` follows replacement only — it does NOT traverse `trl_links`. Multi-leaf trajectories are merged + de-duplicated + sorted by `(valid_from, created_at, id)`; branch grouping is *not* preserved (return type is flat `Assertion[]`).

There is no `replaced_by_id` column in v0.2. The `replacedById` parameter on `supersedeAssertion()` is validated for namespace compatibility but not persisted. Use the `trl_idx_assertions_supersedes` index (added in v002) to answer "what replaced X?" via `SELECT id FROM trl_assertions WHERE namespace = ? AND supersedes_id = ?`. A future-design discussion of a forward pointer is deferred — it would either invert the supersession direction or require a separate column / typed link.

### Per-namespace embedding tables

Each namespace gets its own `vec0` virtual table named `trl_embeddings_{16hex}`, where `16hex` is the first 16 hex characters of `SHA-256(utf8(namespace))`. Why per-namespace?

- **Dimension can vary** per namespace (each one stores its own `embedding_dimension`).
- **Reindex is cheap** — drop+recreate one vec0 table doesn't disturb other namespaces.
- **Hash collision is detected** at `initNamespace()` time and throws `NamespaceHashCollisionError`.

Table name resolution:
- In-memory `embeddingTableCache: Map<string, string>` on the store
- Authoritative source: `trl_namespaces.embedding_table` column
- On cache miss, computed from `namespaceToEmbeddingTable(ns)` (deterministic)

### FTS5 with external content

`trl_fts` is an external-content FTS5 table backed by `trl_assertions`. Three triggers (`trl_fts_ai`, `trl_fts_ad`, `trl_fts_au`) keep it in sync. The `AFTER UPDATE OF content` trigger only fires when the `content` column changes — so `supersedeAssertion` (which only updates `valid_until`) does NOT trigger an FTS rebuild.

**Important quirk**: external-content FTS5 tables cannot read `UNINDEXED` columns back via the table alias in some SQLite versions. The `runStep3` query in `pipeline/retrieve.ts` joins to `trl_assertions` via `rowid` rather than reading `assertion_id` from `trl_fts` directly. If you change this, run the full integration suite — the `semantic-retrieval.test.ts` "FTS5 path" test catches regressions.

### Schema extensions

Users can add columns to library tables and additional tables of their own:

```typescript
new TemporalStore(db, {
  namespace: 'x',
  embeddingDimension: 768,
  schemaExtensions: {
    columns: [{ table: 'trl_assertions', columnName: 'source_url', columnDef: 'TEXT' }],
    tables: [{ tableName: 'meta', columns: ['k TEXT', 'v TEXT'], referencesNamespace: false }],
  },
})
```

Validation (in `SchemaExtensionApplier.validate`):
- Column names must not match library columns (shadow check)
- Column names must not be SQLite reserved words
- User table names must not start with `trl_`

Application is wrapped in a single `db.transaction()` — all-or-nothing. Existing columns are detected via `PRAGMA table_info` and skipped (SQLite has no `ADD COLUMN IF NOT EXISTS`).

Extension columns are surfaced on returned rows under `assertion.extensions[colName]`. The list of extension columns is cached at `init()` time on the store.

### Middleware composition

```text
global.before[0..n]  →  call.before[0..n]  →  retrieveCore  →  call.after[n..0]  →  global.after[n..0]
```

Implemented in `pipeline/middleware.ts:applyMiddleware`. Note the **reverse** order on `after` — this matches the standard onion-layer middleware idiom.

---

## Critical invariants

These rules are load-bearing. Breaking them breaks the security/correctness story silently.

### 1. Candidate funneling: `json_each` only

`buildCandidateJson(ids: readonly string[]) → string` is the **only** way candidate ID sets reach SQL. Never:
- Use `IN (?, ?, ?, …)` with parameter unrolling (slow + bind-limit risk)
- Create TEMP tables for funneling (TEMP tables can spill to disk)
- Inline ids into the SQL string (injection risk)

The bound JSON string lives in memory; SQLite parses it via `json_each(:p)` without materialising to disk.

### 2. `structuredWarn` payload typing

`structuredWarn(code: string, meta: Record<string, string|number|boolean>)` accepts only primitive metadata values. Adding a parameter that takes content, embedding, or query text is a hard rule violation. The same goes for error messages — include IDs, namespaces, types; never content.

### 3. `LIBRARY_COLUMNS` is canonical

`src/db/schema/columns.ts` lists every column the library owns. Used for shadow-detection in extensions and for filtering extension columns from row mappers. If you add a column in a migration, you **must** add it to `LIBRARY_COLUMNS` in the same change.

### 4. Migrations are additive

A numbered migration must NEVER drop a column or table. Adding `v003_*` is always fine; modifying `v001_initial` or `v002_citations` after release is not.

### 4a. Citations are always populated on read (with one caveat)

Every read path returns assertions with `citations` populated. The only exception is rows that pre-date the v002 migration — those return `citations: []` until backfilled. The validator only enforces citation presence on *new* writes; it does not retroactively invalidate legacy data.

### 4b. `supersedes_id` is strictly new → old

`writeAssertion({ supersedesId })` persists this backward pointer. `supersedeAssertion()` only writes `valid_until` and never touches `supersedes_id`. `replacedById` is informational. The `trl_idx_assertions_supersedes` index supports reverse lookups.

### 4c. `writeAssertion({ supersedesId })` is a strong replacement signal

It atomically closes the predecessor's `valid_until = new.validFrom` in the same transaction. Once closed, `supersedeAssertion` rejects further window mutations on the predecessor — this prevents chain inconsistency. For accumulation, prefer `writeLink` with one of the accumulation link types and leave both assertions valid.

### 4d. Structural invariants live on `TemporalStore`, not the validator chain

Citation presence/sourceRef/episode-namespace and predecessor-existence/namespace/ordering checks are enforced by `TemporalStore.writeAssertion()` itself (the `enforceStructuralInvariants` helper). Replacing the validators array (`validators: []` or a custom list) does **not** bypass these checks. The default `DefaultAssertionValidator` is for friendly user-facing rules (id/namespace/type non-empty, confidence range, sourceEpisodeId FK) and the `CITATION_EXCERPT_MISSING` warning. Ordering: structural checks first; configured validators run only if structural checks pass — this avoids duplicate error messages on the same field.

### 4e. Schema-extension reserved-name rule is the `trl_` prefix only

There is no library-table-name registry. `SchemaExtensionApplier` rejects extension table names starting with `trl_` and column names that shadow `LIBRARY_COLUMNS`. `trl_citations` is not extensible via `SchemaExtensions` in v0.2.

### 5. Connection verifier is operational only

`DefaultConnectionVerifier` checks `vec_version()`, `journal_mode`, and `foreign_keys`. It does **not** check or reference encryption-related PRAGMAs. Encryption support is a deployment concern; the library stays neutral.

### 6. `src/internal/` is private

Nothing in `src/internal/` is re-exported from `src/index.ts`. Public consumers cannot rely on these names. Treat any change to internal APIs as an internal refactor.

---

## Tooling

| Concern | Tool | Why |
|---|---|---|
| Build | `tsup` (esbuild) | Zero-config dual ESM+CJS, dts generation, fast |
| Test runner | `vitest` v2 | Native ESM, TS support, single-fork mode for SQLite determinism |
| Lint | `eslint` 9 flat config + `typescript-eslint` strict-type-checked | Catches type-unsafe patterns at static analysis time |
| Format | `prettier` | Non-negotiable formatting; integrated via `eslint-config-prettier` |
| Versioning | `@changesets/cli` | Per-PR semver intent + changelog generation |
| Coverage | `@vitest/coverage-v8` | Native v8 coverage; thresholds enforced |
| Native dep | `better-sqlite3` (peer) + `sqlite-vec` (dev only) | Better-sqlite3 is synchronous (matches our transactional model); sqlite-vec ships pre-built binaries |

### TypeScript configuration

Three tsconfig files:

- **`tsconfig.json`** — for the build and editor. `rootDir: "src"`, excludes `test/`. Strict mode plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`.
- **`tsconfig.test.json`** — extends the above. Includes both `src/` and `test/`. Used by `npm run typecheck` to verify tests too.
- **`tsconfig.eslint.json`** — extends the above. Same includes plus root-level `*.ts` / `*.js`. Used by ESLint's type-aware rules.

Why three?
- The build needs `rootDir: "src"` so `dist/` mirrors `src/` cleanly.
- Test typechecking needs `test/` in scope so we catch type errors in tests too.
- ESLint needs every linted file in *some* tsconfig — having a dedicated file lets us shape includes without disturbing the build.

If you add a new top-level directory that should be linted, add it to `tsconfig.eslint.json`'s `include`.

### Strict ESLint rules in effect

The flat config in `eslint.config.js` enables `tseslint.configs.strictTypeChecked` plus extra rules:

- `no-non-null-assertion` (no `x!` in src — must explain why)
- `consistent-type-imports` (use `import type` for type-only imports)
- `no-explicit-any` and the `no-unsafe-*` family (off in tests)
- `restrict-template-expressions` configured to allow numbers/booleans/nullish (numeric IDs are common in error messages)

Tests relax: `no-unsafe-*`, `no-non-null-assertion`, `no-unnecessary-condition`, `no-confusing-void-expression`, `require-await`. These rules add noise without value in test code (e.g. async mock providers without await).

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

# Before pushing
npm run lint && npm run typecheck && npm test && npm run build
```

The `prepublishOnly` hook in `package.json` runs `build` + `typecheck`, so an accidental `npm publish` won't ship broken code.

---

## Testing

### Test taxonomy

| Tier | Location | Marker | DB | Speed | When |
|---|---|---|---|---|---|
| Unit | `test/unit/` | run via `npm run test:unit` | none | <1s | Every save |
| Integration | `test/integration/` | run via `npm run test:integration` | `:memory:` + sqlite-vec | ~1s | Pre-commit |
| E2E | `test/integration/e2e.test.ts` | part of integration | `:memory:` | included | Pre-commit |

There is no separate "regression" tier — every bug fix gets a regression test alongside the integration suite. The reasoning: a regression test is just an integration test that exercises a previously-broken path. Co-locating them keeps coverage discoverable.

### Single-fork pool

`vitest.config.ts` sets `pool: 'forks'` with `singleFork: true`. SQLite (and better-sqlite3) are not safe across worker boundaries; running tests in a single process keeps the suite deterministic. Don't change this unless you've tested it on Windows + macOS + Linux.

### Fixtures

`test/helpers/openTestDb.ts` opens `:memory:`, loads sqlite-vec, sets WAL + foreign_keys + temp_store. Use it for every integration test.

`test/fixtures/scenario.ts` writes a reusable domain-neutral scenario (3 episodes at positions 1/5/10, ~10 assertions including 2 supersession chains, 5 links of varied types). Use it whenever you need a non-trivial graph; avoid duplicating fixtures.

### Coverage thresholds

`vitest.config.ts` enforces:
- Lines / Functions / Statements ≥ 90%
- Branches ≥ 75% (the optional-spread idiom in `assemble.ts` skews branch coverage downward without indicating real gaps)

Run `npm run test:coverage` to print the table. Type-only barrels (`contracts/*`, `defaults/index.ts`, `domain/types.ts`, `index.ts`) are excluded — they have no executable code.

### Adding a test

1. Pick the right tier — does it need a DB? → integration.
2. Reuse `openTestDb` and `loadScenario` where possible.
3. Use `beforeEach` to recreate state; never share state across tests.
4. Assert on **observable behaviour**, not implementation details. Don't reach into private methods.

---

## Linting, formatting, typechecking

```bash
npm run lint               # exits 0 on clean
npm run typecheck          # tsc --noEmit on both src and test
npm run format:check       # prettier --check (CI uses this)
npm run format             # prettier --write
```

CI runs all four. A PR that fails any of them is blocked.

If you need to disable a rule for a specific line:

```ts
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const x = arr[0]!  // safe because arr.length === 1 was just asserted
```

Always pair the `eslint-disable` with a why-comment. Reviewers will reject blanket disables.

---

## Building

```bash
npm run build
```

Outputs to `dist/`:
- `dist/index.js` (ESM) + `dist/index.js.map`
- `dist/index.cjs` (CJS) + `dist/index.cjs.map`
- `dist/index.d.ts` (ESM types) + `dist/index.d.cts` (CJS types)

Configuration in `tsup.config.ts`:
- Targets Node 18
- `external: ['better-sqlite3']` — peer dependency, never bundled
- `dts: true` — generates declaration files
- `sourcemap: true`
- Cleans `dist/` before each build

The `package.json#exports` map points consumers at the right artefact:

```json
"exports": {
  ".": {
    "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
  }
}
```

The "types" condition comes **first** within each branch — this is the modern Node + TS resolution algorithm requirement (`moduleResolution: "Bundler"` or `"Node16"+`). Don't reorder these.

### What ships in the package

`package.json#files` lists what npm publish includes:

```json
"files": ["dist", "README.md", "LICENSE", "CHANGELOG.md"]
```

`.npmignore` provides a belt-and-suspenders exclusion for everything else. **Source code does not ship to npm** — only the built `dist/`. If a consumer needs the source, they should clone the repo.

---

## Adding features

### Adding a public API method

1. Add the method to `TemporalStore` (likely delegating to a `pipeline/` function).
2. Add domain types to `src/domain/types.ts` if you need new option/result shapes.
3. Re-export new types from `src/index.ts`.
4. Write integration tests in `test/integration/`. Cover happy path + at least one error case.
5. If the method changes a contract, update the relevant interface in `src/domain/types.ts` (contract files are pure re-exports — they update automatically).
6. Add a changeset: `npx changeset`.

### Adding a contract / extension point

1. Define the interface in `src/domain/types.ts`.
2. Re-export it from `src/contracts/MyNewContract.ts` and `src/contracts/index.ts`.
3. Provide a default implementation in `src/defaults/{category}/MyDefault.ts`.
4. Wire it into `TemporalStoreOptions` and the constructor's defaults block.
5. Pass it down to the consuming pipeline function.
6. Add unit tests for the default implementation; add integration tests proving the override works.

### Adding a default implementation variant

E.g. a new formatter:

1. Create `src/defaults/formatting/MyFormatter.ts` implementing `ContextFormatter`.
2. Add `metadata.formatter` so callers can identify which formatter ran.
3. Honour `tokenBudget` correctly — set `truncated: true` when items are dropped, populate `metadata.includedAssertions`.
4. Re-export from `src/index.ts`.
5. Add to `test/unit/formatters.test.ts` and `test/integration/context-assembly.test.ts`.

### Schema-touching changes

If you change the database schema, you must add a migration (next section).

---

## Database migrations

Migrations are code-registered in `src/db/migrations/index.ts` as a numbered array. The runner asserts at runtime that `migrations[i].version === i + 1`. Skipping a number is a fatal startup error.

### Adding migration v002

```typescript
// src/db/migrations/v002_my_change.ts
import type { Migration } from '../../domain/types.js'

export function createV002Migration(): Migration {
  return {
    version: 2,
    description: 'Add foo column to trl_assertions',
    up(db) {
      db.exec(`ALTER TABLE trl_assertions ADD COLUMN foo TEXT;`)
      // Backfill, index creation, etc.
    },
  }
}
```

```typescript
// src/db/migrations/index.ts — append, do not reorder
import { createV001Migration } from './v001_initial.js'
import { createV002Migration } from './v002_my_change.js'

export function getMigrations(tokenizer?: FTS5TokenizerConfig): Migration[] {
  return [createV001Migration(tokenizer), createV002Migration()]
}
```

```typescript
// src/db/schema/columns.ts — keep in sync
export const LIBRARY_COLUMNS = {
  trl_assertions: [..., 'foo'],
  // …
}
```

Then add an integration test in `test/integration/migrations.test.ts` that:
- Verifies a fresh DB ends at the new schema version
- Verifies running migrations on a v001 DB upgrades it to v002 cleanly
- Verifies idempotent re-runs

### Migration constraints

- **Additive only.** Don't drop columns or tables in numbered migrations. If you absolutely must remove something, deprecate it first across at least one minor version.
- **Each migration runs in its own `db.transaction()`** (the runner handles this).
- **No data dependencies on user content.** A migration must succeed on every database, regardless of namespace count or row count.
- **Idempotent.** Use `IF NOT EXISTS` clauses; tolerate re-runs.

---

## Versioning with changesets

We use [changesets](https://github.com/changesets/changesets) for semver intent capture and changelog generation.

### Adding a changeset (every PR)

```bash
npx changeset
```

Choose:
- **patch** — bug fixes, internal refactors, doc-only
- **minor** — new features, new public API
- **major** — breaking changes (renamed/removed APIs, behavioural changes that break existing callers)

Write a one-line summary that will appear in the changelog. The CLI writes a markdown file under `.changeset/`. **Commit it with your code change** — the publish workflow consumes it.

### Pre-1.0 caveat

Until we hit `1.0.0`, **breaking changes can ship as minor bumps** (per semver pre-1.0). Reserve major bumps for the 0→1 transition. Until then, mark every breaking change as `minor` and call out "BREAKING:" in the changeset summary.

### Releasing

The `publish.yml` workflow runs on every push to `main`:
1. Builds the package
2. Runs `changesets/action@v1`
3. If `.changeset/*.md` files exist, opens (or updates) a "Version Packages" PR that bumps `package.json` and rolls up the changesets into `CHANGELOG.md`
4. When that PR is merged, the workflow publishes to npm via `npm run release` (which calls `changeset publish`)

So the human flow is:

```text
PR with code + changeset  →  merge to develop  →  promote to main  →  Version Packages PR appears  →  merge it  →  npm publish runs automatically
```

---

## Publishing

### Required GitHub secrets

| Secret | Used by | Notes |
|---|---|---|
| `GITHUB_TOKEN` | `changesets/action` | Auto-provided by GitHub Actions |
| `NPM_TOKEN` | `npm publish` | Set in repo settings → Secrets and variables → Actions. Use an npm "Automation" token (does not require 2FA OTP) |

### Publishing to npmjs.org (automated)

The standard path. After merging a Version Packages PR to `main`, the publish workflow:
1. Installs and builds
2. Calls `changeset publish`
3. Publishes the new version to npm with `--provenance` (via `NPM_CONFIG_PROVENANCE: true`)
4. Creates GitHub release notes

You don't need to do anything manually. **Do not run `npm publish` from your laptop** — it bypasses provenance and CI gates.

### Publishing to npmjs.org (manual fallback)

Only if the automated workflow is broken:

```bash
npm login                          # one time
npm run build                      # produces dist/
npm publish --access public        # use --provenance if you have a ci-style token
```

You'll need write access to the `trageti` package on npm and an authenticated npm session.

### Publishing to GitHub Packages

Not currently configured. If we add it:
1. Add a second registry to the publish workflow
2. Add `publishConfig.registry` overrides per registry
3. Generate a separate `GITHUB_PACKAGES_TOKEN` with `packages:write`

### Local "publish" — testing the published package without publishing

#### Option A: `npm pack`

```bash
npm run build
npm pack                     # produces trageti-X.Y.Z.tgz
cd /path/to/consumer-project
npm install /path/to/trageti-X.Y.Z.tgz
```

This is the **closest fidelity** to a real publish — it exercises `package.json#files` and the `exports` map exactly as consumers will see it.

#### Option B: `npm link`

```bash
cd /path/to/trageti
npm run build
npm link                     # registers a global symlink

cd /path/to/consumer-project
npm link trageti
```

Faster iteration but quirky on Windows and with peer deps. Prefer `npm pack` for verification, `npm link` only for active local-development loops.

#### Option C: file: dependency

```json
// in consumer's package.json
"dependencies": {
  "trageti": "file:../trageti"
}
```

Useful in monorepo-like setups. Run `npm run build` after changes — consumers will pull from `dist/`.

### Verifying a release before publish

```bash
npm run build
npm pack --dry-run           # prints what would be packed
```

The output should include `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md`, and `package.json` — and nothing else. If you see source files in the list, fix `package.json#files` and `.npmignore` before publishing.

### Unpublishing / yanking

npm strongly discourages unpublish. If a release is broken:

```bash
npm deprecate trageti@X.Y.Z "Critical bug — upgrade to X.Y.Z+1"
```

Then ship a fix as `X.Y.Z+1` immediately.

---

## Debugging

### Inspect a specific test

```bash
npx vitest run test/integration/temporal-filter.test.ts
npx vitest run test/integration/temporal-filter.test.ts -t "validAt"
```

### See SQL the library is running

There is no built-in query logger (we don't want to risk leaking content). For local debugging, monkey-patch your test connection:

```typescript
const original = db.prepare.bind(db)
;(db as any).prepare = (sql: string) => {
  console.log('[SQL]', sql)
  return original(sql)
}
```

Don't commit this.

### Inspect schema state mid-test

```typescript
console.log(db.prepare('SELECT name, sql FROM sqlite_master').all())
console.log(db.prepare('PRAGMA table_info(trl_assertions)').all())
console.log(db.prepare('SELECT MAX(version) FROM trl_schema_version').get())
```

### Reproducing a CI failure locally

CI runs on Node 18/20/22 on Ubuntu. To match exactly:

```bash
nvm use 18
npm ci                       # not npm install — uses lockfile
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
```

### Common issues

**`Error: vec_version is not a function`** during a test → `openTestDb()` wasn't used, or sqlite-vec isn't installed. Run `npm install`.

**`Error: SQLITE_ERROR: no such column: T.assertion_id`** → you reverted the FTS5 join workaround in `pipeline/retrieve.ts`. The external-content FTS5 table cannot read `UNINDEXED` columns back via alias; join to `trl_assertions` via rowid.

**Lint error: "parserOptions.project" was not found in any of the provided project(s)** → the file isn't in `tsconfig.eslint.json`'s `include`. Add it.

**Type error in a test that compiles in src** → tests use `tsconfig.test.json`, which extends the strict src config. Don't relax src strictness; fix the test.

**`[trageti:warn] code=CITATION_EXCERPT_MISSING ...`** → expected when an assertion's citation has `excerpt: null`. Advisory only; emitted by `DefaultAssertionValidator`. Replace the validator chain to suppress it in domains where verbatim excerpts are unavailable.

**`citations: []` on every read** → the row pre-dates the v002 migration (legacy v0.1 data). The validator only enforces citation presence on new writes; existing rows remain readable. Backfill citations via `store.writeCitation({ ... })` if needed.

**`ValidationError: predecessor "X" already closed at validUntil=N`** → `writeAssertion({ supersedesId: 'X' })` failed because X's window is already closed (someone else superseded it first or you ran the same write twice). The structural-invariant check rejects this to prevent chain corruption. If you're trying to layer rather than replace, drop `supersedesId` and use `writeLink` with one of the accumulation link types.

---

## Performance considerations

This is a v0.1 library with conservative performance characteristics. Hot spots to be aware of:

### `findPath` is O(branching^depth)

The default `CTEGraphAdapter.findPath` uses a recursive CTE without pruning. On dense graphs (many edges per node) and large depths (>5), this gets slow. If you hit this, implement a custom `GraphQueryAdapter`. Don't try to make the default smarter at the cost of correctness — graph-native engines exist for a reason.

### BM25 normalisation is O(candidates)

`pipeline/retrieve.ts:runStep3` normalises BM25 across the candidate set before feeding them into the scorer. Cost is proportional to the number of candidates, not the corpus size, so this scales fine for our typical retrieval sizes. If you cache scorer results across queries, ensure cache keys include the candidate set hash.

### Vec0 dimension is interpolated

sqlite-vec's `vec0` virtual table requires the dimension as a literal in the DDL, not a parameter. `EmbeddingRepository.ensureVec0Table` interpolates it via string concatenation — but we validate `embedding_dimension` is a positive integer first, so injection isn't possible. Don't change this without re-validating the input check.

### `reindexNamespace` is not transactional

The drop+recreate is in one transaction, but the streaming re-embed is not. better-sqlite3 transactions are synchronous; you cannot `await` inside `db.transaction(...)`. So if the embedding provider throws halfway through, the embedding table is empty and the dimension is updated. Recovery: call `getPendingIndexing(ns)` to see what's missing, then call `reindexNamespace` again. This is documented; don't try to "fix" it with a bigger transaction.

### Single-process writes

trageti assumes one writer at a time. SQLite supports concurrent readers + one writer with WAL mode, but multi-process writes need external coordination (a lock file, an in-process queue, etc.). This is a deployment concern; the library does not enforce it.

---

## Where to look next

- `_docs/specs/trageti-spec-v0.2.md` — the source of truth for the public contract (current).
- `trageti-spec-v0.1-DEPRECATED.md` at the repo root — historical v0.1 spec, retained for reference only.
- `src/store/TemporalStore.ts` — the entry point. Read top-to-bottom to understand the orchestration. The `enforceStructuralInvariants` method is where citation + predecessor checks live.
- `src/pipeline/retrieve.ts` — the most algorithmically dense file. Heavily commented. Step 7 is trajectory expansion.
- `src/db/repositories/CitationRepository.ts` — the citations DAO with batch-fetch helpers.
- `test/integration/e2e.test.ts` — exercise of the full happy path; useful as a tour.
- `test/integration/citations.test.ts` and `test/integration/trajectory.test.ts` — v0.2-specific behavioural coverage.
