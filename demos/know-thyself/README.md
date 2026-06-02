# know-thyself

_trageti ingests its own development history and answers questions about its own evolution._

This demo ingests reviewed source documents generated from ten `trageti`
keyframe commits, from the v0.1 implementation through v0.3 remediation and
polish. It exercises ingestion, indexing, retrieval, trajectory display, graph
expansion, assembled-context query answers, final narrative synthesis, and a
temporal snapshot against committed keyframe fixtures.

## Run

```sh
npx tsx demos/know-thyself/index.ts
```

With a live embedding provider configured, replace the built-in query suite with
one custom user query:

```sh
npx tsx demos/know-thyself/index.ts --query "How did retrieval determinism improve over time?"
```

Custom-query mode prints one retrieval result and one assembled-context answer.
It skips the built-in queries, temporal snapshot, and final narrative synthesis.
It is not supported in deterministic fixture/raw-vector mode because committed
fixture vectors only cover the built-in demo query texts.

With no provider env vars, the demo runs fully offline using committed fixtures,
deterministic vectors, and deterministic assembled-context synthesis.

Runtime databases are written to `demos/.local/`. Each DB records demo data and
provider provenance. If you change extraction provider, embedding provider,
model, embedding dimension, or committed demo data, delete the matching DB and
rerun.

## Provider Configuration

The demos load `.env` via `dotenv`; copy `.env.example` to `.env` for local
configuration. Extraction and embedding are separate capabilities:

| Variable                                        | Meaning                                            |
| ----------------------------------------------- | -------------------------------------------------- |
| `DEMO_EXTRACT_PROVIDER`                         | `fixture`, `anthropic`, or `openai-compatible`     |
| `DEMO_EMBED_PROVIDER`                           | `fixture`, `openai-compatible`, or `ollama-native` |
| `DEMO_EXTRACT_BASE_URL` / `DEMO_EMBED_BASE_URL` | Provider base URLs                                 |
| `DEMO_EXTRACT_MODEL` / `DEMO_EMBED_MODEL`       | Provider-specific model names                      |
| `DEMO_EMBED_DIMENSION`                          | Embedding dimension; defaults to `768`             |

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

The demo runs six retrieval queries, an assembled-context answer after each
retrieval query, one temporal snapshot, and a final narrative synthesis:

1. Current retrieval result contract.
2. Temporal model evolution via trajectory mode.
3. Citation provenance evolution via trajectory mode.
4. Data-integrity behavior with linked migration context.
5. Vectorless namespace and embedding-provider changes.
6. Retrieval determinism and graph-ordering refinements.
7. The v0.1 temporal model via `getTemporalSnapshot`.
8. A final assembled-context synthesis of the library's evolution and current
   design.

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
