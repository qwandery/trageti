# trageti demos

The demos show how `trageti` turns dated source episodes into temporal assertions,
stores them in SQLite, indexes assertion text for retrieval, and reads the result
back through snapshot, trajectory, graph, entity-history, and context-assembly
workflows.

## Demo overview

| Demo           | Corpus                                                     | Main features shown                                                                                                                            |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `alex-place`   | A cooking journal plus fictional food-science references   | Ingestion, hybrid retrieval, supersession, graph expansion, entity history, query answers, final narrative synthesis                           |
| `know-thyself` | Git-derived keyframe history for this repo or another repo | Ingestion, indexing, hybrid retrieval, trajectory-style evolution, score display, temporal snapshots, query answers, final narrative synthesis |
| `big-brother`  | Desktop screenshots or synthetic screen fixtures           | Multimodal preparation, image-derived ingestion, activity retrieval, goal inference, query answers, final narrative synthesis                  |

The demos share provider handling from `demos/shared/`. Extraction, vision, and
embedding are configured independently:

| Capability | Providers                                       |
| ---------- | ----------------------------------------------- |
| Extraction | `fixture`, `anthropic`, `openai-compatible`     |
| Vision     | `fixture`, `anthropic`, `openai-compatible`     |
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

Run the shared demo CLI from the repository root:

```sh
npm run trageti-demo -- alex-place run
npm run trageti-demo -- know-thyself run
npm run trageti-demo -- big-brother run
```

Each scenario has four phases:

```sh
npm run trageti-demo -- alex-place prepare
npm run trageti-demo -- alex-place ingest
npm run trageti-demo -- alex-place retrieve
npm run trageti-demo -- alex-place run
```

`prepare` writes reviewable artifacts under
`demos/.local/prepared/<scenario>/prepared.json`. `ingest` reads only that
artifact and writes to `TragetiStore`. `retrieve` opens an already-ingested DB
and runs retrieval examples without preparing or ingesting content. `run`
performs all three phases in order.

With a live embedding provider configured, either demo can replace the default
query suite with one custom user query:

```sh
npm run trageti-demo -- alex-place run --query "From whom has Alex learned specific knife techniques?"
npm run trageti-demo -- know-thyself run --query "What changed about persistence?"
npm run trageti-demo -- know-thyself run --repo ../some-repo --keyframes abc123,def456,789abcd
npm run trageti-demo -- know-thyself run --limit 60
npm run trageti-demo -- big-brother run --query "What should I work on next?"
```

Custom-query mode runs ingestion, then prints one retrieval result and one
assembled-context answer. It skips the built-in demo queries, follow-up API
sections, and final narrative synthesis. Alex custom queries require a live
embedding provider. Know Thyself supports fixture-mode custom queries for its
default repo/keyframes when the prepared artifact was created with the same
custom query.

## Offline mode

With no provider environment variables, the demos run offline. Alex uses
committed extraction fixtures and committed raw vectors. Know Thyself derives
its default repo/keyframe source docs, extraction fixtures, and hash vectors at
runtime. Big Brother uses committed synthetic screen fixtures, deterministic
extraction fixtures, and hash vectors. Offline mode is deterministic, requires no API keys, and is suitable
for smoke tests and quick orientation. It still writes a real SQLite database
and exercises the normal `TragetiStore`, schema, ingestion, indexing, and
retrieval paths. It is not intended to demonstrate real semantic embedding
quality. Know Thyself custom repo/keyframe runs require live providers.

If `.env` contains live provider settings, the demos use live mode. To force
Know Thyself's default repo/keyframes through deterministic fixture mode:

```sh
DEMO_EXTRACT_PROVIDER=fixture DEMO_EMBED_PROVIDER=fixture npx tsx demos/know-thyself/index.ts
```

## Runtime databases

