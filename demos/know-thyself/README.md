# know-thyself

*trageti ingests its own development history and answers questions about its own evolution.*

This is a **skeleton smoke test** of the full demo described in
`_docs/specs/trageti-demos-spec-v0.1.md`. It exercises the complete
ingestion + indexing + retrieval pipeline against 3 real keyframe commits
from this repo's history, with hand-authored fixture data so it runs offline.

## What it does

The demo reads a hand-curated manifest of "keyframe" commits — moments of
significant architectural change in trageti — and treats each adjacent pair as
the input to a temporal RAG pipeline. For each keyframe the committed
`data/episodes.ts` provides an episode summary; the committed
`data/fixtures.ts` provides the extraction output (assertions, links,
citations); and `data/embeddings.ts` provides pre-computed vectors so
sqlite-vec retrieval runs offline.

After ingestion, the skeleton runs four queries:

1. *"What is the current scoring formula?"* — hybrid snapshot at the latest position.
2. *"How did the temporal model evolve?"* — trajectory mode showing the
   `sequenceNumber → position` rename supersession.
3. *"How does the library handle data integrity?"* — hybrid retrieval that
   surfaces the citations-mandatory / FK-enforcement assertion. The output
   annotates raw `scoreComponents` and applied-signal flags so the hybrid
   retrieval behaviour is observable.
4. *"What was the temporal model as of v0.1?"* — `getTemporalSnapshot` at
   position 1, which returns the original `sequenceNumber` assertion.

## Skeleton scope vs. the full demo

| | Skeleton | Full spec |
|---|---|---|
| Keyframes | 3 (v0.1, v0.2, v0.3.0) | 8–12 across v0.1 through v0.3 |
| Assertions | ~7 | 40–60 |
| Queries | 4 | 8 |

The skeleton's fixture vectors are produced by a small **deterministic hash
function** — they are not semantically meaningful. Semantic-vs-BM25 ranking is
arbitrary until `generate-fixtures.ts` runs against a real embedder and
overwrites `data/embeddings.ts`.

## Run

```pwsh
npx tsx demos/know-thyself/index.ts
```

Exits 0; prints annotated output for each query.

## Execution modes

| Mode | Trigger | Behaviour |
|---|---|---|
| **Fixture** (default) | no env vars | Loads committed fixtures + pre-computed vectors. Offline. |
| **Live (Anthropic + OpenAI/Ollama)** | `ANTHROPIC_API_KEY` + (`OPENAI_API_KEY` ‖ `OLLAMA_HOST`) | Anthropic for extraction; OpenAI or Ollama for embeddings. |
| **Live (OpenAI)** | `OPENAI_API_KEY` | OpenAI for both extraction and embeddings (text-embedding-3-small @ dim 768). |
| **Live (Ollama)** | `OLLAMA_HOST` | OpenAI-compatible Ollama endpoint for extraction; Ollama `/api/embeddings` for embeddings (nomic-embed-text @ dim 768). |

Live mode is **paired**: if a live extractor env var is set but no live
embedder is configured, `index.ts` throws with a clear message. This prevents
the broken pairing where fresh assertion text has no vectors to be retrieved
against.

## Regeneration workflow

```pwsh
# 1. Add a keyframe (or change an existing one) in data/keyframes.ts
# 2. Regenerate episode summaries + aggregations from git:
npx tsx demos/know-thyself/generate-episodes.ts --context-length 32000
# 3. Regenerate extraction + embeddings:
npx tsx demos/know-thyself/generate-fixtures.ts
# 4. Commit data/
git add demos/know-thyself/data/
git commit -m "demos: regenerate know-thyself episodes and fixtures"
```

Both regeneration scripts print proposed file contents to stdout — the
operator reviews and writes them to disk. Deliberate, not automatic.

## Implementation notes

- `data/embeddings.ts` exports both `assertionEmbeddings` (id-keyed, per the
  spec) and `queryEmbeddings` (text-keyed). The spec calls for assertion-id
  keying; `RawVectorProvider` is text-keyed, so `index.ts` re-keys at startup
  by walking the fixture assertions and pairing each `assertion.content` with
  `assertionEmbeddings[assertion.id]`.
- Imports use the bare specifier `'trageti'`; `demos/tsconfig.json` maps it
  to `../src/index.ts` so `tsx` resolves it without a build step.
- The skeleton uses `embeddingDimension: 768` (matches Ollama
  `nomic-embed-text` and OpenAI `text-embedding-3-small` with `dimensions:
  768`). Change `EMBEDDING_DIMENSION` in `data/embeddings.ts` if regenerating
  against a different model.
