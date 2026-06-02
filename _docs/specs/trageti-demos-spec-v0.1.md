# trageti Demos

## Specification v0.1

**Status:** Design specification
**Date:** May 2026
**Depends on:** trageti v0.3

---

## Purpose

The demos directory serves two audiences simultaneously. For developers evaluating the library, the demos are the first thing they'll read after the README — they need to demonstrate that trageti solves real problems, not toy ones. For developers already using the library, the demos are reference implementations of common patterns: ingestion, extraction, temporal querying, trajectory reconstruction, and link traversal.

Each demo is a self-contained mini-application with realistic data, a functional ingestion pipeline, and a curated query set that exercises a specific slice of the library's capabilities. Each one runs standalone with `npx tsx demos/<name>/index.ts` and produces meaningful, annotated output. Each one works offline via pre-generated extraction fixtures, with an optional live LLM path for regeneration.

---

## Current Implementation Amendments

Dogfooding the demos changed several design decisions from the initial sketch
below. The current implementation treats these as normative:

- Extraction and embedding are separate demo-local provider capabilities.
  Provider resolution lives in `demos/shared/providers.ts`, loads `.env` via
  `dotenv/config`, and never assumes that a named service supports both chat
  extraction and embeddings.
- Offline mode uses fixture extraction keyed by episode ID and fixture
  embeddings served through trageti's `RawVectorProvider`.
- Runtime DBs live under `demos/.local/` and are guarded by demo metadata:
  data version, extraction provenance, embedding provenance, embedding
  dimension, and fixture/live mode.
- `DEMO_LLM_TRACE=summary` or `--llm-trace` prints model-call summaries.
  `DEMO_LLM_TRACE=full` prints prompts and responses while keeping embedding
  vectors summarized.
- Retrieval demos issue broad queries and present a relevance window ordered
  for human reading by time and position first, then rank. This avoids
  hard-coding result steering in the demos while exposing open library design
  questions about relative relevance filtering.
- Citations are source-span based. Extraction must provide `sourceRef`,
  `excerptStart`, and `excerptEnd`; it must not provide direct citation
  `excerpt` text. Demo ingestion resolves the registered source document and
  derives the stored verbatim excerpt before calling trageti.
- Episodes and source documents are distinct. Episodes may be temporal
  summaries. Source documents are citation-grade text: Alex's journal and
  fictional references for `alex-place`, and reviewed generated keyframe
  documents for `know-thyself`.

The older pseudocode in this document should be read through those amendments
where it differs from the shipped demo infrastructure.

---

## Shared Ingestion Infrastructure

All demos share a minimal ingestion utility that lives in `demos/shared/`. This utility is explicitly not a published package — it is demo-scoped infrastructure that demonstrates how consuming applications can build their own ingestion pipelines on top of trageti's write API.

### Design Constraints

The shared infrastructure must remain under 250 lines total. It must not introduce dependencies beyond trageti itself and `fetch`. It must not implement chunking, retry logic, approval workflows, or model abstraction — those are application concerns that belong in consuming projects, not in demos.

### `ingest()`

The core function. Takes a document, feeds it to an LLM (or reads from a fixture), parses the structured output, and writes episodes, assertions, citations, and links to the store.

```typescript
interface IngestOptions {
  store: TemporalStore;
  episode: Omit<Episode, 'createdAt'>;
  document: string;
  existingAssertions?: Assertion[];
  extract: (prompt: string) => Promise<string>;
  namespace: string;
  promptOverride?: string; // replaces default extraction prompt entirely
}

interface ExtractionResult {
  assertions: NewAssertionInput[];
  links: Array<Omit<AssertionLink, 'createdAt'>>;
}

async function ingest(options: IngestOptions): Promise<ExtractionResult>;
```

The function:

1. Writes the episode via `store.writeEpisode()`
2. Builds an extraction prompt from the document and existing assertions (or uses `promptOverride`)
3. Calls the provided `extract` function
4. Parses the JSON response into assertions and links
5. Writes each assertion via `store.writeAssertion()` (citations are included inline)
6. Writes each link via `store.writeLink()`
7. Returns the full extraction result for logging or inspection

### Extraction Prompt

A single shared prompt template, parameterized by document text and existing assertion context. The prompt instructs the LLM to:

- Extract self-contained, citable assertions from the document
- Classify each as `fact`, `update`, `recontextualization`, `resolution`, `regression`, `absence`, or `pattern`
- For assertions related to existing ones, determine whether the relationship is replacement (set `supersedesId`) or accumulation (create a typed link)
- Default to accumulation when the classification is uncertain
- Include a citation for every assertion: a `sourceRef` locator plus
  `excerptStart` and `excerptEnd` offsets into a registered source document.
  Extraction output must not supply direct `excerpt` text; demo ingestion
  derives the verbatim excerpt from the source span.
- Assign a confidence score based on evidence strength