Demo databases are written under `demos/.local/`. Each database records the demo
data version, extraction provider, embedding provider, embedding dimension, and
fixture/live mode. Know Thyself uses run-specific DB files under
`demos/.local/know-thyself/<run-hash>.db`, so different repo/keyframe/provider
inputs do not collide.
Big Brother writes screenshots and run-specific DB files under
`demos/.local/big-brother/`.

```sh
rm -f demos/.local/alex-place.db
rm -rf demos/.local/know-thyself
rm -rf demos/.local/big-brother
```

## Provider configuration

Copy `.env.example` to `.env` and configure extraction and embedding separately.
Extraction produces structured assertions and links from source text. Embedding
turns assertion/query text into fixed-length vectors for semantic retrieval.
Vision produces detailed text descriptions from screenshots for Big Brother's
default prepare flow.

Big Brother asks before live desktop capture unless `--capture` is supplied:

```sh
npm run trageti-demo -- big-brother run --capture
npm run trageti-demo -- big-brother run --capture --captures 10 --duration-minutes 5
npm run trageti-demo -- big-brother run --capture --multimodal
```

By default, Big Brother captures screenshots during `prepare`, describes each
image with `DEMO_VISION_*`, and ingests those descriptions. With `--multimodal`,
`prepare` only captures the images and `ingest` sends the image files directly
to the extraction model; configure `DEMO_EXTRACT_PROVIDER` with a model that
accepts image inputs. Operating systems may require screen-recording permission
for the terminal or shell running the demo.

`DEMO_EMBED_DIMENSION` must match the embedding model response size requested
from the provider. For OpenAI `text-embedding-3-small`, `768` is valid when the
request includes `dimensions: 768`, which the demo does. Local models such as
Ollama or llama-server may use a different dimension; check the model card,
server startup output, embedding endpoint metadata, or probe the embedding
endpoint once and count the returned vector length. Do not guess this value:
SQLite vector tables are created with a fixed dimension, and every inserted
embedding must match it.

Live demo provider calls are serialized in-process at one request per 5 seconds
by default, measured from completion of one live provider request to the start of
the next. Separate demo commands launched in different terminals do not share
this limiter. Extraction retries only temporary HTTP statuses: `408`, `429`,
`502`, `503`, and `504`. A `500 Internal Server Error` is treated as a
provider/model failure and fails fast instead of waiting through repeated backoff
attempts. Rate-limit and retry waits are printed without prompts or credentials.
Override the rate limit with `--limit <seconds>` or `DEMO_RATE_LIMIT=<seconds>`.
Provider requests time out after 60 seconds by default. Override retry timing with
`DEMO_PROVIDER_MAX_ATTEMPTS`, `DEMO_PROVIDER_BASE_DELAY_MS`,
`DEMO_PROVIDER_MAX_DELAY_MS`, and `DEMO_PROVIDER_TIMEOUT_MS`. Contentless
successful streams use a smaller retry cap, `DEMO_PROVIDER_CONTENTLESS_MAX_ATTEMPTS`
which defaults to 2, before trying the non-streaming fallback.

Live extraction output is capped by default with `DEMO_EXTRACT_MAX_TOKENS=8192`.
OpenAI-compatible JSON extraction requests use non-streaming chat completions by
default because some gateways stream invalid partial JSON, hidden reasoning
artifacts, or whitespace loops. Set `DEMO_EXTRACT_STREAM_JSON=true` only when you
need to debug raw streamed extraction frames or a compatible provider requires
streaming. If a compatible server rejects JSON mode, set
`DEMO_EXTRACT_RESPONSE_FORMAT=off`. If a gateway supports strict structured
outputs and a model does not reliably follow JSON object mode, set
`DEMO_EXTRACT_RESPONSE_FORMAT=json_schema` to send the extraction JSON schema in
`response_format`. `DEMO_EXTRACT_RESPONSE_FORMAT` also accepts a raw JSON object
for provider-specific response formats, for example `{"type":"json_object"}`.
Set `DEMO_EXTRACT_EXTRA_BODY_JSON` to merge provider-specific extraction request
fields such as `{"reasoning":{"exclude":true}}`; this is especially useful for
OpenRouter reasoning models that can otherwise spend the whole completion budget
on non-visible reasoning tokens. Set
`DEMO_EMBED_EXTRA_BODY_JSON` to merge provider-specific embedding request fields
such as `{"response_format":{"type":"float"}}`. Normal demo output prints a
concise stream completion meter; `--llm-trace` shows in-place stream progress,
and `--llm-trace=full` appends raw streamed response frames.

