# Review of Claude Code’s Trageti v0.2 Implementation Plan

## Executive Summary

Claude Code’s v0.2 implementation plan is strong and substantially repo-aware. It correctly identifies the main v0.2 work areas from `_docs/specs/trageti-spec-v0.2.md`: citations, trajectory retrieval mode, and `getEntityTrajectory()`. It also catches a critical existing supersession-direction problem that must be addressed for trajectory mode to work correctly.

However, the plan also makes several implementation decisions that go beyond the v0.2 spec and should be treated as explicit design choices rather than assumed requirements. The most important examples are automatic supersession inside `writeAssertion()` and ignoring `replacedById` in `supersedeAssertion()`. Both may be defensible, but they need sharper specification, compatibility notes, and tests.

There are also a few concrete gaps and inconsistencies in the plan:

- It does not explicitly handle `deleteNamespace()` cleanup for `trl_citations`.
- It has an internal inconsistency around whether `trl_citations` belongs in `LIBRARY_COLUMNS`.
- It proposes manually bumping `package.json`, which appears to conflict with the repo’s changeset-driven release workflow.
- It does not fully resolve the v0.2 spec’s ambiguity around the write-time shape of inline citations.
- It under-specifies formatter behavior for trajectory-mode context assembly.
- It should more explicitly resolve the spec-level tension between `supersedesId` and `replacedById`.

Overall: the plan is a very good foundation, but it should be tightened before implementation so that v0.2 is both spec-compliant and internally coherent.

---

# Major Strengths

## 1. Correctly identifies the core v0.2 surface area

Claude Code correctly identifies the three major v0.2 changes:

1. Citations are now first-class and required on new assertions.
2. Retrieval and context assembly gain `mode: 'snapshot' | 'trajectory'`.
3. `getEntityTrajectory()` is added and distinguished from `getEntityHistory()`.

This matches the spec’s changelog and API sections.

## 2. Correctly catches the current supersession-direction bug

This is the most important contribution in Claude’s plan.

The current implementation updates the old assertion’s `supersedes_id` when calling `supersedeAssertion()`:

```sql
UPDATE trl_assertions
SET valid_until = ?, supersedes_id = COALESCE(?, supersedes_id)
WHERE id = ?
```

But the v0.2 spec defines `supersedesId` on an assertion as:

> the assertion this replaces

That means the new assertion points backward to the prior assertion.

Trajectory retrieval in v0.2 also depends on this direction. Step 7 walks backward from the retrieved assertion through `supersedes_id` to collect prior versions. If the old assertion points forward instead, that traversal is broken.

Claude is right that this must be corrected or explicitly accounted for. A v0.2 implementation that adds `supersessionChain` without fixing this semantic mismatch would likely produce incomplete or empty chains.

## 3. Good migration and legacy-data test coverage

Claude’s migration test plan is strong:

- Fresh DB ends at version 2.
- `trl_citations` table exists.
- `trl_idx_citations_assertion` exists.
- Running migrations twice is idempotent.
- A v001 database upgrades to v002 cleanly.
- Legacy citation-less assertions remain readable as `citations: []`.

That last case is especially important because the v0.2 spec explicitly says existing prototype rows remain valid and are not retroactively invalidated.

## 4. Good distinction between history and trajectory

Claude’s plan correctly emphasizes that:

- `getEntityHistory()` returns all assertions for an entity.
- `getEntityTrajectory()` follows supersession chains specifically.
- Trajectory retrieval mode performs semantic retrieval first, then attaches chain history only for matched results.

The proposed test where an entity has both a supersession chain and an unrelated parallel assertion is exactly the right way to prove the distinction.

## 5. Good citation test surface

The proposed `citations.test.ts` coverage is broadly correct:

- Missing citations reject.
- Nonexistent citation episode rejects.
- Empty `sourceRef` rejects.
- Null excerpt warns but succeeds.
- Multiple citations round-trip.
- Metadata round-trips.
- Read paths return populated citations.
- Legacy rows return `citations: []`.

That covers the most important behavioral contract.

## 6. Good recognition that formatter token budgets change

Adding citation markers changes output length. Claude correctly calls out that formatter token estimation must include citation markers. That is a subtle but real regression risk.

---

# Key Issues and Recommended Corrections

