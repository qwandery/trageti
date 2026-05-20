# trageti v0.2 Implementation Plan

## Context

`_docs/specs/trageti-spec-v0.2.md` introduces three additions to the existing v0.1 prototype:

1. **Citations (BREAKING)** — every assertion must carry at least one `AssertionCitation`. Adds a new `trl_citations` table, mutates the `Assertion` and `RetrievedAssertion` interfaces, the `writeAssertion()` signature, the default validator, the default Prose formatter, and retrieval result shape (citations always populated).
2. **Trajectory retrieval mode (additive)** — `assembleContext()` and `retrieve()` gain a `mode: 'snapshot' | 'trajectory'` option; `RetrievedAssertion` gains a `supersessionChain?: Assertion[]`. Snapshot mode (the default) preserves existing behaviour exactly.
3. **`getEntityTrajectory()` (additive)** — a new utility that walks the supersession chain for a given entity, distinct from the existing `getEntityHistory()`.

Two pre-existing prototype defects must be fixed alongside this spec work because v0.2 trajectory mode depends on them being correct (per user direction in plan-mode Q&A):

- **Inverted `supersedes_id` semantic in `supersedeAssertion()`.** The current code does `UPDATE trl_assertions SET supersedes_id = COALESCE(?, supersedes_id) WHERE id = ?`, overwriting the OLD assertion's `supersedes_id` to point at the NEW one. The spec semantic is that `supersedes_id` on assertion X is _the prior assertion X replaces_. The recursive CTE in spec §Retrieval Implementation Step 7 only walks correctly under the spec semantic; with the current behaviour, trajectory walks would terminate after a single hop. Fix: `supersedeAssertion()` only writes `valid_until`. `replacedById` becomes informational (kept in the parameter signature for backwards compatibility but not written back).
- **Atomicity gap on supersession.** When the caller writes a replacement assertion, two writes must happen — insert new, set `valid_until` on old. Today these are two separate calls. Fix: when `writeAssertion()` is called with a non-null `supersedesId`, wrap the insert and the implicit `supersedeAssertion(supersedesId, { validUntil: new.validFrom })` in a single `db.transaction()`. The caller may still call `supersedeAssertion()` explicitly afterwards to extend or correct the window.

The current implementation has 111 passing tests and a clean dual ESM+CJS build. v0.2 is published as a minor bump (`0.2.0`) per the pre-1.0 changeset convention; the citations change is BREAKING but pre-1.0 breakage ships as minor.

The package is upgraded as a single PR: spec sync, schema migration, code changes, fixtures, tests, docs, version bump.

---

## Files to be modified or created

Critical files (highest impact first):

- [src/domain/types.ts](src/domain/types.ts) — add `AssertionCitation`, `RetrievalMode`; mutate `Assertion`, `RetrievedAssertion`, `RetrievalQuery`, `ContextAssemblyOptions`, `AssertionValidator`
- [src/db/migrations/v002_citations.ts](src/db/migrations/v002_citations.ts) **(new)** — DDL for `trl_citations` + `trl_idx_citations_assertion`
- [src/db/migrations/index.ts](src/db/migrations/index.ts) — append v002
- [src/db/schema/columns.ts](src/db/schema/columns.ts) — add `trl_citations` to `LIBRARY_COLUMNS`; add table-name constant for shadow checks
- [src/db/repositories/CitationRepository.ts](src/db/repositories/CitationRepository.ts) **(new)** — DAO for `trl_citations`
- [src/db/repositories/AssertionRepository.ts](src/db/repositories/AssertionRepository.ts) — citation join on read (`getById`, `query`, `getEntityHistory`); fix `supersedeAssertion()`; add `getEntityTrajectory()`; add `getSupersessionChain(assertionId)` for retrieval Step 7
- [src/store/TemporalStore.ts](src/store/TemporalStore.ts) — wire `CitationRepository`; new `writeCitation()` method; new `getEntityTrajectory()` method; transactional supersession in `writeAssertion()`
- [src/defaults/validation/DefaultAssertionValidator.ts](src/defaults/validation/DefaultAssertionValidator.ts) — citation presence + episode FK + sourceRef checks; null-excerpt warning
- [src/defaults/formatting/ProseFormatter.ts](src/defaults/formatting/ProseFormatter.ts) — append compact citation markers
- [src/defaults/formatting/StructuredFormatter.ts](src/defaults/formatting/StructuredFormatter.ts) — citation markers in bullets
- [src/defaults/formatting/JsonFormatter.ts](src/defaults/formatting/JsonFormatter.ts) — include citations in JSON payload
- [src/pipeline/retrieve.ts](src/pipeline/retrieve.ts) — Step 7 trajectory expansion; pass mode through
- [src/pipeline/assemble.ts](src/pipeline/assemble.ts) — pass `mode` into the retrieve query
- [src/index.ts](src/index.ts) — export `AssertionCitation`, `RetrievalMode`
- [src/internal/logger.ts](src/internal/logger.ts) — add `CITATION_NULL_EXCERPT` warning code (no signature change)

