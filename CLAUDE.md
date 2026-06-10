# CLAUDE.md

Guidance for AI agents working in the **trageti** repository.

## Project

`trageti` is a TypeScript library for temporally-aware retrieval-augmented generation
over SQLite. It stores episodic assertions with explicit validity windows and retrieves
them by temporal position alongside semantic (vector) and full-text (BM25) similarity.
It is a single-package npm library; entry point `src/index.ts`, public facade
`TragetiStore` (`src/store/TragetiStore.ts`).

## Core Rules

1. **Plans include an "Invariants to Preserve" section** before any phase/task
   breakdown. List only task-relevant invariants — public API contracts, schema/data
   integrity, migration safety, error/log code contracts, spec decisions, backward
   compatibility, verification requirements — and for each, state how the implementation
   or verification preserves it. If an invariant is intentionally changed, call it out
   explicitly and name the affected docs, tests, and compatibility surfaces.

2. **Never overwrite an existing plan blind.** Read it first and summarize its contents,
   decisions, assumptions, and open risks. If replacing it is still right, state what is
   preserved, changed, and discarded.

3. **Karpathy-style engineering.** Keep solutions simple, explicit, and debuggable;
   prefer clear code over clever abstractions; build incrementally; verify with focused
   tests; use assertions and invariants (see the `INTERNAL_INVARIANT` error code) to
   catch impossible states; minimize hidden magic; optimize only after correctness is
   established; keep tight feedback loops through lint, typecheck, build, and tests.

4. **The spec is the source of truth.** The active spec is
   `_docs/specs/trageti-spec-v0.3.md`. Do not diverge from it unless an explicit spec
   amendment is part of the task. Any change must keep code, exported types, tests,
   `README.md`, `_docs/migration-v0.2-to-v0.3.md`, `CHANGELOG.md`/changesets, and
   `_docs/specs/trageti-spec-v0.3-verification.md` aligned.

5. **Preserve user work.** Do not revert unrelated changes. Inspect the relevant code
   and follow existing repository patterns before editing.

## Architecture & Contracts

- **Spec & verification** — `_docs/specs/trageti-spec-v0.3.md` is the contract;
  `_docs/specs/trageti-spec-v0.3-verification.md` maps every invariant to its
  implementation and test. Update the verification matrix when you change a verified
  surface.
- **Error & log codes** — stable `ErrorCode` values live in `src/errors/`; `TRGT_`-
  prefixed log codes live in `src/internal/logger.ts`. Both are public contract: do not
  rename or repurpose existing codes — add new ones instead.
- **Migrations** — `src/db/migrations/v00N_*.ts`, applied by `runner.ts`. The current
  v0.3 beta ships one `v001` baseline migration; future migrations must be
  append-only and idempotent once shipped. Live tables use the `trageti_` prefix.
- **Coverage gate** — lines/functions/statements 95%, branches 85% (`vitest.config.ts`).
  Keep it green.

## Commits

- Commit regularly — after each meaningful, working code edit, not in one large batch.
- Do **not** open pull requests; leave PR creation to the maintainer.
- Commit subjects are descriptive and scoped — match the existing
  `v0.3 remediation RN: <summary>` / `v0.3 phase N: <summary>` style.
- See `CONTRIBUTING.md` and `AGENTS.md` for branching, changesets, build, and test.
