# trageti demos

The demos show how `trageti` turns dated source episodes into temporal assertions,
stores them in SQLite, indexes assertion text for retrieval, and reads the result
back through snapshot, trajectory, graph, entity-history, and context-assembly
workflows.

There are two demos:

- `alex-place`: a cooking journal that shows personal knowledge changing over
  time, including sourdough troubleshooting, reference material, graph links,
  and narrative synthesis from assembled context.
- `know-thyself`: a self-referential project-history demo that ingests
  `trageti` development keyframes and answers questions about how the library
  evolved.

## Offline mode

With no provider environment variables, both demos run offline. Offline mode
uses committed extraction fixtures and committed raw vectors, so it is
deterministic, requires no API keys, and is suitable for smoke tests and quick
orientation. It is not intended to demonstrate real semantic embedding quality.

## Runtime databases

Demo databases are written under `demos/.local/`. Each database records the demo
data version, extraction provider, embedding provider, embedding dimension, and
fixture/live mode. If any of those change, delete the matching database and run
the demo again.

```sh
rm -f demos/.local/alex-place.db
rm -f demos/.local/know-thyself.db
```

## Provider configuration

Copy `.env.example` to `.env` and configure extraction and embedding separately.
Extraction produces structured assertions and links from source text. Embedding
turns assertion/query text into fixed-length vectors for semantic retrieval.

`DEMO_EMBED_DIMENSION` must match the embedding model response size requested
from the provider. For OpenAI `text-embedding-3-small`, `768` is valid when the
request includes `dimensions: 768`, which the demo does. Local models such as
Ollama or llama-server may use a different dimension; check the model card,
server startup output, or embedding endpoint metadata.

## OpenAI walkthrough

Use OpenAI for both extraction and embeddings:

```sh
OPENAI_API_KEY=sk-...
DEMO_EXTRACT_PROVIDER=openai-compatible
# DEMO_EXTRACT_BASE_URL=
# DEMO_EXTRACT_API_KEY=
DEMO_EXTRACT_MODEL=gpt-4o-mini

DEMO_EMBED_PROVIDER=openai-compatible
# DEMO_EMBED_BASE_URL=
# DEMO_EMBED_API_KEY=
DEMO_EMBED_MODEL=text-embedding-3-small
DEMO_EMBED_DIMENSION=768
```

Run either demo:

```sh
npx tsx demos/alex-place/index.ts
npx tsx demos/know-thyself/index.ts
```

## Anthropic walkthrough

Use Anthropic for extraction and OpenAI-compatible embeddings for retrieval:

```sh
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DEMO_EXTRACT_PROVIDER=anthropic
# DEMO_EXTRACT_BASE_URL=
# DEMO_EXTRACT_API_KEY=
DEMO_EXTRACT_MODEL=claude-sonnet-4-20250514

DEMO_EMBED_PROVIDER=openai-compatible
# DEMO_EMBED_BASE_URL=
# DEMO_EMBED_API_KEY=
DEMO_EMBED_MODEL=text-embedding-3-small
DEMO_EMBED_DIMENSION=768
```

Then run:

```sh
npx tsx demos/alex-place/index.ts
npx tsx demos/know-thyself/index.ts
```

## llama-server walkthrough

Start a llama.cpp server with an OpenAI-compatible `/v1` API and an embedding
model whose vector dimension you know. Then configure both providers explicitly:

```sh
DEMO_EXTRACT_PROVIDER=openai-compatible
DEMO_EXTRACT_BASE_URL=http://localhost:8080/v1
DEMO_EXTRACT_API_KEY=sk-no-key
DEMO_EXTRACT_MODEL=your-chat-model

DEMO_EMBED_PROVIDER=openai-compatible
DEMO_EMBED_BASE_URL=http://localhost:8080/v1
DEMO_EMBED_API_KEY=sk-no-key
DEMO_EMBED_MODEL=your-embedding-model
DEMO_EMBED_DIMENSION=768
```

Replace `DEMO_EMBED_DIMENSION` with the actual dimension of your embedding
model. If the dimension changes, delete the demo database before rerunning.

## Observability

By default, the demos show the high-level ingestion, retrieval, graph, and
synthesis flow. To show model-call boundaries and timings:

```sh
DEMO_LLM_TRACE=summary npx tsx demos/alex-place/index.ts
```

To print prompts, responses, embedding inputs, and vectors:

```sh
DEMO_LLM_TRACE=full npx tsx demos/alex-place/index.ts
```