Test files:

- [test/fixtures/scenario.ts](test/fixtures/scenario.ts) — every `writeAssertion` call gets at least one citation; replacement assertions carry `supersedesId`; remove the now-redundant `supersedeAssertion(_, { replacedById })` calls (replaced by automatic transactional supersession in `writeAssertion`)
- [test/integration/citations.test.ts](test/integration/citations.test.ts) **(new)** — full citation surface
- [test/integration/trajectory.test.ts](test/integration/trajectory.test.ts) **(new)** — trajectory mode + `getEntityTrajectory()`
- [test/integration/migrations.test.ts](test/integration/migrations.test.ts) — assert v002 applies, schema version 2, `trl_citations` exists, `trl_idx_citations_assertion` exists, idempotency, v001→v002 upgrade path
- [test/integration/supersession.test.ts](test/integration/supersession.test.ts) — adapt for new auto-transactional supersession; assert `supersedes_id` on the OLD assertion is unchanged after `supersedeAssertion`; assert atomic visibility
- All other touched integration tests get citation arguments threaded through their writeAssertion calls

Doc files:

- [\_docs/specs/trageti-spec-v0.2.md](_docs/specs/trageti-spec-v0.2.md) — leave as authoritative source (already in repo)
- [trageti-spec-v0.1.md](trageti-spec-v0.1.md) → rename to `trageti-spec-v0.1-DEPRECATED.md` and add a banner at the top
- [\_docs/dev/README.md](_docs/dev/README.md) — full pass: project layout adds citations files, retrieval pipeline adds Step 7, references to v0.1 swapped for v0.2, "Where to look next" updated, schema diagram updated, add citation/trajectory architectural notes
- [README.md](README.md) — citation example in Quick Start; Retrieval section adds `mode`; update schema-extensions example to use the actual `column`/`definition` names (pre-existing typo using `columnName`/`columnDef`); add Citations and Trajectory sections; bump compatibility note
- [CHANGELOG.md](CHANGELOG.md) — v0.2.0 entry generated by changeset
- [.changeset/v0.2-citations-and-trajectory.md](.changeset/v0.2-citations-and-trajectory.md) **(new)** — `trageti: minor` with BREAKING summary
- [package.json](package.json) — version `0.2.0`

---

## Implementation tasks (in execution order)

### Phase A — Schema, types, repositories

**A1. Add v002 migration.** Create `src/db/migrations/v002_citations.ts`:

```sql
CREATE TABLE IF NOT EXISTS trl_citations (
  id              TEXT PRIMARY KEY,
  assertion_id    TEXT NOT NULL REFERENCES trl_assertions(id),
  episode_id      TEXT NOT NULL REFERENCES trl_episodes(id),
  source_ref      TEXT NOT NULL,
  excerpt         TEXT,
  excerpt_start   TEXT,
  excerpt_end     TEXT,
  metadata        TEXT,                                   -- JSON
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS trl_idx_citations_assertion
  ON trl_citations(assertion_id);
```