The prompt requests JSON output matching the `ExtractionResult` schema. Assertion IDs are generated by the prompt using a deterministic naming convention: `a-{episodeId}-{index}`. Link IDs follow `link-{episodeId}-{index}`.

### Extractors

Three extractor implementations, selected per-environment:

**`anthropicExtractor(apiKey)`** — calls the Anthropic Messages API (which uses a different request format from the OpenAI standard). Requires `ANTHROPIC_API_KEY` environment variable.

**`openaiExtractor(options)`** — calls any OpenAI-compatible API. This covers OpenAI itself, OpenRouter, Ollama (which exposes an OpenAI-compatible endpoint at `http://localhost:11434/v1`), llama.cpp server, LM Studio, LocalAI, and any other provider that implements the `/v1/chat/completions` interface. Takes `baseUrl`, `apiKey`, and `model` as parameters.

**`fixtureExtractor(fixtures)`** — reads from a pre-generated fixture map keyed by episode ID. For offline execution, CI, and deterministic README output. The fixtures are generated once by running the demo with a live extractor and committing the output.

```typescript
// demos/shared/providers.ts

/** Anthropic Messages API — different request format from OpenAI standard */
function anthropicExtractor(apiKey: string): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    return data.content[0].text;
  };
}

/** OpenAI-compatible — covers OpenAI, OpenRouter, Ollama, llama.cpp, LM Studio, etc. */
function openaiExtractor(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
    });
    const data = await response.json();
    return data.choices[0].message.content;
  };
}

/** Pre-generated fixtures — offline, CI, deterministic */
function fixtureExtractor(
  fixtures: Record<string, string>,
): (prompt: string, options: { episodeId: string }) => Promise<string> {
  return async (_prompt, options) => {
    const raw = fixtures[options.episodeId];
    if (!raw) {
      throw new Error(`No fixture for episode ${options.episodeId}`);
    }
    return raw;
  };
}
```

Each demo resolves extraction and embedding independently through `demos/shared/providers.ts`. Convenience variables can supply provider defaults, but the demos do not infer that a named service supports both extraction and embeddings. If no live provider is configured, fixture extraction and fixture embeddings are used.

### Embedding Providers

Both demos can use real, semantically meaningful embeddings via sqlite-vec when configured with a live embedding provider or regenerated semantic fixtures. The embedding provider follows the same resolution pattern as the extractors:

**Live mode:** The demo resolves an `EmbeddingProvider` based on available environment variables. Ollama's `/api/embeddings` endpoint and any OpenAI-compatible `/v1/embeddings` endpoint are supported. The provider is used both for indexing assertions at ingestion time and for embedding queries at retrieval time.

**Fixture mode:** Fixture vectors are supplied via `RawVectorProvider` — trageti's passthrough provider for caller-supplied vectors. Alex loads committed deterministic hash vectors. Know Thyself derives deterministic hash vectors at runtime for the default repo/keyframes. These fixture vectors are not semantically meaningful; they keep the sqlite-vec pipeline offline and repeatable. Use a live embedding provider when semantic ranking quality is the thing being demonstrated.

With live or regenerated semantic embeddings, both demos demonstrate genuine hybrid retrieval: semantic similarity finds conceptually related assertions that keyword matching alone would miss, BM25 handles exact terminology, and the composite score shows the interaction between the two signals. Query output annotates `scoreComponents` for each result, making it visible which signal contributed to each retrieval.

### Fixture Generation

Each demo includes a `generate-fixtures` script that runs the full ingestion pipeline with a live extractor and a live embedding provider. The script writes both the LLM extraction output and the generated embedding vectors to committed fixture files.

```
npx tsx demos/<name>/generate-fixtures.ts
```

The fixture files:

- `fixtures.ts` — extraction output: `Record<string, string>` mapping episode ID to raw LLM response JSON
- `embeddings.ts` — pre-computed embedding vectors: `Record<string, number[]>` mapping assertion ID to embedding array

At runtime, the demo loads or derives fixture embeddings via `RawVectorProvider` (trageti’s passthrough provider for caller-supplied vectors). This means sqlite-vec is exercised in fixture mode without a live model. The fixture vectors are deterministic hash vectors; use a real embedding provider to produce semantically meaningful vectors.

In live mode, the demo uses whatever embedding provider is available (Ollama’s `/api/embeddings` endpoint, OpenAI’s embedding API, etc.) to generate vectors at ingestion time. The same provider is used for query embedding at retrieval time.

Fixtures are regenerated when the extraction prompt changes, when the data changes, or when extraction quality needs improvement. They are version-controlled so the demos produce stable, reviewable output in CI.

---

## Demo 1: Trageti Know Thyself!

_trageti ingests its own development history and answers questions about its own evolution._

### Concept

This demo uses trageti to build a temporal knowledge base over the library's own specifications, changelogs, and design decisions. It is simultaneously a dogfooding exercise, a demonstration of the library's temporal capabilities, and a genuinely useful tool for contributors who want to understand why something is the way it is without reading every spec revision.

