# alex-place

_An aspiring chef's personal journal as a temporal RAG corpus._

This demo turns Alex's journal and fictional food-science notes into dated
episodes, extracted assertions, typed links, source-grounded citations, vector
indexes, temporal retrieval, graph expansion, sparse entity lookup, and
assembled-context narrative synthesis.

## Run

```sh
npx tsx demos/alex-place/index.ts
```

With no provider env vars, the demo runs fully offline using committed fixtures,
deterministic vectors, and a pre-written narrative synthesis.

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

The demo ingests twenty temporal slices covering sourdough, ramen broth, knife
skills, dinner feedback, Maillard browning, noodles, kimchi, Mrs. Park's advice,
Jordan's feedback, and sparse Dad references. Episodes are summaries; citations
are derived from source spans in `alex.md` and `data/references/*`, not from LLM
supplied excerpts. It then runs:

1. A current sourdough snapshot query.
2. A paired early-vs-current sourdough snapshot query.
3. Sourdough, ramen, dinner-feedback, knife-skill, unresolved-question, and
   Mrs. Park queries.
4. A semantic literature query with graph expansion enabled, so linked
   assertions appear when extraction stored typed links.
5. A semantic Dad query followed by `getEntityHistory` for the entity ID
   surfaced by retrieval, when one exists.
6. An assembled-context narrative synthesis pass.

Fixture vectors are deterministic hash vectors, not semantically meaningful.
Use `generate-fixtures.ts` with a real embedding provider to regenerate
semantic vectors.

## Regeneration Workflow

```sh
npx tsx demos/alex-place/generate-fixtures.ts
```

The generator script prints proposed outputs for operator review; committed
`data/*.ts` files are still updated manually.