## 1. The plan should explicitly resolve the `supersedesId` / `replacedById` spec tension

The v0.2 spec contains a real modeling tension:

- `Assertion.supersedesId` means “the assertion this assertion replaces.”
  That is new -> old.
- `supersedeAssertion(assertionId, { replacedById })` says `replacedById` is “the replacing assertion.”
  That is old -> new.
- The schema only has one column: `supersedes_id`.

Those cannot all be represented by the same column.

Claude’s plan implicitly resolves this by making `supersedes_id` new -> old and ignoring `replacedById` at the SQL layer. That is probably the correct choice for v0.2 trajectory mode, but it needs to be documented as an explicit design decision.

Recommended revision:

- Treat `trl_assertions.supersedes_id` as strictly new -> old.
- `writeAssertion({ supersedesId })` persists that backward pointer.
- `supersedeAssertion(assertionId, { validUntil, replacedById })` updates only `valid_until`.
- `replacedById` may be validated for namespace compatibility but is not persisted.
- Document that `replacedById` is currently informational/compatibility-only because v0.2 has no `replaced_by_id` column.
- Add a future-design note that a forward pointer would require a separate column or link.

This should be called out in README/dev docs and changeset because existing consumers may have inferred old -> new semantics from the prototype behavior.

## 2. Automatic supersession in `writeAssertion()` goes beyond the v0.2 spec

Claude proposes:

> when `writeAssertion()` is called with a non-null `supersedesId`, wrap insert and implicit `supersedeAssertion(supersedesId, { validUntil: new.validFrom })` in a single transaction.

This is a reasonable product decision, but it is not clearly required by the v0.2 spec.

The spec’s write API still lists separate methods:

```ts
store.writeAssertion(...)
store.supersedeAssertion(...)
```

And it describes `supersedeAssertion()` as the method that marks an existing assertion as superseded.

Auto-closing the old assertion when a new assertion references it changes behavior. It also makes `writeAssertion()` more than a pure insert. That may be good, but the plan should not treat it as a spec requirement.

Recommended revision:

Choose one policy explicitly:

### Conservative spec-aligned option

- `writeAssertion()` persists the new assertion and its citations.
- If `supersedesId` is provided, it creates the backward chain pointer only.
- Caller still calls `supersedeAssertion()` to close the predecessor’s validity window.
- Trajectory mode can still work as long as the new assertion points backward.

### Stronger invariant option

- `writeAssertion()` with `supersedesId` automatically sets predecessor `validUntil = new.validFrom`.
- This provides atomic chain creation and validity-window closure.
- This is a deliberate v0.2 implementation policy beyond the minimum spec.
- Existing explicit `supersedeAssertion()` calls must remain idempotent or predictable.

If choosing the stronger option, document it prominently and test:

- predecessor validUntil is set atomically;
- explicit later `supersedeAssertion()` either rewrites the same value or intentionally overrides it;
- errors roll back both assertion and citations;
- replacement across namespace is rejected;
- invalid predecessor ID rejects.

Claude’s plan chooses the stronger option, but it should frame that as a design choice and compatibility-affecting behavior.

## 3. `deleteNamespace()` must delete citations or use cascade FKs

Claude’s proposed citation table DDL:

```sql
CREATE TABLE IF NOT EXISTS trl_citations (
  id              TEXT PRIMARY KEY,
  assertion_id    TEXT NOT NULL REFERENCES trl_assertions(id),
  episode_id      TEXT NOT NULL REFERENCES trl_episodes(id),
  ...
);
```

No `ON DELETE CASCADE` is specified.

The current `deleteNamespace()` deletes links, assertions, episodes, and namespace. With foreign keys enabled, deleting assertions while citations still reference them will fail.

The implementation plan must include one of:

### Option A: Explicit deletion

Inside `deleteNamespace()` transaction, before deleting assertions:

```sql
DELETE FROM trl_citations
WHERE assertion_id IN (
  SELECT id FROM trl_assertions WHERE namespace = ?
)
```

Then delete links/assertions/episodes/namespaces.

### Option B: Cascading FKs

Define citation FKs as:

```sql
assertion_id TEXT NOT NULL REFERENCES trl_assertions(id) ON DELETE CASCADE
episode_id   TEXT NOT NULL REFERENCES trl_episodes(id) ON DELETE CASCADE
```