The tagline: "The only temporal RAG library that can explain its own history to you."

### Data: Keyframe Commits

Rather than ingesting hand-curated spec documents, this demo works from git history. A small default keyframe list defines moments of significant architectural change for the Trageti repo, and `--repo` / `--keyframes` can point the same flow at another repository when live providers are configured. Runtime processing derives the initial keyframe and adjacent keyframe-pair source documents from git operations. Extraction then produces assertions, links, and citation spans grounded in those generated source documents.

The manifest is a small, hand-maintained file:

```typescript
// demos/know-thyself/data/keyframes.ts

export const keyframes: Keyframe[] = [
  { hash: 'fac4ada', position: 1, label: 'v0.1 implementation', date: '2026-04-29' },
  { hash: '5695df6', position: 2, label: 'v0.2 citations and trajectory retrieval', date: '2026-05-10' },
  // ... additional keyframes through v0.3 implementation, remediation, and polish
];
```

Adding or supplying keyframe commits is the only manual curation required. Everything else is derived from git at runtime.

### Ingestion: The generate-episodes Script

Current implementation note: the runner and `generate-episodes.ts` share the
same source builder. For each initial keyframe or adjacent keyframe pair, it
collects commit metadata, full `git diff --stat`, name-status, numstat, and a
deterministic bounded set of important file diffs or snapshots. It ignores
generated/noisy artifacts such as lockfiles, demo DBs, fixture vectors, build
output, `node_modules`, coverage, and `.local`, while prioritizing specs, public
types, store/retrieval/graph/scoring code, migrations, behavior tests, README,
and changelog updates. Episodes are temporal summaries over those generated
documents, while fixture and live extraction cite source spans inside the
runtime-generated source docs.

The script processes each adjacent keyframe pair with git operations and an optional source-summary pass:

```
npx tsx demos/know-thyself/generate-episodes.ts [--context-length 8192]
```

**Per keyframe pair (prev, curr):**

```
1. git log curr -1 --format='%B'       -> commit message
2. git diff --stat prev curr            -> full file change summary
3. git diff --name-status prev curr     -> changed path status
4. git diff --numstat prev curr         -> per-file line counts
5. deterministic source selection       -> bounded important files
6. git diff prev curr -- <path>         -> selected file diffs
7. source summary pass                  -> reviewable keyframe document
8. fixture/runtime extraction           -> assertions, links, citation spans
```

Steps 1-6 are pure git operations. The `--context-length` parameter controls how much selected diff context is included in the generated source document. Review copies can be written under `demos/.local/know-thyself/sources/<hash>/`; they are no longer committed seed data.

**For the first keyframe** (no previous commit to diff against), the script uses the full content of the keyframe commit itself: `git show <hash>:<file>` for the key files (spec, types, schema, README), truncated to the context budget. The aggregation call summarizes the initial state rather than a diff.

### Runtime Artifacts

Only the default keyframe list is committed as configuration. Everything else is derived:

```
data/
└── keyframes.ts          - default keyframe commit list
```

Runtime DBs live under `demos/.local/know-thyself/<run-hash>.db`. The run hash includes the absolute repo path, resolved commits, provider provenance, mode, and query text set so different repo/keyframe/provider inputs do not collide.

### Regeneration Workflow

```
npx tsx demos/know-thyself/generate-episodes.ts --context-length 32000
npx tsx demos/know-thyself/generate-fixtures.ts
```

Both scripts use the same provider resolver as all other demos and write review
artifacts under `demos/.local/`; they do not update committed seed data.

### Expected Assertion Count

40-60 assertions across 8-12 keyframes, with supersession chains, accumulation links, source-grounded citations, schema evolution, retrieval-contract changes, and remediation milestones.

### What It Exercises

| Capability          | How it appears                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Supersession        | Scoring formula v0.1 → v0.2 → v0.3                                                               |
| Recontextualization | Case formulation: primary artifact → rejected → demoted to derived view                          |
| `deepens`           | Each spec version adds detail to core concepts without replacing them                            |
| `qualifies`         | "Assertions not chunks — but assertions need citations" (v0.2 qualifies v0.1)                    |
| Trajectory mode     | "How did the citation model evolve?" returns the full chain                                      |
| Temporal snapshot   | "What was the scoring formula as of v0.2?"                                                       |
| BM25 retrieval      | Natural keyword queries over technical content                                                   |
| Citations           | Every assertion cites offsets in generated source documents; ingestion derives verbatim excerpts |

### Query Set

**"What is the current scoring formula?"** — snapshot at latest position. Should return the v0.3 `DefaultScorer` four-case formula with weight renormalization.

**"How did the citation requirement evolve?"** — trajectory mode. Should return a chain: absent in v0.1 → optional in v0.2 → mandatory with structural invariant enforcement in v0.3.

**"What was the temporal model as of v0.1?"** — temporal snapshot at position 1. Should return the original `sequenceNumber` design before it was renamed to `position` and generalized.

