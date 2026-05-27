# alex-place

*An aspiring chef's personal journal as a temporal RAG corpus.*

This is a skeleton smoke test of the full demo described in
`_docs/specs/trageti-demos-spec-v0.1.md`. It ships four journal entries plus one
fictional reference document, enough to exercise ingestion, indexing, retrieval,
graph traversal, entity history, and assembled-context narrative synthesis.

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

The skeleton ingests a sourdough learning arc, a fictional fermentation
reference, a low-confidence father reference, and a ramen-broth note. It then
runs:

1. A current sourdough snapshot query.
2. A sourdough understanding trajectory query.
3. A semantic literature query followed by a stricter `findPath` graph query
   over the Field reference link.
4. A semantic Dad query followed by a stricter `getEntityHistory` lookup for
   `alex-father`.
5. An assembled-context narrative synthesis pass.

Fixture vectors are deterministic hash vectors, not semantically meaningful.
Use `generate-fixtures.ts` with a real embedding provider to regenerate
semantic vectors.

## Regeneration Workflow

```sh
npx tsx demos/alex-place/generate-fixtures.ts
```

The generator script prints proposed outputs for operator review; committed
`data/*.ts` files are still updated manually.