Append to `getMigrations()` in [src/db/migrations/index.ts](src/db/migrations/index.ts). The runner already enforces the version-equals-index-plus-one invariant.

**A2. Update `LIBRARY_COLUMNS`** in [src/db/schema/columns.ts](src/db/schema/columns.ts). The current type `LibraryTable` lists only `trl_assertions | trl_episodes | trl_links`. Decide whether `trl_citations` joins this list (and gains schema-extension support) or stays internal-only.

Recommendation: **do not** add `trl_citations` to `LibraryTable` for v0.2. The spec does not invite extensions on citations, and the SchemaExtensionApplier shadow-detection only applies to extensible tables. Add a separate constant `LIBRARY_TABLE_NAMES = ['trl_assertions', 'trl_episodes', 'trl_links', 'trl_citations', 'trl_namespaces', 'trl_links', 'trl_fts', 'trl_schema_version']` for any future blanket checks; keep the typed extension surface unchanged.

**A3. Add `AssertionCitation` to [src/domain/types.ts](src/domain/types.ts)**:

```typescript
export interface AssertionCitation {
  id: string
  assertionId: string
  episodeId: string
  sourceRef: string
  excerpt: string | null
  excerptStart?: string
  excerptEnd?: string
  metadata?: Record<string, unknown>
  createdAt: string
}

export type RetrievalMode = 'snapshot' | 'trajectory'
```

Mutate `Assertion`: add `citations: AssertionCitation[]` (always populated on read).
Mutate `RetrievedAssertion`: add `supersessionChain?: Assertion[]` (populated only when `mode === 'trajectory'`). `citations` is inherited.
Mutate `RetrievalQuery`: add `mode?: RetrievalMode`.
Mutate `ContextAssemblyOptions`: add `mode?: RetrievalMode`.
Mutate `AssertionValidator.validate()` parameter to accept the new shape: `Omit<Assertion, 'createdAt' | 'extensions' | 'citations'> & { citations: Omit<AssertionCitation, 'id' | 'assertionId' | 'createdAt'>[] }` — citations are validated _before_ assertion-id resolution.

**A4. Create [src/db/repositories/CitationRepository.ts](src/db/repositories/CitationRepository.ts)**:

```typescript
class CitationRepository {
  insertMany(
    assertionId: string,
    citations: Omit<AssertionCitation, 'id' | 'assertionId' | 'createdAt'>[],
  ): AssertionCitation[]
  insertOne(citation: Omit<AssertionCitation, 'createdAt'>): AssertionCitation
  getByAssertionId(assertionId: string): AssertionCitation[]
  getByAssertionIds(ids: readonly string[]): Map<string, AssertionCitation[]> // batch fetch via json_each candidate funnel — see invariant 1 in dev guide
}
```

ID generation for citations: caller may supply an id on `writeCitation()` (per spec interface); for citations created via `writeAssertion(...)`, generate ids with `${assertionId}-cit-${index}` (deterministic, debuggable, no extra dependency). Alternatively use `crypto.randomUUID()` — pick one and document.

Recommendation: **caller-supplied id is required** for `writeCitation()` (spec); for citations passed inline via `writeAssertion`, use `${assertionId}:c${i}` for deterministic ids that aid debugging. Document in the dev guide.

**A5. Update [src/db/repositories/AssertionRepository.ts](src/db/repositories/AssertionRepository.ts)**:

