# alex-place

*An aspiring chef's personal journal — temporal RAG over the scattered,
determined record of someone teaching themselves what culinary school didn't
have time to finish.*

This is a **skeleton smoke test** of the full demo described in
`_docs/specs/trageti-demos-spec-v0.1.md`. The full spec calls for ~25
journal entries across six months; the skeleton ships 4 entries plus one
fictional reference document — enough to exercise the full ingestion +
indexing + retrieval pipeline without writing a novella.

## What it does

The skeleton ingests:

- **journal-1** (2026-01-05) — Alex starts a sourdough starter; one oblique
  reference to their father in the margins.
- **journal-2** (2026-01-20) — First bake. Dense and too sour. Alex lists
  *suspected* causes (long cold retard, very mature levain, low hydration)
  without blaming any single variable.
- **ref-field** (2026-01-22) — Alex reads a chapter from Mara Field's
  *Sourdough Notes* (fictional author, fictional excerpt) on fermentation
  acidity. The reference says acidity is the sum of starter maturity,
  inoculation, time, and temperature schedule — no single dial.
- **journal-4** (2026-02-08) — Room-temp proof bake. Shorter bulk, younger
  levain, no cold retard. Acidity in target. The journal entry hedges:
  works *with this starter*; transferability unknown.
- **journal-5** (2026-02-15) — Alex eats at a ramen shop and notes the
  opaque broth: both fat AND gelatin suspended, body pulled from the bones.

After ingestion, four query demos:

1. *"What do I currently know about sourdough?"* — hybrid snapshot at the
   latest position; superseded "cold retard caused it" suspicion drops out.
2. *"How has my understanding of sourdough proofing evolved?"* — hybrid
   trajectory mode; surfaces the supersession chain from the original
   suspicion to the corrected understanding.
3. *"What does the literature say about my sourdough acidity?"* — multi-hop
   demo via `store.findPath`; prints the typed `contextualizes` link from
   the Field reference to the room-temp-proof assertion. This uses the
   graph APIs directly because `retrieve({ expandLinks: true })` only
   surfaces untyped `linkedAssertions[]`.
4. *"What would Dad think?"* — `store.getEntityHistory` for
   `entityId: 'alex-father'`. The "near-miss" query: returns exactly one
   low-confidence assertion, demonstrating that the system doesn't
   hallucinate significance the source material doesn't carry.

Then a **narrative synthesis pass** via `store.assembleContext` — fixture
mode returns a clearly labelled pre-written paragraph; live mode runs a real
LLM synthesis call. This is the canonical assembled-context → LLM pattern
trageti is built for.

## Skeleton scope vs. the full demo

| | Skeleton | Full spec |
|---|---|---|
| Journal entries | 4 | ~25 |
| References | 1 (Field, fictional) | 3 (Field, Ito, Maillard — all fictional) |
| Assertions | ~6 | ~70 |
| Queries | 4 | 9 |

The skeleton **does not** include the ramen-failure / Ito-paitan triad the
full spec uses for its cloudy-broth multi-hop query. The skeleton's
multi-hop demo runs the same machinery over the sourdough/Field arc instead.

The skeleton's embedding vectors are produced by a **deterministic hash
function** — they are not semantically meaningful. Semantic-vs-BM25 ranking
is arbitrary until `generate-fixtures.ts` runs against a real embedder.

## Run

```pwsh
npx tsx demos/alex-place/index.ts
```

Exits 0; prints annotated output for each query, then the narrative.

## Execution modes

| Mode | Trigger | Behaviour |
|---|---|---|
| **Fixture** (default) | no env vars | Committed fixtures + pre-computed vectors. Offline. Narrative is pre-written. |
| **Live** | extractor env + embedder env (paired) | LLM extraction + real embedder. Narrative is a live synthesis call. |

Live mode is **paired**: if a live extractor env var is set but no live
embedder is configured, `index.ts` throws — fresh assertion text wouldn't
have pre-computed vectors to be retrieved against.

## Implementation notes

- The `contextualizes` link in `data/fixtures.ts` goes from the Field
  reference assertion to the room-temp-proof assertion (`fromId` is the
  context-provider). `findPath` traverses `fromId → toId`, so the multi-hop
  query reads "what does the Field reference contextualize?"
- The narrative synthesis uses `store.assembleContext({ queryText: 'cooking
  progress', tokenBudget: 1000 })`; the context is then fed to the
  extractor's underlying model when live, or replaced by a pre-written
  paragraph in fixture mode.
- `data/embeddings.ts` follows the spec's `assertionEmbeddings` (id-keyed)
  contract and adds a `queryEmbeddings` (text-keyed) record because
  `RawVectorProvider` is text-keyed. `index.ts` re-keys at startup by
  walking the fixture assertions.
