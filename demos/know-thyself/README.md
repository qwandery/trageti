# Demo: Trageti, Know Thyself

_A repository-history demo that can explain how a codebase evolved._

By default, this demo ingests this repository's own default Trageti keyframe
commits. Source documents, episodes, citation sources, fixture extraction, and
fixture vectors are derived at runtime from git. You can also point it at
another repo with an explicit keyframe list when live providers are configured.

## Run

```sh
npx tsx demos/know-thyself/index.ts
```

Run against another repository:

```sh
npx tsx demos/know-thyself/index.ts --repo ../some-repo --keyframes abc123,def456,789abcd
```

Replace the default query suite with one custom user query:

```sh
npx tsx demos/know-thyself/index.ts --query "What changed about persistence?"
npx tsx demos/know-thyself/index.ts --repo ../some-repo --keyframes abc123,def456 --query "What changed about persistence?"
```

Custom-query mode prints one retrieval result and one assembled-context answer.
It skips the built-in queries, temporal snapshot, and final narrative synthesis.
When using live providers, throttle calls with `--limit <seconds>`:

```sh
npx tsx demos/know-thyself/index.ts --limit 60
```

With no provider env vars, the default run works offline. Fixture mode derives
source summaries, extraction output, and hash vectors deterministically from the
default repo/keyframes. Fixture mode is not supported when `--repo` or
`--keyframes` is supplied; custom repo/keyframe runs require live extraction and
live embedding providers.

When live provider env vars are present, the no-arg run uses live mode. To force
offline fixture mode in that environment:

```sh
DEMO_EXTRACT_PROVIDER=fixture DEMO_EMBED_PROVIDER=fixture npx tsx demos/know-thyself/index.ts
```

Runtime databases are written to `demos/.local/know-thyself/<run-hash>.db`.
The run hash includes the absolute repo path, resolved keyframe commits,
provider provenance, fixture/live mode, and query text set, so different
repo/keyframe/provider combinations do not reuse the same SQLite file.
Live source summaries are cached under `demos/.local/know-thyself/` using the
repo, commits, provider provenance, and source input, so interrupted live runs
can reuse completed summary work.

## Provider Configuration

The demos load `.env` via `dotenv`; copy `.env.example` to `.env` for local
configuration. Extraction and embedding are separate capabilities:

| Variable                                                     | Meaning                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------- |
| `DEMO_EXTRACT_PROVIDER`                                      | `fixture`, `anthropic`, or `openai-compatible`          |
| `DEMO_EMBED_PROVIDER`                                        | `fixture`, `openai-compatible`, or `ollama-native`      |
| `DEMO_EXTRACT_BASE_URL` / `DEMO_EMBED_BASE_URL`              | Provider base URLs                                      |
| `DEMO_EXTRACT_MODEL` / `DEMO_EMBED_MODEL`                    | Provider-specific model names                           |
| `DEMO_EMBED_DIMENSION`                                       | Embedding dimension; required for live custom runs      |
| `DEMO_RATE_LIMIT`                                            | Seconds between live provider requests; defaults to `5` |
| `DEMO_PROVIDER_MAX_ATTEMPTS`                                 | Retry attempts for live HTTP provider calls             |
| `DEMO_PROVIDER_BASE_DELAY_MS` / `DEMO_PROVIDER_MAX_DELAY_MS` | Retry backoff bounds                                    |

Convenience env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, `OLLAMA_HOST`) are mapped into explicit providers, but the
demo does not infer that any named service supports both extraction and
embedding. Configure both capabilities for live custom repo/keyframe runs.
Live provider calls are serialized through the shared rate limiter and retry
`429`, `408`, and `5xx` responses with backoff. Waits are printed without
exposing prompts or credentials.

## What It Shows

For each keyframe, the demo derives a citation-grade source document from git
metadata, diff stats, selected diffs, and selected file snapshots. Episodes are
temporal summaries over those generated source documents, and citations point
back into the generated source text by character offsets.

The default query suite is repository-agnostic:

1. Important changes across keyframes.
2. Architecture evolution via trajectory mode.
3. Data model or persistence changes.
4. Retrieval, query, or interface behavior changes.
5. Risks, regressions, or reversals.
6. Testing, validation, or release-readiness evolution.
7. The initial keyframe via `getTemporalSnapshot`.
8. A final assembled-context synthesis of repository evolution and current
   design.

Fixture vectors are deterministic hash vectors, not semantically meaningful.
Use live embedding providers for meaningful semantic ranking.

## Review Utilities

```sh
npx tsx demos/know-thyself/generate-episodes.ts --context-length 32000
npx tsx demos/know-thyself/generate-fixtures.ts
```

`generate-episodes.ts` writes reviewable generated source documents under
`demos/.local/know-thyself/sources/<hash>/`. `generate-fixtures.ts` writes
review extraction/embedding files under `demos/.local/know-thyself/`. These
utilities no longer update committed seed data.