- `rowToAssertion()` must accept a `citations` argument (or lazily fetch). Prefer eager batch-fetch in `query()` and `getEntityHistory()` via `CitationRepository.getByAssertionIds()`; for `getById()` issue a single follow-up fetch.
- Fix `supersedeAssertion(assertionId, validUntil, replacedById = null)`: change SQL to `UPDATE trl_assertions SET valid_until = ? WHERE id = ?`. Drop the `supersedes_id` write entirely. The `replacedById` parameter is preserved for back-compat but ignored at the SQL layer; document this in a JSDoc comment (rationale: spec semantic is that `supersedes_id` is set on the _new_ assertion at `writeAssertion()` time).
- Add `getEntityTrajectory(namespace, entityId): Assertion[]`: SELECT current-state assertion(s) for the entity, then walk `supersedes_id` recursively backward, returning the chain oldest-first. Use the spec §Step 7 CTE pattern. Return all chains found (one per leaf if multiple are active).
- Add `getSupersessionChain(assertionId): Assertion[]`: returns the full chain ending at the given assertion, oldest-first, _including_ the given assertion. Each chain entry has its citations populated. This powers retrieval Step 7.

**A6. Update [src/db/repositories/EmbeddingRepository.ts](src/db/repositories/EmbeddingRepository.ts)** — no changes required.

**A7. Update [src/store/TemporalStore.ts](src/store/TemporalStore.ts)**:

- Add `citationRepo: CitationRepository` field, instantiate in `init()`.
- `writeAssertion(assertion)`: wrap the entire validate → insert → cite → optional supersede sequence in a single `db.transaction()`. Pseudocode:
  ```
  db.transaction(() => {
    runValidators(assertion)        // includes citation checks
    assertionRepo.insert(assertion)
    citationRepo.insertMany(assertion.id, assertion.citations)
    if (assertion.supersedesId) {
      assertionRepo.supersedeAssertion(assertion.supersedesId, assertion.validFrom)
    }
  })()
  ```
  This collapses what was two separate caller calls into one atomic operation, satisfying the user-requested invariant. Existing callers that already call `supersedeAssertion()` afterwards will succeed idempotently — `valid_until` will be set to `new.validFrom`, and the explicit call (now a no-op semantically when `validUntil === new.validFrom`) just rewrites the same value. If the caller passes a _later_ `validUntil`, that wins (LWW within the same transaction is fine).
- Add `writeCitation(citation: Omit<AssertionCitation, 'createdAt'>): AssertionCitation` — validates the assertion exists, the episode exists in the same namespace, then inserts. Spec §API.
- Add `getEntityTrajectory(namespace, entityId): Assertion[]` — delegates to `assertionRepo.getEntityTrajectory()`.
- All read methods now return assertions with `citations` populated; the existing call sites already return `Assertion[]`/`Assertion`, so the change is transparent at the facade level.

### Phase B — Validation, retrieval, formatters

**B1. Update [src/defaults/validation/DefaultAssertionValidator.ts](src/defaults/validation/DefaultAssertionValidator.ts)**:

- Add `assertion.citations` array length check — must contain ≥ 1 entry.
- For each citation: `episodeId` non-empty AND references an existing episode in `assertion.namespace`; `sourceRef` non-empty.
- For each citation with `excerpt === null`: emit `structuredWarn('CITATION_NULL_EXCERPT', { assertionId, sourceRef })`. Do not error.

The validator interface change in A3 means the parameter type now includes `citations`. The existing FK check on `sourceEpisodeId` stays.

**B2. Update [src/pipeline/retrieve.ts](src/pipeline/retrieve.ts)**:

- After Step 6 (graph expand), insert Step 7: if `query.mode === 'trajectory'`, for each result fetch its supersession chain via `assertionRepo.getSupersessionChain(result.id)`. Attach as `result.supersessionChain` (excluding the result itself per spec wording — "all prior versions"). Citations on chain members are guaranteed by `AssertionRepository.rowToAssertion()`.
- Pass `mode` through `retrieveCore()`.
- Default to `'snapshot'` when undefined — preserves v0.1 behaviour.

**B3. Update [src/pipeline/assemble.ts](src/pipeline/assemble.ts)** — thread `mode` into the constructed `RetrievalQuery`.

