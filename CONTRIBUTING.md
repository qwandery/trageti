# Contributing

## Setup

```bash
git clone https://github.com/qwandery/trageti.git
cd trageti
npm install
```

## Development workflow

```bash
npm run typecheck      # type check src + test
npm run lint           # eslint
npm run format         # prettier
npm run test:unit      # fast tests, no native deps required
npm run test:integration  # requires better-sqlite3 + sqlite-vec
npm run build          # tsup — produces dist/
```

## Pull requests

1. Branch from `develop`.
2. Add or update tests for your change.
3. Run `npx changeset` and describe the change.
4. Open a PR against `develop`.

## Changesets

This project uses [changesets](https://github.com/changesets/changesets) for versioning. Before opening a PR, add a changeset:

```bash
npx changeset
```

Choose `patch`, `minor`, or `major` and write a one-line description.

## Code style

- `prettier` for formatting (enforced in CI)
- `eslint` with `@typescript-eslint/strict` for linting
- No default exports — named exports only
- No comments explaining *what* code does — only *why* when non-obvious