Pass `--warmup` to either demo to send a tiny extraction request and a tiny
embedding request before the main run. Fixture providers are skipped. This is
useful with local providers such as Ollama because model loading happens before
the first large source-summary or indexing request.

## OpenAI walkthrough

Use OpenAI for both extraction and embeddings:

```sh
DEMO_EXTRACT_PROVIDER=openai-compatible
DEMO_EXTRACT_BASE_URL=https://api.openai.com/v1
DEMO_EXTRACT_API_KEY=sk-...
DEMO_EXTRACT_MODEL=gpt-4o-mini

DEMO_EMBED_PROVIDER=openai-compatible
DEMO_EMBED_BASE_URL=https://api.openai.com/v1
DEMO_EMBED_API_KEY=sk-...
DEMO_EMBED_MODEL=text-embedding-3-small
DEMO_EMBED_DIMENSION=768
```

Use the same pattern for any OpenAI-compatible gateway: set the base URL, API
key, and model explicitly for each live capability.

Run either demo:

```sh
npx tsx demos/alex-place/index.ts
npx tsx demos/know-thyself/index.ts
```

## Anthropic walkthrough

Use Anthropic for extraction and OpenAI-compatible embeddings for retrieval:

```sh
DEMO_EXTRACT_PROVIDER=anthropic
DEMO_EXTRACT_API_KEY=sk-ant-...
DEMO_EXTRACT_MODEL=claude-sonnet-4-20250514

DEMO_EMBED_PROVIDER=openai-compatible
DEMO_EMBED_BASE_URL=https://api.openai.com/v1
DEMO_EMBED_API_KEY=sk-...
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

## Ollama walkthrough

Ollama can provide local chat extraction through its OpenAI-compatible `/v1`
API and local embeddings through its native `/api/embeddings` API. Pull one
chat-capable model and one embedding-capable model:

```sh
ollama pull llama3.1
ollama pull nomic-embed-text
```

Start Ollama if it is not already running:

```sh
ollama serve
```

Probe the embedding dimension before configuring the demo:

```sh
curl -s http://127.0.0.1:11434/api/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"nomic-embed-text","prompt":"dimension probe"}' \
  | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.parse(s).embedding.length))"
```

Use the printed number as `DEMO_EMBED_DIMENSION`:

```sh
OLLAMA_HOST=http://127.0.0.1:11434

DEMO_EXTRACT_PROVIDER=openai-compatible
DEMO_EXTRACT_MODEL=llama3.1

DEMO_EMBED_PROVIDER=ollama-native
DEMO_EMBED_MODEL=nomic-embed-text
DEMO_EMBED_DIMENSION=768
```

Replace `768` with the probed dimension if your embedding model returns a
different vector length. If you change the embedding model or dimension, delete
the matching demo database before rerunning.

Then run either demo:

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

Know Thyself also caches live-derived source summaries under
`demos/.local/know-thyself/`, keyed by repo, commits, provider provenance, and
source input. Reruns reuse completed summary work when the inputs match.

## Observability

By default, the demos show the high-level ingestion, retrieval, graph,
assembled-context answer, and synthesis flow. During ingestion, normal output
also shows the current prepared unit, short document snippet, selected source
refs, response format, and approximate prompt size before each extraction
request. To show deeper model-call boundaries and timings:

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
