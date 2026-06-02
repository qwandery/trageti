# trageti demos

The demos show how `trageti` turns dated source episodes into temporal assertions,
stores them in SQLite, indexes assertion text for retrieval, and reads the result
back through snapshot, trajectory, graph, entity-history, and context-assembly
workflows.

## Demo overview

| Demo           | Corpus                                                              | Main features shown                                                                                                                            |
| -------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `alex-place`   | A cooking journal plus fictional food-science references            | Ingestion, hybrid retrieval, supersession, graph expansion, entity history, query answers, final narrative synthesis                           |
| `know-thyself` | Reviewed source documents generated from `trageti` keyframe commits | Ingestion, indexing, hybrid retrieval, trajectory-style evolution, score display, temporal snapshots, query answers, final narrative synthesis |

Both demos share provider handling from `demos/shared/`. Extraction and
embedding are configured independently:

| Capability | Providers                                       |
| ---------- | ----------------------------------------------- |
| Extraction | `fixture`, `anthropic`, `openai-compatible`     |
| Embedding  | `fixture`, `openai-compatible`, `ollama-native` |

The demos distinguish source documents from episodes. Source documents are the
verbatim text that citations quote. Episodes are dated ingestion units and may
be summaries of source material. Extraction outputs citation spans
(`sourceRef`, `excerptStart`, `excerptEnd`), and demo ingestion derives the
stored citation excerpt from the registered source text.

## Prerequisites

From the repository root:

```sh
npm install
```

Run commands from the repository root with `npx tsx`:

```sh
npx tsx demos/alex-place/index.ts
npx tsx demos/know-thyself/index.ts
```

## Offline mode

With no provider environment variables, both demos run offline. Offline mode
uses committed extraction fixtures and committed raw vectors, so it is
deterministic, requires no API keys, and is suitable for smoke tests and quick
orientation. It still writes a real SQLite database and exercises the normal
`TemporalStore`, schema, ingestion, indexing, and retrieval paths. It is not
intended to demonstrate real semantic embedding quality.

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
server startup output, embedding endpoint metadata, or probe the embedding
endpoint once and count the returned vector length. Do not guess this value:
SQLite vector tables are created with a fixed dimension, and every inserted
embedding must match it.

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

`OPENAI_API_KEY` supplies the default `https://api.openai.com/v1` base URL. Keep
optional base URL/API-key overrides commented unless you need an
OpenAI-compatible gateway.

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

Anthropic handles extraction only in this walkthrough. OpenAI-compatible
embeddings are configured separately because retrieval still needs vectors.

Then run:

```sh
npx tsx demos/alex-place/index.ts
npx tsx demos/know-thyself/index.ts
```

## llama-server walkthrough

`llama-server` from llama.cpp exposes OpenAI-compatible HTTP endpoints,
including `/v1/chat/completions` and `/v1/embeddings`. For the most predictable
setup, run one server for chat extraction and one server for embeddings. The
embedding server must use an embedding-capable model.

```sh
llama-server -m /models/chat-model.gguf --host 127.0.0.1 --port 8080
llama-server -m /models/embedding-model.gguf --embedding --pooling mean --host 127.0.0.1 --port 8081
```

Probe the embedding dimension before configuring the demo:

```sh
curl -s http://127.0.0.1:8081/v1/embeddings \
  -H 'Authorization: Bearer sk-no-key' \
  -H 'Content-Type: application/json' \
  -d '{"model":"local-embed","input":"dimension probe"}' \
  | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.parse(s).data[0].embedding.length))"
```

Use the printed number as `DEMO_EMBED_DIMENSION`:

```sh
DEMO_EXTRACT_PROVIDER=openai-compatible
DEMO_EXTRACT_BASE_URL=http://127.0.0.1:8080/v1
DEMO_EXTRACT_API_KEY=sk-no-key
DEMO_EXTRACT_MODEL=local-chat

DEMO_EMBED_PROVIDER=openai-compatible
DEMO_EMBED_BASE_URL=http://127.0.0.1:8081/v1
DEMO_EMBED_API_KEY=sk-no-key
DEMO_EMBED_MODEL=local-embed
DEMO_EMBED_DIMENSION=768
```

Replace `768` with the probed dimension if your model returns a different vector
length. If the dimension changes, delete the demo database before rerunning.

## DB provenance and rebuilds

Each demo DB stores metadata for:

- demo name and data version
- extraction provider provenance
- embedding provider provenance
- embedding dimension
- fixture vs. live mode

If the stored metadata does not match the current `.env` and committed demo
data, the demo exits with guidance to delete the DB or use a different path.
That is intentional: mixing embeddings or extracted assertions from different
providers would make retrieval results misleading.

## Observability

By default, the demos show the high-level ingestion, retrieval, graph,
assembled-context answer, and synthesis flow. To show model-call boundaries and
timings:

```sh
DEMO_LLM_TRACE=summary npx tsx demos/alex-place/index.ts
```

To print prompts, responses, embedding inputs, and vector summaries:

```sh
DEMO_LLM_TRACE=full npx tsx demos/alex-place/index.ts
```

Full raw vectors are intentionally hidden because they dominate the log. Set
`DEMO_LLM_TRACE_RAW_VECTORS=1` only when debugging vector payloads directly.

## More detail

- `demos/alex-place/README.md` explains the cooking-journal demo.
- `demos/know-thyself/README.md` explains the self-history demo.
- `.env.example` lists every supported provider variable.