Then deletion order matters less.

Given the existing schema does not use cascading deletes elsewhere, explicit deletion may fit the current style better.

This is a required addition to the plan.

## 4. The `LIBRARY_COLUMNS` / `LibraryTable` recommendation is internally inconsistent

Claude’s file list says:

> `src/db/schema/columns.ts` — add `trl_citations` to `LIBRARY_COLUMNS`; add table-name constant for shadow checks

But A2 later recommends:

> do not add `trl_citations` to `LibraryTable` for v0.2

Currently `LIBRARY_COLUMNS` is typed as:

```ts
Readonly<Record<LibraryTable, readonly string[]>>
```

And `LibraryTable` is:

```ts
'trl_assertions' | 'trl_episodes' | 'trl_links'
```

So adding `trl_citations` to `LIBRARY_COLUMNS` while leaving `LibraryTable` unchanged will not typecheck.

Recommended revision:

- Do not add `trl_citations` to `LIBRARY_COLUMNS` if citation schema extensions are out of scope.
- Keep `LibraryTable` unchanged.
- If a reserved-table list is needed, add a separate internal constant, for example:

```ts
export const LIBRARY_TABLE_NAMES = [
  'trl_namespaces',
  'trl_episodes',
  'trl_assertions',
  'trl_links',
  'trl_citations',
  'trl_fts',
  'trl_schema_version',
] as const
```

Also note Claude’s proposed list accidentally includes `trl_links` twice.

## 5. The write-time citation input shape needs a precise public API decision

The v0.2 spec says:

```ts
interface Assertion {
  ...
  citations: AssertionCitation[]
}

store.writeAssertion(assertion: Omit<Assertion, 'createdAt'>): Assertion
```

But `AssertionCitation` itself includes:

```ts
id: string
assertionId: string
createdAt: string
```

If `writeAssertion()` literally accepts `Omit<Assertion, 'createdAt'>`, then inline citations would still require nested `createdAt`, and likely `assertionId`. That is awkward.

Claude proposes validator input like:

```ts
Omit<Assertion, 'createdAt' | 'extensions' | 'citations'> & {
  citations: Omit<AssertionCitation, 'id' | 'assertionId' | 'createdAt'>[]
}
```

And later proposes deterministic citation IDs for inline citations.

This needs a single coherent choice.

Recommended public/internal type design:

```ts
export type NewAssertionCitation =
  Omit<AssertionCitation, 'assertionId' | 'createdAt'>

export type NewAssertion =
  Omit<Assertion, 'createdAt' | 'extensions' | 'citations'> & {
    citations: NewAssertionCitation[]
  }
```

or, if inline citation IDs should be generated:

```ts
export type NewAssertionCitation =
  Omit<AssertionCitation, 'id' | 'assertionId' | 'createdAt'> & {
    id?: string
  }
```

Then:

```ts
writeAssertion(assertion: NewAssertion): Assertion
writeCitation(citation: Omit<AssertionCitation, 'createdAt'>): AssertionCitation
```

This is cleaner than embedding complex `Omit<>` expressions directly into validator signatures.

If generated IDs are allowed, document the policy. If caller-supplied IDs are required, update tests/examples accordingly.

## 6. Citation ID generation must be collision-safe

Claude recommends generating inline citation IDs like:

```ts
${assertionId}:c${index}
```

This is deterministic and debuggable, but it has collision implications:

- If an assertion is retried after partial failure, deterministic IDs are fine if the transaction rolls back fully.
- If `writeCitation()` later uses the same ID convention manually, it can collide.
- If duplicate inline citations are ever reinserted for the same assertion, collisions occur.

Because `writeAssertion()` should be transactional, the partial-write issue is manageable. Still, the plan should say:

- Inline citation IDs are generated only when omitted.
- Caller-supplied inline citation IDs are accepted or rejected, depending on chosen API.
- Generated IDs are unique within the assertion by array index.
- Duplicate caller-supplied citation IDs fail with SQLite PK violation or validation error.

Alternatively, require caller-supplied IDs everywhere, which more directly matches the spec.

## 7. Citation namespace integrity is enforced by validation, not schema

The proposed schema has:

```sql
assertion_id REFERENCES trl_assertions(id)
episode_id REFERENCES trl_episodes(id)
```

That ensures both records exist, but not that the citation episode belongs to the same namespace as the assertion.

The spec requires:

> each citation's `episodeId` exists in the namespace

A validator can enforce this on library writes, but direct SQL can violate it.

The plan should explicitly say:

- `DefaultAssertionValidator` checks citation episodes in the assertion namespace.
- `writeCitation()` also checks the target assertion and citation episode share a namespace.
- The database schema does not enforce cross-table namespace equality.
- This is consistent with current library assumptions because callers should write through `TemporalStore`.

If stronger DB enforcement is desired, schema would need composite keys or namespace duplicated onto citations. That would be more invasive and is not required by v0.2.

## 8. Formatter behavior for trajectory mode is under-specified

Claude specifies citation markers for Prose and Structured formatters and full citations for JSON. Good.

But trajectory mode introduces `supersessionChain`, and formatter behavior is not fully specified.

The v0.2 spec says:

- `ContextFormatter` receives citations as part of `RetrievedAssertion`.
- `ProseFormatter` includes compact citation markers.
- `RetrievedAssertion.supersessionChain` is populated only in trajectory mode.

It does not explicitly say how default formatters should render supersession chains.

The plan should choose one:

### Minimal behavior

- Default Prose/Structured formatters render only top-level retrieved assertions.
- `supersessionChain` remains available in `AssembledContext.assertions`.
- JSON formatter includes `supersessionChain` because it serializes structured payload.

### Rich trajectory behavior

- Prose/Structured include prior versions under the matched assertion when `supersessionChain` is present.
- Each prior version includes its own compact citation marker.
- Token budget accounts for both top-level assertions and chain entries.

The second is more useful for trajectory context, but also more complex and more likely to affect token-budget truncation. The plan should not leave this implicit.

## 9. `supersessionChain` inclusion/exclusion should be explicitly tested

The spec says:

> Contains all prior versions of the assertion in chronological order, oldest first

So `supersessionChain` should exclude the retrieved/current assertion.

Claude notices this in B2, but A5 says `getSupersessionChain(assertionId)` returns the full chain including the given assertion. That is fine internally, but the plan must clearly state:

- Repository helper may return full chain including current.
- Retrieval `supersessionChain` must exclude the result itself.
- `getEntityTrajectory()` returns the full entity chain including current.

Tests should verify this distinction.

## 10. `getEntityTrajectory()` behavior with multiple active leaves needs a clear policy

Claude says:

> Return all chains found, one per leaf if multiple are active.

But the public API returns:

```ts
Assertion[]
```

not grouped chains.

If there are multiple current assertions for the same entity, flattening all chains into one `Assertion[]` can interleave or duplicate prior assertions.

The plan should define:

- How active leaves are selected.
- Whether duplicate assertions are de-duplicated.
- Sort order across multiple chains.
- Whether multiple active chains are even considered valid data.

A practical policy:

- Find all assertions for the entity that are not superseded by another assertion in the same entity chain.
- For each leaf, walk backward.
- Merge results by ID to avoid duplicates.
- Sort by `validFrom ASC`, then `createdAt ASC`, then `id ASC`.

Or, if the API should represent multiple chains distinctly, v0.2’s `Assertion[]` return type is insufficient and should not be changed without spec revision.

## 11. Retrieval scorer candidate placeholder remains a pre-existing issue

Current retrieval constructs:

```ts
const candidate: ScoredCandidate = {
  assertion: {} as Assertion,
  ...
}
```

The v0.2 spec says the scorer receives:

```ts
assertion: Assertion
```

Claude does not address this. It is not introduced by v0.2, but citations make it more important because `Assertion` now has required `citations`.

A comprehensive v0.2 plan should consider whether to fix this while touching retrieval:

- Fetch/hydrate assertions before scoring so custom scorers receive real assertions.
- Or document that scorer currently cannot rely on `candidate.assertion`, which would deviate from the spec.

Spec compliance argues for fixing it. Performance cost is limited to oversampled candidates and can be handled with batch fetch.

This is a worthwhile addition to the plan.

## 12. BM25 normalization may conflict with scorer contract