**"What design decisions were reversed?"** — query for superseded assertions that were later recontextualized. The case formulation arc is the primary expected result.

**"Why are all public methods async?"** — keyword query targeting the v0.3 rationale. Should return the future-proofing argument from the spec.

**"What is the relationship between supersession and accumulation?"** — query with `expandLinks: true`. Should surface the link type taxonomy and the "default to accumulation" guidance. With `maxDepth: 2`, should follow the link from the accumulation concept to the concrete link types, and from there to the design discussion that motivated them.

**"How does the library handle data integrity?"** — a semantic query that should find assertions about foreign key enforcement, structural invariants, and citation validation — none of which contain the phrase "data integrity." This is a demonstration that semantic retrieval finds conceptually relevant assertions that BM25 keyword matching alone would miss. The output should annotate which retrieval signal (semantic vs. BM25) contributed to each result’s score.

**"What changed about the FTS5 contract?"** — a keyword query where BM25 should outperform semantic retrieval. "FTS5" is a specific technical term that embeds poorly (it’s an acronym, not a semantically rich phrase) but matches exactly via keyword. Demonstrates that hybrid retrieval benefits from both signals.

### Output Format

The demo prints annotated results for each query: the query text, the retrieval mode and strategy used, the number of results, and for each result the assertion content, its position, confidence, citation excerpt, and (in trajectory mode) the full supersession chain. Output is formatted for terminal readability with clear section breaks.

When run with `--query "<question>"`, the demo replaces the built-in query suite with one user-supplied retrieval query and one assembled-context answer. Default fixture mode supports custom queries because deterministic query vectors are derived at runtime. Custom `--repo` or `--keyframes` runs require live extraction and live embedding providers; fixture mode is intentionally limited to the default repo/keyframes.

---

## Demo 2: Alex's Place

_An aspiring chef's personal journal — the scattered, determined, sometimes vulnerable record of someone trying to teach themselves what culinary school didn't have time to finish._

### Concept

Alex is a home cook in their mid-20s who attended culinary school for just over a year before having to drop out. The reasons are never fully explained in the journal — there are glancing references to Alex's father, to a period where "everything stopped," to bills that couldn't wait. The journal begins several months after, when Alex has decided to make up the difference on their own. They're going to learn what school would have taught them, and more, through relentless experimentation, reading, and practice. The ambition isn't casual — Alex wants to open something someday, or at least cook professionally. "Someday. Eventually."

The data source is Alex's personal journal — a food diary that's mostly about cooking but doesn't always stay there, because humans don't separate their ambitions from their frustrations, their sourdough from their dinner plans, their ramen broth from the memory of a father who made the best Sunday stock. The entries are informal, raw, sometimes breathless with excitement about a technique that finally clicked, sometimes quiet and uncertain. The timing is irregular — clusters of entries around dinner parties or when Jordan's mother visits, gaps when life gets in the way.

This is not a structured recipe log. It's a person's attempt to organize their own learning, written for themselves, not for an audience.

### What Makes This Demo Work

The journal format is the perfect ingestion challenge for temporal RAG because it mirrors real-world data: unstructured, inconsistent in timing and depth, mixing factual observations with emotional context, and requiring the extraction system to pull out the cooking knowledge while preserving the human texture that gives it meaning. Alex's journal is the kind of data that standard RAG would mangle — relevant chunks scattered across dozens of entries with no clear boundaries between "important technique observation" and "personal reflection." The temporal validity model is what makes it tractable: each assertion is anchored to when Alex understood it, and the supersession and accumulation links show how that understanding evolved.

### Characters

**Alex** — the protagonist. Writes the journal. Determined, energetic, sometimes disorganized. Obsessive about getting techniques right. Reads food science articles and then immediately tries to apply them, sometimes before fully understanding. Writes the way they think — half-sentences, asides, the occasional all-caps exclamation when something works. Doesn't talk about their father directly but it's there, in the margins.

**Jordan** — Alex's partner. Supportive, honest, the person who eats everything Alex cooks and gives feedback that's sometimes more blunt than Alex is ready for. Jordan prefers simple food done well and keeps gently steering Alex away from overcomplicated dishes. Appears in the journal through Alex's voice — we never hear Jordan directly.

**Mrs. Park** — Jordan's mother, visiting from Seoul for two weeks around month 4. A serious home cook who learned Korean cuisine from her own mother. Not a professional chef but has the authority of someone who has been making the same dishes for forty years. Her feedback on Alex's kimchi jjigae is devastating and catalytic — she says it kindly, but Alex can tell the difference between kindness and praise. Sends Alex down a two-week research rabbit hole that produces genuinely better food.

**Sam** — friend, dinner party regular. Has strong opinions about bread and isn't shy about sharing them. Says Alex's sourdough is "too sour" at the first dinner party. This bothers Alex more than they let on. When Sam says it's "perfect" three months later, Alex writes about it for half a page.