**B4. Update formatters** ([src/defaults/formatting/ProseFormatter.ts](src/defaults/formatting/ProseFormatter.ts), [src/defaults/formatting/StructuredFormatter.ts](src/defaults/formatting/StructuredFormatter.ts), [src/defaults/formatting/JsonFormatter.ts](src/defaults/formatting/JsonFormatter.ts)):

- Prose: append a compact citation marker per assertion line. Format: `[ep-1#chunk:3, ep-2#0:08:14-0:12:30]` — episode id + sourceRef. Multi-citation list is rendered comma-separated.
- Structured: append the same compact marker after each bullet.
- Json: include the full `citations` array in the assertion payload (omit the `excerpt` field if null to keep payloads tight, or include — pick one; recommendation is _include null_ for explicitness).
- Token estimation: account for the citation marker in the per-line token cost so `tokenBudget` enforcement remains accurate.

### Phase C — Fixtures, tests, version

**C1. Update [test/fixtures/scenario.ts](test/fixtures/scenario.ts)**:

- Every `writeAssertion` call gains a `citations: [{ id: '<aId>:c0', episodeId, sourceRef: 'chunk:1' }]` block (or richer, varying citations to support test assertions).
- The two existing supersession chains:
  - Chain 1: write `a-7` with `supersedesId: 'a-6'` (was `null`). Drop the `supersedeAssertion('a-6', { validUntil: 5, replacedById: 'a-7' })` call — `writeAssertion('a-7', supersedesId='a-6', validFrom=5)` now performs the supersession atomically.
  - Chain 2: `a-8` superseded with no replacement — kept as an explicit `supersedeAssertion('a-8', { validUntil: 10 })` call (no replacement assertion exists).

**C2. Create [test/integration/citations.test.ts](test/integration/citations.test.ts)** covering:

- `writeAssertion` rejects an assertion with `citations: []` → `ValidationError`
- `writeAssertion` rejects a citation pointing to a non-existent episode
- `writeAssertion` rejects a citation with empty `sourceRef`
- `writeAssertion` with `excerpt: null` emits the warning but succeeds
- Read methods (`getById`, `getAssertions`, `getEntityHistory`, `retrieve`) all return populated `citations` arrays — never empty for newly-written assertions
- `writeCitation()` happy path, FK-check failure paths
- Existing v001-only data (assertions written before v002 migration) returns `citations: []` and is not retroactively invalidated. (Construct test by direct INSERT bypassing the validator, then upgrade.)
- Multi-citation assertion round-trips fully
- Citation `metadata` JSON round-trips

**C3. Create [test/integration/trajectory.test.ts](test/integration/trajectory.test.ts)** covering:

- `retrieve({ mode: 'snapshot' })` produces identical output to `retrieve()` (default) — regression guard
- `retrieve({ mode: 'trajectory' })` populates `supersessionChain` for results that have superseded predecessors; returns `supersessionChain: []` (or undefined per spec wording) for results without
- `supersessionChain` is ordered oldest-first
- Each chain entry carries its full `citations` array
- `assembleContext({ mode: 'trajectory' })` propagates mode through to retrieval (assert via spying middleware)
- `getEntityTrajectory()` returns the full chain for an entity that has supersessions
- `getEntityTrajectory()` returns the single current assertion for an entity with no supersessions
- `getEntityTrajectory()` vs `getEntityHistory()` — semantic distinction test: `getEntityHistory` returns _all_ assertions for an entity (including unrelated parallel assertions); `getEntityTrajectory` follows only the supersession chain. Use a fixture where an entity has both a supersession chain _and_ an unrelated parallel assertion to demonstrate divergence.

**C4. Update [test/integration/migrations.test.ts](test/integration/migrations.test.ts)**:

- Fresh DB ends at schema version 2
- `trl_citations` table exists; `trl_idx_citations_assertion` index exists
- Idempotent re-run keeps version at 2
- v001-only DB upgrades cleanly to v002 (apply only v001 migration manually, then run full runner — assert version goes 1→2)

