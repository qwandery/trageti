# know-thyself

*trageti ingests its own development history and answers questions about its own evolution.*

This demo ingests reviewed source documents generated from `trageti` keyframe
commits. It exercises ingestion, indexing, retrieval, trajectory display, and a
temporal snapshot against committed keyframe fixtures.

## Run

```sh
npx tsx demos/know-thyself/index.ts
```

With no provider env vars, the demo runs fully offline using committed fixtures
and deterministic vectors.

Runtime databases are written to `demos/.local/`. Each DB records demo data and
provider provenance. If you change extraction provider, embedding provider,
model, embedding dimension, or committed demo data, delete the matching DB and
rerun.

## Provider Configuration

The demos load `.env` via `dotenv`; copy `.env.example` to `.env` for local
configuration. Extraction and embedding are separate capabilities:

| Variable | Meaning |
|---|---|
| `DEMO_EXTRACT_PROVIDER` | `fixture`, `anthropic`, or `openai-compatible` |
| `DEMO_EMBED_PROVIDER` | `fixture`, `openai-compatible`, or `ollama-native` |
| `DEMO_EXTRACT_BASE_URL` / `DEMO_EMBED_BASE_URL` | Provider base URLs |
| `DEMO_EXTRACT_MODEL` / `DEMO_EMBED_MODEL` | Provider-specific model names |
| `DEMO_EMBED_DIMENSION` | Embedding dimension; defaults to `768` |

Convenience env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, `OLLAMA_HOST`) are mapped into explicit providers, but the
demo does not infer that any named service supports both extraction and
embedding. Configure both capabilities for live runs.

To inspect model boundaries while running the demo, set
`DEMO_LLM_TRACE=summary`. To print full prompts, responses, embedding inputs,
and vector summaries, set `DEMO_LLM_TRACE=full`. The `--llm-trace` flag is
equivalent to summary mode.

## What It Shows

The demo source documents live in `data/sources/`. They include commit
metadata, full `git diff --stat` output, selected important diffs or snapshots,
and a reviewable summary of what changed. Episodes are temporal summaries over
those source documents; citations point into the committed source documents via
offsets.

The demo runs three retrieval queries and one temporal snapshot:

1. Current scoring formula.
2. Temporal model evolution via trajectory mode.
3. Data-integrity behavior with score component display.
4. The v0.1 temporal model via `getTemporalSnapshot`.

Fixture vectors are deterministic hash vectors, not semantically meaningful.
Use `generate-fixtures.ts` with a real embedding provider to regenerate
semantic vectors.

## Regeneration Workflow

```sh
npx tsx demos/know-thyself/generate-episodes.ts --context-length 32000
npx tsx demos/know-thyself/generate-fixtures.ts
```

`generate-episodes.ts` writes proposed source documents to
`demos/.local/know-thyself/sources/` for review. Reviewed source documents are
committed under `data/sources/`; fixture generation uses the same source-span
validation as runtime ingestion.