**Priya** — friend, trained pastry chef who pivoted to software. Gives technically precise feedback that Alex learns more from in ten minutes than from a week of YouTube videos. Priya's offhand comment about browning chemistry sends Alex to a food-science reference. Appears at dinner parties and once in a phone call about tempering chocolate.

### Source Material Format

The primary data is a single markdown document — `alex.md` — containing Alex's journal entries. Each entry has a date header and is written in Alex's voice: first person, informal, varying length (some are three sentences, some are two pages). The journal is the raw source that the ingestion pipeline processes.

The journal is supplemented by a small set of reference documents that Alex reads and references in their entries:

- A fictional excerpt from Mara Field's _Sourdough Notes_ on fermentation timing (referenced in Alex's sourdough arc)
- A fictional article by Ren Ito on paitan-style broth emulsions (referenced in the ramen arc)
- A fictional food-science excerpt on Maillard browning (referenced after Priya's feedback)
- A knife skills class handout (referenced once, then revised by a YouTube discovery)

These supplementary documents are ingested as their own episodes at the position where Alex encounters them. Their assertions `contextualize` or `deepen` assertions from Alex's experimental entries.

### Journal Entries (Episode Map)

~25 entries across 6 months. Entries are grouped here by narrative thread for clarity, but in the actual journal they are interleaved chronologically — the sourdough and ramen and dinner party threads weave through each other the way real life does.

**The sourdough thread**

| Entry                                   | Position | Tone & Content                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Started the starter today"             | 1        | Optimistic, slightly nervous. Alex describes mixing flour and water and feeling silly about how excited they are. Mentions this is one of the first things they were working on at school before they left.                                                                                                                            |
| "First real bake"                       | 3        | Disappointed but analytical. Dense crumb, way too sour. Alex lists everything they think went wrong. Suspects the cold retard was too long but isn't sure. "I know it's supposed to take time. I just want it to work."                                                                                                                |
| Field fermentation chapter              | 5        | (Supplementary document) Alex reads this after the failed bake. The journal entry around it is excited — "I think I've been letting the cold retard run too long with a too-mature levain. Field says acidity comes from the whole fermentation schedule — starter maturity, inoculation, time, temperature. This changes everything." |
| "Room temp proof bake"                  | 8        | Triumphant. Abandoned cold retard entirely. Open crumb, mild flavor, best bake yet. Alex is almost giddy. "If Dad could see this loaf he'd pretend he wasn't impressed and then eat half of it." One line, dropped casually, then Alex moves on to talk about hydration percentages.                                                   |
| "Tried whole wheat today"               | 12       | Frustrated. The whole wheat flour wrecked everything — dense, gummy, wouldn't rise properly. Alex knows it's about hydration but can't dial it in. "Back to square one. Except it's not really square one because I know more now. Square two."                                                                                        |
| "Cracked the whole wheat"               | 15       | Relieved. 80% hydration works for whole wheat. But the technique only works with this flour — Alex's bread flour method doesn't transfer. "So now I have two techniques. That's fine. That's actually how it works, I think."                                                                                                          |
| First dinner party (sourdough feedback) | 20       | (See dinner party section)                                                                                                                                                                                                                                                                                                             |
| Third dinner party (Sam says "perfect") | 24       | (See dinner party section)                                                                                                                                                                                                                                                                                                             |

**The miso ramen thread**

| Entry                          | Position | Tone & Content                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Ate at Kintaro tonight"       | 6        | Reverent. Alex and Jordan went to a ramen shop and Alex can't stop thinking about the broth. "Milky, almost creamy, but not heavy. Fat and gelatin suspended all through it, I'm sure of it. I need to figure out how they did this." Detailed sensory notes — Alex is already reverse-engineering in their head.         |
| "First attempt: disaster"      | 9        | Honest, slightly humorous. "The broth was thin and cloudy but not the right kind of cloudy. Jordan said it tasted like 'pork water.' Not wrong." Alex lists what they used and suspects the cook was too short, the water ratio was off, and the boil never got vigorous enough.                                          |
| Ito paitan article             | 11       | (Supplementary document) Alex reads this and has a revelation. Journal entry: "It's the BOIL. The vigorous boil forces fat, gelatin, and tiny solids into suspension. Kintaro wasn't doing it wrong with the cloudiness — they were doing it RIGHT. My broth wasn't cloudy enough."                                       |
| "Second attempt: holy s\*\*\*" | 14       | All-caps energy. Rolling boil for 8 hours. "The broth is WHITE. It's THICK. It coats the back of a spoon. I literally called Jordan over to look at it and they said 'it looks like milk' and I said EXACTLY." Still not quite Kintaro-level but dramatically closer.                                                     |
| "Noodle experiment"            | 18       | Mixed results. Broth technique is dialed now but the noodles were wrong — Alex used baking soda instead of kansui water. "The online recipe said baking soda could substitute. Maybe it can if you do it right, but the way I did it was not right. The texture was rubbery and the flavor was slightly metallic."        |
| "Mrs. Park's tare trick"       | 23       | Mrs. Park watches Alex make the tare and says, gently, "Toast the miso first." Alex tries it. "I don't know how to describe the difference except that the flavor went from flat to... dimensional? Like it suddenly had a front and a back." Alex connects this to the browning-chemistry reference they'd read earlier. |

**Knife skills (2 entries)**

| Entry                  | Position | Tone & Content                                                                                                                                                                                                                                                                                                          |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Took the knife class" | 7        | Enthusiastic but self-conscious. Alex describes the instructor's pinch grip, claw hand, and high rocking technique. "The grip makes sense, but the rocking motion felt wrong with my knife, like I was fighting the blade instead of guiding it. But everyone else seemed fine with it so I didn't say anything."       |
| YouTube discovery      | 10       | Relieved, almost vindicated. Alex finds a video explaining that a santoku's flatter profile often works better with push cuts, chops, and shorter slicing motions than with a high rock. "Different blade, different motion. I've been trying to use my knife like it's someone else's knife. No wonder it felt wrong." |

**Dinner parties (3 entries)**

| Entry                             | Position | Tone & Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First dinner party                | 20       | Long entry, mixed emotions. Alex cooked for Sam, Priya, Jordan. Sourdough, a roasted chicken, a salad. Priya's feedback on browning technique is a highlight — she explains Maillard chemistry offhand and Alex is taking mental notes. Sam says the bread is "a little sour for me" and Alex tries not to care and clearly does. Jordan says the salad dressing was the best thing on the table. "I spent six hours on that chicken and the DRESSING is the best thing." Small moment of self-awareness: "Maybe Jordan's been right this whole time about keeping it simple."             |
| Second dinner — Mrs. Park's visit | 22       | Alex makes kimchi jjigae for Mrs. Park. It doesn't go badly, exactly, but Alex can tell Mrs. Park is being polite. Later, Mrs. Park says the recipe Alex used has too much sugar and not enough gochugaru. "She said it like it was nothing, like she was telling me the weather. But I could tell — that recipe I've been following is wrong. Not wrong for someone's version of it, but wrong for what this dish is supposed to be." Alex spends the next two weeks researching traditional kimchi jjigae preparation. "The aged kimchi is the base, not a garnish. I had it backwards." |
| Third dinner party                | 24       | Triumphant. Sam says the sourdough is perfect. Alex writes about it for half a page. Priya notices Alex's knife work has improved and says so. Jordan makes the salad dressing this time. "The food was good tonight. I think it might have been actually good, not just good-for-me good. For the first time I could see it — the restaurant, the kitchen, whatever it ends up being. It felt possible. Not close. But possible. Someday. Eventually."                                                                                                                                    |

**Food science reading (3 entries, ingested as supplementary documents)**

| Position | Source                                   | How Alex encounters it                               |
| -------- | ---------------------------------------- | ---------------------------------------------------- |
| 5        | Field — fermentation chapter             | After failed sourdough bake                          |
| 11       | Ito — paitan broth emulsions             | After failed ramen attempt                           |
| 16       | Food-science excerpt — Maillard browning | After Priya's browning comment at first dinner party |

**Commercial product tasting (1 entry)**

| Position | Tone & Content                                                                                                                                                                                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13       | Alex buys a fresh ramen kit from the grocery store. "The noodles are exactly the texture I want. Springy, slightly alkaline. If a grocery kit can do this, then kansui is probably part of what I'm missing — but it can't be the whole thing. Flour, hydration, sheeting, resting. Technique problem." Short entry, purely analytical. |

### Expected Assertion Totals

~70 assertions across ~25 episodes:

- ~8 supersessions (technique abandoned or understanding replaced)
- ~18 `deepens` links (most common — understanding accumulates)
- ~10 `qualifies` links (works but only under specific conditions)
- ~7 `contradicts` links (guest feedback vs online recipe, experiments with opposite results)
- ~5 `contextualizes` links (food science explaining an experimental observation)
- ~10 `measures` links (sourdough metrics, ramen broth scores across attempts)
- ~4 `resolution` assertions (open questions answered)
- ~3 `pattern` assertions (observable across multiple episodes)

### What It Exercises

| Capability          | How it appears                                                                  |
| ------------------- | ------------------------------------------------------------------------------- |
| Supersession        | Cold retard abandoned for room-temp proof                                       |
| `deepens`           | Each ramen attempt builds on the last; food science explains observations       |
| `qualifies`         | "High hydration works but only with bread flour"                                |
| `contradicts`       | Mrs. Park vs. online recipe; Sam vs. Alex's self-assessment                     |
| `contextualizes`    | Food science articles reframing experimental observations                       |
| `measures`          | Sourdough metrics tracked across 8 bakes                                        |
| `resolution`        | Sam's sourness complaint resolved by third dinner party                         |
| `pattern`           | Jordan consistently prefers simpler dishes (observable across 3 dinner parties) |
| Trajectory mode     | "How has my ramen broth technique evolved?"                                     |
| Temporal snapshot   | "What did my guests think at the March dinner?"                                 |
| Multiple citations  | The pattern assertion about Jordan cites all three dinner party episodes        |
| `expandLinks: true` | "What food science explains my cloudy broth?" pulls the contextualization chain |

### Query Set

**"What do I currently know about sourdough hydration?"** — snapshot at latest position. Should return current understanding including the whole wheat qualification.

**"How has my ramen broth technique evolved since the restaurant visit?"** — trajectory mode on entity `miso-ramen-broth`. Should return the full chain from first observation through four home attempts, with food science contextualizations attached via links.

**"What did my guests think of the bread at the first dinner?"** — temporal snapshot at position 20. Should return Sam's "too sour" feedback.

**"What food science explains my cloudy broth?"** — retrieve with `expandLinks: true` and `maxDepth: 2`. Should walk from the cloudy broth observation (position 9) → via `contextualizes` link to the Ito paitan assertion (position 11) → via `deepens` link to the second ramen attempt where the technique was successfully applied (position 14). This is a genuine multi-hop traversal: the query starts at a problem, walks through the explanation, and arrives at the solution. The output should show each hop and the link type connecting them.

**"What have I tried that didn't work?"** — retrieve superseded assertions (`includeSuperseded: true`). Should return abandoned techniques: cold retard, baking soda noodles, the online kimchi jjigae recipe.

**"What contradictions haven't I resolved yet?"** — retrieve assertions with active `contradicts` links where both assertions are still valid.

**"What has Jordan said about my cooking?"** — entity-filtered query. Should surface Jordan's feedback across all three dinner parties, including the pattern assertion about preferring simpler dishes.

**"What would Dad think?"** — this query should return very little. There are glancing references — the sourdough entry, perhaps one other — but the store correctly reflects that Alex's journal doesn't dwell here explicitly. The near-miss is the point: the system doesn't hallucinate significance that isn't in the source material.

**"Why did my first ramen attempt fail?"** — a semantic query. Alex's journal entry for position 9 describes the broth as "thin and cloudy" and Jordan says it tastes like "pork water," but the word "fail" never appears. Semantic retrieval should find this via conceptual similarity while BM25 would miss it. The output should annotate score components showing semantic distance as the dominant signal.

**"What did Mrs. Park teach me?"** — should retrieve both the kimchi jjigae feedback and the miso tare toasting technique. These are in different episodes (positions 22 and 23) but both reference entity `mrs-park`. Demonstrates entity-based retrieval across temporally separated episodes.

### Output Format

Same annotated terminal format as Demo 1. Each main retrieval query is followed by an assembled-context answer: a grounded prose response generated from `assembleContext()` using the retrieved temporal context. In fixture mode this is a deterministic template summary; in live mode it is an LLM synthesis constrained to the assembled context. Both demos also output a final narrative summary at the end. Alex's Place keeps a pre-written offline final narrative fixture, while Know Thyself uses the deterministic template fallback offline. These flows demonstrate the downstream pattern trageti is designed to support: temporal retrieval feeding assembled context, then context feeding synthesis.

Alex's Place also supports `--query "<question>"` under the same live-embedding-only rule as Demo 1. Custom-query mode skips the default Alex query set, Dad entity-history follow-up, and final narrative summary so the output focuses on the user's question.

---

## Package Structure

```
demos/
├── shared/
│   ├── ingest.ts              — core ingestion function
│   ├── prompt.ts              — default extraction prompt template
│   ├── providers.ts           — extraction and embedding provider resolver
│   ├── parse.ts               — JSON parsing with error recovery
│   ├── output.ts              — terminal output formatting
│   └── synthesis.ts           — assembled-context answer and narrative helpers
├── know-thyself/
│   ├── README.md              — description, setup, annotated output
│   ├── index.ts               — main entry point
│   ├── queries.ts             — query set with annotations
│   ├── generate-episodes.ts   — build episodes from git keyframes (requires git history)
│   ├── generate-fixtures.ts   — run extraction over episodes (requires LLM)
│   ├── narrative.ts           — final synthesis pass
│   └── data/
│       ├── keyframes.ts       — hand-curated commit manifest (only manual input)
│       ├── sources/           — reviewed keyframe source documents
│       ├── sources.ts         — source registry for citation-span resolution
│       ├── episodes.ts        — episode objects with temporal summaries
│       ├── aggregations.ts    — compact source-summary index
│       ├── fixtures.ts        — extraction output (assertions, links, citation spans)
│       └── embeddings.ts      — pre-computed embedding vectors per assertion
└── alex-place/
    ├── README.md
    ├── index.ts
    ├── queries.ts
    ├── generate-fixtures.ts
    ├── narrative.ts           — synthesis pass generating prose summary
    └── data/
        ├── episodes.ts        — episode definitions referencing journal entries
        ├── fixtures.ts        — pre-generated LLM extraction output
        ├── embeddings.ts      — pre-computed embedding vectors per assertion
        ├── alex.md            — Alex's full journal (all entries, chronological)
        └── references/        — supplementary fictional food-science documents
```

---

## Execution Modes

Each demo supports three execution modes determined by environment:

| Mode                  | Trigger                                          | Behavior                                                                 |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| **Live (Anthropic)**  | `ANTHROPIC_API_KEY` set                          | Anthropic Messages API. Highest quality.                                 |
| **Live (OpenAI)**     | `OPENAI_API_KEY` set                             | OpenAI API or any compatible endpoint.                                   |
| **Live (OpenRouter)** | `OPENROUTER_API_KEY` set                         | OpenRouter (OpenAI-compatible, many models).                             |
| **Live (Ollama)**     | `OLLAMA_HOST` set or Ollama running on localhost | Local Ollama via its OpenAI-compatible endpoint. Free, variable quality. |
| **Fixture**           | None of the above available                      | Committed fixture files. Deterministic, offline, CI-safe.                |

The fixture path is the default — demos must always work without any external dependency. The README for each demo documents all modes.

### CI Integration

The demos run in CI using fixtures. The CI job:

1. Installs dependencies
2. Runs each demo via `npx tsx demos/<name>/index.ts`
3. Asserts that the exit code is 0 and that expected query results appear in stdout

This is a lightweight integration test that verifies the demos work and that the API surface they exercise hasn't broken.

---

## Writing Alex's Journal

The journal entries in `alex.md` are the creative heart of this demo and need to be written with care. They should feel like they were written by a real person for themselves, not by a developer constructing a test case. Some guidelines:

**Voice.** Alex writes quickly and informally. Incomplete sentences are fine. Exclamation marks are genuine, not performative. Technical observations and emotional asides coexist in the same paragraph because that's how people think. Alex sometimes addresses the journal directly ("Note to self:") and sometimes just narrates.

**Inconsistency is realistic.** Some entries are detailed and analytical. Some are three sentences. The gap between entries varies — sometimes daily during an intense cooking stretch, sometimes two weeks of silence. Alex doesn't always explain why. The reader can infer.

**The father.** He appears only through Alex's offhand references. Never a dedicated entry, never a direct explanation. A phrase here and there: "Dad's Sunday stock," "he would have liked this one." The extraction system should pick up these references as low-confidence assertions with the entity ID `alex-father` — and the "What would Dad think?" query should correctly return very little, because Alex doesn't write about this directly. The restraint is the point, both narratively and as a demonstration that the system doesn't over-extract.

**Culinary school.** Similarly oblique. Alex mentions "school" a few times, always in passing. "This is what we were working on before I left." "Chef Morales used to say..." Never a full account of why Alex left or what happened. The journal is forward-looking; Alex is building toward something, not relitigating the past.

**The ambition.** It's real but tempered. Alex isn't delusional — they know they're behind, they know the gap between home cooking and professional cooking is enormous. But they're working. The last journal entry should land with quiet earned confidence, not triumph: the food was good tonight. Not close to the dream, but possible. Someday. Eventually.

---

## Open Questions

**Extraction quality variance.** The shared extraction prompt produces good results with Claude and acceptable results with larger Ollama models. Smaller local models may produce unparseable JSON or miss supersession relationships. The fixture path makes this a non-issue for the demos themselves, but the README should be honest about extraction quality being model-dependent.

**Context length vs. diff accuracy.** The `--context-length` parameter on `generate-episodes.ts` controls how much of the full diff is included in the aggregation call. With a small budget (4K–8K), large diffs between keyframes will be truncated and the aggregation summary may miss changes at the tail end. With a large budget (32K+), most diffs fit entirely but the LLM call is more expensive. The default (8192) is conservative; the README should recommend higher values when using cloud models.

**Narrative synthesis.** Query-level answers and final narrative summaries are now shared demo behavior. Fixture runs use deterministic template summaries except for Alex's final narrative, which remains a clearly labeled pre-written synthesis. Live runs add LLM calls for each synthesized answer and final narrative, so the trace output should be used when evaluating provider cost and latency.

**Reference document sourcing.** The Alex demo should use fictional food-science documents that make the same culinary points without reproducing real published excerpts. The extraction system can also pull assertions from Alex's description of what they learned without needing source text from real books or articles.

**Additional demos.** The following scenarios were considered and deferred. They remain candidates for future additions:

- Incident postmortem timeline (SRE team tracking root cause evolution)
- Legal case chronology (facts and positions evolving through discovery)
- Research literature review (papers that supersede or qualify earlier findings)
- Project decision log (ADRs evolving over sprints; BM25-only deployment)
- Coffee brewing journal (obsessive variable tracking)
- Book club reading log (thematic observations deepening across books)
- Homelab infrastructure log (config changes and troubleshooting)
- Job search journal (evolving self-knowledge)