**C5. Update [test/integration/supersession.test.ts](test/integration/supersession.test.ts)**:

- After `writeAssertion(new, supersedesId=old, validFrom=N)` followed by no other call, `old.valid_until === N` (atomic supersession test)
- After `supersedeAssertion(old, { validUntil, replacedById })`, `old.supersedes_id` is unchanged — i.e. the bug fix regression test
- New test: `getEntityTrajectory()` for a chain produces correct ordering
- Existing tests get their `writeAssertion` calls updated for citations

**C6. Update every integration test** in `test/integration/` (about 11 files) to thread `citations: [{ id, episodeId, sourceRef }]` through every `writeAssertion` call. Most tests can use a small `defaultCitation(epId)` helper in `test/fixtures/scenario.ts` to keep diffs small.

**C7. Run the full local pipeline**: `npm run lint && npm run typecheck && npm test && npm run build`. Address any drift; coverage thresholds (lines/functions/statements ≥ 90%, branches ≥ 75%) must hold.

### Phase D — Versioning and docs

**D1. Bump [package.json](package.json) version to `0.2.0`.**

**D2. Add changeset** at `.changeset/v0.2-citations-and-trajectory.md`:

```markdown
---
'trageti': minor
---

BREAKING: assertions now require at least one citation. New `trl_citations` table, new `AssertionCitation` interface, `writeAssertion()` requires `citations`, default validator enforces presence.

NEW: trajectory retrieval mode. `retrieve()` and `assembleContext()` accept `mode: 'snapshot' | 'trajectory'`. New `getEntityTrajectory()` utility.

FIX: `supersedeAssertion()` no longer overwrites `supersedes_id` on the old assertion. `writeAssertion()` with `supersedesId` now atomically updates the predecessor's `valid_until` in a single transaction.
```

**D3. Rename [trageti-spec-v0.1.md](trageti-spec-v0.1.md) → `trageti-spec-v0.1-DEPRECATED.md`** and add a banner at the top:

```markdown
> **DEPRECATED** — This is the historical v0.1 specification. The current authoritative specification is [\_docs/specs/trageti-spec-v0.2.md](_docs/specs/trageti-spec-v0.2.md). This file is retained for historical reference only and should not be used to guide implementation.
```

**D4. Update [\_docs/dev/README.md](_docs/dev/README.md)** comprehensively:

- Project layout: add `db/repositories/CitationRepository.ts`, `db/migrations/v002_citations.ts`, `test/integration/citations.test.ts`, `test/integration/trajectory.test.ts`
- "Architectural overview" → add a _Citations_ subsection: every assertion has ≥1 citation; eagerly fetched in repo reads; surfaced on every returned `Assertion` and `RetrievedAssertion`
- "Hybrid retrieval pipeline" → update the 6-step diagram to a 7-step diagram with optional Step 7 trajectory expansion
- "Critical invariants" → add a new invariant: _Citations are always populated on read._ No retrieval path returns an `Assertion` with an empty `citations` array unless the row pre-dates v002 (legacy data only)
- "Where to look next" → swap `trageti-spec-v0.1.md` for `_docs/specs/trageti-spec-v0.2.md`; flag the deprecated spec as historical
- "Database migrations" → update example to use v003 as the next addition (v002 is now the citations migration)
- "Critical invariants" → revise §3 to mention `trl_citations` does not participate in extension column shadow-detection (per A2 decision)
- Common issues → add: _"`citations` array empty on every read"_ → "rows pre-date v002; backfill or accept; the validator only enforces on new writes"

**D5. Update [README.md](README.md)**:

- Quick start: add `citations: [{ id: 'cit-1', episodeId: 'ep-1', sourceRef: 'chunk:1', excerpt: 'Source document excerpt...' }]` to the `writeAssertion` call
- New §Citations section: covers the requirement, the `AssertionCitation` shape, `writeCitation()` for late-arrived citations
- New §Trajectory mode subsection under Retrieval: shows `mode: 'trajectory'` + `supersessionChain`; documents `getEntityTrajectory()` distinct from `getEntityHistory()`
- §Schema extensions: fix pre-existing typo — change `columnName`/`columnDef` to `column`/`definition`, change `columns: ['col TEXT', 'col2 TEXT']` table-extension shape to `createSQL: 'CREATE TABLE...'` (matches the actual `TableExtension` interface)
- Update the _Migrations_ note: schema version is `2` after init
- Bump compatibility note: "Targets the v0.2 specification"

**D6. Verify build artefacts.** Run `npm run build && npm pack --dry-run`; confirm `dist/` includes the new types and the package layout is unchanged.

---

## Verification (end-to-end)

After implementation, run all of these from the repo root and expect green:

1. **Lint, typecheck, tests, build.**

   ```bash
   npm run lint && npm run typecheck && npm test && npm run build
   ```

2. **Coverage threshold check.**

   ```bash
   npm run test:coverage
   ```

   Lines/functions/statements ≥ 90 %, branches ≥ 75 %.

3. **Pack inspection.**

   ```bash
   npm pack --dry-run
   ```

   Confirms only `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json` ship.

4. **Spot-check via e2e test.** [test/integration/e2e.test.ts](test/integration/e2e.test.ts) "full happy path" must continue to pass after fixture updates. It is the executable acceptance test for the public surface.

5. **Migration upgrade path.** A purpose-built test in [test/integration/migrations.test.ts](test/integration/migrations.test.ts) seeds a v001-state database (apply only the first migration manually), inserts legacy citation-less rows directly via SQL, runs the full runner to upgrade, and confirms:
   - Schema version becomes 2
   - `trl_citations` exists and is empty
   - Reading the legacy rows returns `citations: []` without throwing
   - Writing a new assertion _with_ citations succeeds; writing one _without_ fails validation

6. **Manual smoke test.** Open a Node REPL with the built package:
   ```bash
   node --input-type=module -e "
   import('./dist/index.js').then(async ({ TemporalStore }) => {
     // ... write episode + assertion with citations + index + retrieve(mode:'trajectory') ...
   })
   "
   ```
   Confirm the public surface matches the v0.2 spec.

---

## Out of scope (deferred)

- A migration utility for _backfilling_ citations on legacy v0.1 data. Spec §Migration note says legacy rows remain valid with empty citations and the validator does not retroactively invalidate them; backfill is an application concern.
- Refactoring `SchemaExtensionApplier` to support extending `trl_citations`. The spec does not require it; deferred until a real use case appears.
- Performance characterisation of trajectory mode under deep chains. The recursive CTE has the same characteristics as the existing graph traversal; no benchmark gate added.
- Cross-namespace link semantics (already deferred per v0.1 §Future Design Considerations).

---

## Risks and notes for review

- **`replacedById` parameter ignored at the SQL layer** is a behavioural change for callers who relied on `supersedes_id` being set on the old assertion. Search results suggest no internal caller does — only the scenario fixture, which is updated. Downstream callers (if any) would need to migrate. Calling out explicitly in the changeset's BREAKING section.
- **Atomic supersession in `writeAssertion()`** assumes `old.valid_until === new.validFrom` is the desired window-end. For domains where the supersession is delayed (the new assertion arrives later in the timeline than the old one stops being valid), callers retain the explicit `supersedeAssertion(oldId, { validUntil })` escape hatch and pass `supersedesId: null` on the new assertion (or set the right `validUntil` post-write).
- **Citation id generation** uses caller-supplied ids on `writeCitation()` and `${assertionId}:c${index}` for inline `writeAssertion` citations. Document in dev guide; revisit if collisions appear.
- **Token-budget accuracy regression risk** in formatters — the citation marker adds ~10–40 chars per assertion. Tests assert that the inclusion is reflected in `tokenEstimate`.