The spec says the scorer receives raw signal values and normalization is the scorer’s responsibility. Current code normalizes BM25 before passing it to the scorer:

```ts
// Min-max normalise BM25 scores to [0, 1] over the candidate set
bm25Map.set(row.assertion_id, 1 - normalised)
```

Claude’s plan does not mention this. It is not a v0.2 change, but the v0.2 spec restates the scorer contract.

A comprehensive “bring library in line with v0.2 spec” plan should include this discrepancy:

- Either change retrieval to pass raw BM25 scores into `scoreComponents` and `ScoredCandidate`.
- Move normalization into `DefaultScorer`.
- Update tests accordingly.

This may be outside the citation/trajectory headline changes, but it is a spec-alignment issue.

## 13. Retrieval Step 1 include-superseded condition may not match spec

The spec’s Step 1 has:

```sql
AND (:includeSuperseded = 1 OR a.supersedes_id IS NULL OR a.valid_until IS NULL)
```

Current code adds:

```sql
if (!query.includeSuperseded) {
  conditions.push('a.valid_until IS NULL')
}
```

Given the temporal validity filter already excludes rows whose `valid_until <= temporalAnchor`, this distinction matters mainly for rows with `valid_until IS NULL` but `supersedes_id IS NOT NULL` under the corrected new->old model. A replacement/current assertion will usually have `supersedes_id` non-null and `valid_until IS NULL`; current code includes it because `valid_until IS NULL`.

So behavior may be okay, but the SQL no longer matches the spec’s documented condition. The plan should at least review this after correcting supersession semantics.

## 14. Manual package version bump may conflict with release workflow

Claude proposes:

- Add changeset.
- Manually bump `package.json` to `0.2.0`.
- Update `CHANGELOG.md`.

The repo’s dev guide says changesets manage version bumps and changelog generation through the Version Packages PR. In that workflow, normal feature PRs add a changeset but do not directly edit `package.json` or `CHANGELOG.md`.

Recommended revision:

- Add `.changeset/v0.2-citations-and-trajectory.md`.
- Do not manually bump `package.json` or `CHANGELOG.md` unless the maintainer explicitly wants to perform the versioning PR manually.
- If the implementation PR is intended to be the release PR, then manual version/changelog edits may be okay, but that should be explicit.

## 15. Renaming `trageti-spec-v0.1.md` may be unnecessary churn

Claude proposes renaming:

```text
trageti-spec-v0.1.md -> trageti-spec-v0.1-DEPRECATED.md
```

This may be useful, but it is not required to implement v0.2 and could break references. A lower-risk option:

- Leave `trageti-spec-v0.1.md` in place.
- Add a deprecation banner at the top.
- Update `_docs/dev/README.md` and README references to point to `_docs/specs/trageti-spec-v0.2.md`.

Only rename if the repo owner explicitly wants historical spec filenames to encode deprecation.

## 16. Warning-code naming should be consistent

Claude uses:

```ts
CITATION_NULL_EXCERPT
```

An alternative name is:

```ts
CITATION_EXCERPT_MISSING
```

Either is fine, but the plan should pick one and use it consistently across:

- validator;
- tests;
- docs;
- dev guide;
- common issues.

The warning payload must use only IDs/operational metadata, never excerpt/source content.

## 17. Structured logger does not need code registration

Claude says:

> `src/internal/logger.ts` — add `CITATION_NULL_EXCERPT` warning code

But `structuredWarn()` currently accepts arbitrary string codes and has no registry. Unless the implementation adds a warning-code enum, no logger change is required.

Recommended revision:

- Do not modify `logger.ts` unless introducing a typed warning-code union.
- Simply call `structuredWarn('CITATION_NULL_EXCERPT', { assertionId, citationId })`.

## 18. Plan should specify exact citation read hydration strategy

Claude says eager batch fetching is preferred. Good, but the plan should be explicit enough to prevent N+1 issues:

- `getById()` can do one assertion query plus one citation query.
- `query()` should fetch rows, collect assertion IDs, batch fetch citations with `json_each(?)`, then attach arrays.
- `getEntityHistory()` same.
- `getSupersessionChain()` should fetch all chain rows and batch fetch citations.
- Retrieval should not fetch citations one-by-one after ranking if a batch helper is available.

Also define legacy behavior:

- If no citations exist for an assertion row, return `citations: []`.
- For newly written rows this should only happen if data was inserted outside the validator.

## 19. Citation metadata parsing failure should be considered

The plan says metadata JSON round-trips, but not what happens if stored metadata is malformed due to direct SQL or old data.

Options:

- Throw on malformed metadata.
- Return `{}` and warn.
- Return raw string under a reserved key.

Since metadata is caller-defined and library-managed writes should always use JSON, throwing is acceptable but should be tested or documented. A robust repository parser could catch and wrap errors in a `TragetiError`, but that may be overkill.

## 20. Tests need a helper for citation fixtures

Claude mentions a possible `defaultCitation(epId)` helper. This should be made explicit because every current `writeAssertion()` call will break.

Recommended helper:

```ts
export function citationFor(assertionId: string, episodeId: string, sourceRef = 'chunk:1') {
  return {
    id: `${assertionId}:c0`,
    episodeId,
    sourceRef,
    excerpt: null,
  }
}
```

Depending on chosen write input shape, omit `assertionId` or include it.

This keeps fixture churn smaller and makes tests easier to read.

---

# Recommended Amendments to Claude’s Plan

## Add a “Spec Ambiguities Resolved” section

Before implementation phases, add:

1. `supersedes_id` stores new -> old only.
2. `replacedById` is validated but not persisted.
3. Inline citations in `writeAssertion()` use a precise input type.
4. Generated citation IDs are/are not supported.
5. Default formatters do/do not render `supersessionChain`.

This will make the plan decision-complete.

## Add `deleteNamespace()` citation cleanup

In Phase A or store changes:

- Delete citations for namespace assertions before deleting assertions.
- Add an integration test proving `deleteNamespace()` works with citations and FK enabled.

## Fix the `LIBRARY_COLUMNS` section

Replace A2 with:

- Keep `LibraryTable` unchanged.
- Keep `LIBRARY_COLUMNS` unchanged unless citation schema extensions are explicitly supported.
- Optionally add an internal reserved table-name list including `trl_citations`.

## Replace manual version bump with changeset-only unless release PR

In Phase D:

- Add changeset.
- Update README/dev docs.
- Do not edit package version/changelog manually unless this is explicitly the release/versioning PR.

## Add scorer-contract review

Since the work is “bring library in line with v0.2 spec,” add a task to review and likely fix:

- `ScoredCandidate.assertion` placeholder.
- BM25 raw vs normalized score contract.

These are not citation-specific, but they are spec-alignment issues.

## Add precise transaction tests

For transactional write behavior:

- If citation insert fails, assertion is not inserted.
- If implicit supersession update fails, assertion and citations are not inserted.
- If validator fails, nothing is inserted.
- If explicit `supersedeAssertion()` fails, no partial state changes.

## Add formatter trajectory decision

If default Prose/Structured should include chains, specify output format. Example:

```text
Current: Delta has been revised. [ep-2#chunk:1]
History:
- Delta was once active. [ep-1#chunk:1]
```

If not, explicitly say only JSON exposes chain details in formatted text, while all formatters still return full assertions through `AssembledContext.assertions`.

---

# Final Assessment

Claude Code’s plan is a strong implementation plan and catches a critical bug that should not be ignored: the current supersession direction is incompatible with v0.2 trajectory retrieval.

The plan should be revised before execution mainly to separate three categories:

1. **Required by v0.2 spec**
   - citations table;
   - required citations on new writes;
   - citation hydration on reads;
   - retrieval/context `mode`;
   - `supersessionChain`;
   - `getEntityTrajectory()`;
   - Prose citation markers.

2. **Required to make v0.2 actually work**
   - fix `supersedes_id` direction;
   - add chain traversal helpers;
   - update tests/fixtures;
   - migration compatibility with citation-less rows;
   - delete citations during namespace deletion.

3. **Additional behavior changes**
   - auto-supersession inside `writeAssertion()`;
   - ignoring/deprecating `replacedById`;
   - generated citation IDs;
   - rendering trajectory chains in default prose/structured formatters;
   - package version bump/changelog edits.

The first two categories should be implemented. The third category may also be implemented, but only after being made explicit and tested as deliberate policy rather than silently bundled into the v0.2 spec work.
