# Repository Guidelines

## Project Structure & Module Organization

`trageti` is a TypeScript library for temporally-aware RAG over SQLite. It manages episodic assertions with validity windows.

- **`src/`**: Contains core logic including the `TragetiStore`, schema migrations, and retrieval engine.
- **`test/`**: Divided into `unit` and `integration` tests. Integration tests verify interactions with `better-sqlite3` and `sqlite-vec`.
- **`_docs/`**: Holds specification documents like `_docs/specs/trageti-spec-v0.3.md`.

## Build, Test, and Development Commands

- **Build**: `npm run build` (uses `tsup`)
- **Typecheck**: `npm run typecheck`
- **Lint**: `npm run lint`
- **Format**: `npm run format`
- **All Tests**: `npm test`
- **Unit Tests**: `npm run test:unit`
- **Integration Tests**: `npm run test:integration`
- **Single Test**: `npx vitest run path/to/test.test.ts`
- **Coverage**: `npm run test:coverage`

## Coding Style & Naming Conventions

- **Tooling**: Enforced via ESLint and Prettier.
- **TypeScript**: Strict mode is enabled.
- **Naming**: Follows standard TypeScript camelCase for variables/functions and PascalCase for classes/interfaces.
- **Database**: Internal tables use the `trageti_` prefix (e.g., `trageti_assertions`, `trageti_schema_version`). The current v0.3 beta migration set is a single `v001` baseline; legacy `trl_` names survive only in historical docs, fixtures, and demo source material.

## Testing Guidelines

- Uses **Vitest** for testing.
- Integration tests require `better-sqlite3` and `sqlite-vec` to be available.
- Ensure 95% test coverage is maintained.

## Commit & Pull Request Guidelines

- Follows a direct and descriptive commit style (e.g., "Implement temporally-aware RAG over SQLite", "Add lint enforcement and expand test coverage to 95%").
- Uses **Changesets** for release management (`.changeset` directory).
- Every code or documentation change made by an agent must be committed before the task is considered complete. Do not leave created or modified files untracked or unstaged. If validation or follow-up work is still pending, commit after the coherent change is complete and clearly report any remaining validation gaps.
