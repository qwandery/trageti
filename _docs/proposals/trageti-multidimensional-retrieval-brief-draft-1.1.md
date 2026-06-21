# Trageti: Multidimensional Retrieval Brief

## A Layered Architecture for Temporal, Categorical, Relational, and Spatial Knowledge Retrieval

**Technical Brief — Draft v1.1**
**Brian Lacy, Qwandery, Inc.**
**June 2026**

---

## Abstract

Current retrieval-augmented generation (RAG) systems treat knowledge as a flat collection of text chunks retrieved by vector similarity, discarding temporal validity, structural relationships between entities, spatial context, provenance chains, and the categorical structure that makes retrieved knowledge actionable. Graph-based RAG approaches (GraphRAG, LightRAG, TagRAG, TeaRAG) address structural deficiencies by introducing knowledge graphs, but none account for when knowledge became valid, whether it has been superseded, or how understanding evolved over time. Temporal knowledge stores, meanwhile, lack the structured annotation and graph-based retrieval capabilities that make graph RAG systems efficient. And no general-purpose RAG library composes any of these with spatial awareness.

This brief describes the planned evolution of **Trageti** — a TypeScript/SQLite temporal RAG library — into a unified multidimensional retrieval system, delivered in five incremental, independently shippable layers:

1. **Tag chains and cascade scoring** — a lightweight categorical annotation primitive with interpretable, near-zero-cost relevance ranking
2. **The tag graph and deterministic completeness** — emergent concept-graph structure with mathematically enforced annotation coverage
3. **Entities and relationships** — a full temporal knowledge graph with typed, time-scoped connections
4. **Spatial awareness** — geometry-typed entity properties with proximity-filtered retrieval
5. **Polish** — provenance objects, result budgets, diagnostics, and intention-aware retrieval

Each layer adds one retrieval dimension. The dimensions compose: a single retrieval call can simultaneously constrain by concept (tag chains), time (temporal modes), connection (entity relationships), and place (spatial proximity) — producing result sets that are categorically precise, temporally coherent, structurally aware, and geographically scoped. No existing RAG library offers this composition.

Throughout, the governing design rule is: **complexity lives in the system, not in the interface.** The full API surface remains small enough to learn in minutes, with smart defaults at every level and optional depth for those who need it.

---

## 1. Problem Statement

### 1.1 Limitations of Flat RAG

Standard RAG pipelines embed documents into vector space and retrieve the top-k chunks most similar to a query. This approach suffers from three fundamental limitations. First, all retrieved content is treated as equally current — a claim written three years ago and a claim written yesterday carry equal weight. Second, the relationships between retrieved chunks are invisible — the system cannot distinguish between two chunks that describe the same entity and two that are entirely unrelated. Third, the retrieval signal (cosine similarity on embeddings) is expensive, opaque, and imprecise for categorically structured knowledge.

### 1.2 Limitations of Graph RAG

Graph-based RAG systems address the structural limitation by extracting entities and relationships from documents and building knowledge graphs. However, these systems share a common deficiency: they are temporally naive. A knowledge graph constructed from a corpus treats every extracted triplet as equally valid. If a document from 2022 states "Alice is the CEO" and a document from 2024 states "Bob is the CEO," both triplets coexist in the graph with no indication that the latter supersedes the former. The graph reflects everything that was ever true, with no mechanism for distinguishing what is currently true, what was true during a specific period, or how understanding evolved.

Additionally, existing graph RAG systems rely on expensive LLM-based entity extraction during indexing (GraphRAG's reported $33K cost for large datasets), require cloud-scale infrastructure (Neo4j, Redis, PostGIS), and produce graphs that are difficult to update incrementally.

### 1.3 The Missing Synthesis

No existing system combines temporal knowledge semantics (when claims are valid, how they evolve, what supersedes what) with structured graph-based retrieval (entity-relationship traversal, path-based relevance scoring), lightweight categorical annotation (structured metadata enabling retrieval cheaper than vector similarity), and spatial awareness (proximity and containment as retrieval dimensions) — in a single local-first library with a small, learnable API. This brief describes such a system, built layer by layer on Trageti's existing temporal foundation.

---

## 2. The Foundation: Trageti's Existing Temporal Core

The layers described in this brief build on capabilities Trageti already provides (as of v0.3):

**Episodes** — discrete units of observed or recorded experience anchored to temporal positions. A therapy session transcript, a meeting note, a document ingestion event. Episodes are the provenance root; all other objects trace lineage back to one or more episodes.

**Assertions** — discrete claims extracted from episodes, each carrying temporal validity (`validFrom`, optional `validTo`), a confidence score, and supersession references. The supersession chain — the linked sequence of assertions that replaced one another — is a first-class queryable structure.

**Temporal retrieval modes** — Snapshot (what is currently true), Window (what was valid during a range), and Trajectory (how understanding evolved, via supersession chains).

**Hybrid search** — BM25 full-text search via SQLite FTS5, with optional vector similarity via sqlite-vec.

Every layer below extends this foundation. Nothing replaces it. Existing (as of v0.3) consumers upgrade without code changes; each layer's capabilities are additive and opt-in.

```typescript
// The foundation, as it exists in v0.3, simplified
const store = new Trageti('./knowledge.db');

await store.writeEpisode({ content: 'Session 15 with Client 42...' });
await store.writeAssertion({
  claim: 'Client reports improved sleep following medication adjustment',
  validFrom: 15,
  confidence: 0.85,
});

const current = await store.retrieve('client sleep', { mode: 'snapshot' });
const history = await store.retrieve('client sleep', { mode: 'trajectory' });
```

---

## 3. Layer 1 — Tag Chains and Cascade Scoring

### 3.1 The Annotation Primitive

A **directed tag chain** is a variable-length, ordered sequence of tags that annotates any object in the knowledge store. The ordering is semantically significant: `clinical > sleep > improvement > medication-change` means something different from any permutation of the same tags. Each position in the chain narrows or contextualizes the preceding position, moving from broad domain to specific aspect.

A chain is a **position in concept space** — like a street address positions a building in geographic space (state > city > street > number), a chain positions a record in conceptual space (domain > topic > subtopic > aspect). Records with nearby positions are related; the chain comparison function measures exactly how nearby.

Any record may carry multiple chains, positioning it simultaneously in several conceptual hierarchies. An assertion might carry `clinical > sleep > improvement` (the clinical-domain facet) and `client-42 > session-15 > outcome` (the organizational facet). Neither facet is privileged; queries can approach from either direction.

```typescript
await store.writeAssertion({
  claim: 'Client reports improved sleep following medication adjustment',
  validFrom: 15,
  chains: [
    'clinical > sleep > improvement > medication-change',
    'client-42 > session-15 > outcome',
  ],
});
```

### 3.2 Cascade Scoring

The relevance between a query chain and a candidate's chains is computed by a cascading scoring function with four tiers, evaluated in priority order:

**Tier 1 — Equality (highest).** The chains are identical. Maximum relevance.

**Tier 2 — Specificity.** The chains share a directed prefix. `clinical > sleep > improvement` against `clinical > sleep > improvement > medication-change` shares a depth-3 prefix. Score scales with shared prefix depth relative to chain length. Deeper shared paths mean more specific overlap.

**Tier 3 — Similarity.** The chains contain the same tags regardless of order. `clinical > sleep > improvement` against `improvement > sleep > clinical` shares all three tags but no directed path — shared conceptual territory, different structural meaning. Scored by tag-set overlap, weighted below specificity.

**Tier 4 — Direction (lowest, nonzero).** Among similarity-tier matches, directional agreement breaks ties: same tags in similar order score above same tags in reversed order. Scored by longest common subsequence.

The cascade degrades gracefully — a relevance signal exists at every level of match quality, down to "shares one tag somewhere." And every tier is computationally cheap: string comparison, prefix matching, set intersection. No embeddings, no model calls. With B-tree prefix indexes on delimited chain strings, candidate filtering is O(log n).

```typescript
// Chain-scoped retrieval: the chain acts as both filter and ranking signal
const results = await store.retrieve('sleep progress', {
  scope: 'clinical > sleep',     // only records positioned under this path
  mode: 'snapshot',              // only currently-valid assertions
});

// Each result explains its own relevance
results[0].match;
// → { signal: 'chain', tier: 'specificity', depth: 3,
//     chain: 'clinical > sleep > improvement > medication-change' }
```

### 3.3 Why This Layer First

Tag chains are the highest-value, lowest-complexity addition to the existing system. They require no new object types, no graph machinery, and no ingestion pipeline changes — just an optional annotation field and a scoring function. Records without chains continue to retrieve via BM25/vector exactly as before.

The immediate benefits:

- **Interpretable retrieval.** "Matched on prefix `clinical > sleep` at depth 2" is an explanation a human or AI can act on. Cosine distance 0.83 is not.
- **Cheap pre-filtering.** Chain scoping eliminates the majority of irrelevant candidates before BM25 or vector search runs, cutting retrieval cost and improving precision simultaneously.
- **Implicit communities.** Records sharing chain prefixes form natural topical clusters — what GraphRAG achieves with Leiden clustering and LLM-generated community summaries falls out of the annotation structure for free.

**Reference example.** A therapy-notes application queries `scope: 'clinical > medication'` to assemble a medication-history summary. Without chains, the same query requires vector search plus an LLM filtering pass to discard the false positives ("medication" mentioned in passing). With chains, the filter is structural and exact.

---

## 4. Layer 2 — The Tag Graph and Deterministic Completeness

### 4.1 The Emergent Graph

The full set of tag chains across all records collectively defines an emergent directed acyclic graph — the **tag graph**. When one assertion carries `clinical > sleep > improvement` and another carries `clinical > sleep > disruption`, the graph implicitly contains a node `sleep` (under `clinical`) with outgoing edges to `improvement` and `disruption`.

The developer never builds this graph, never manages nodes, never runs a construction step. They write records; the graph emerges. Layer 2 materializes it internally — a lightweight nodes table and a directed edges table with usage weights, maintained automatically on every write the same way FTS5 maintains its term index. Materialization is an optimization for lookup speed; the chain annotations on records remain the source of truth.

The vocabulary is open and evolving — not a predefined hierarchy. Early use seeds it manually or from domain ontologies; structure emerges from usage. The library handles vocabulary hygiene internally: case normalization, near-duplicate detection (`clinical > sleep` vs `Clinical > Sleep`), orphaned-branch identification.

### 4.2 The Retrieve-Before-Write Pattern

The central challenge of annotation is twofold: maintaining graph integrity (no synonym proliferation, no near-duplicate paths) while achieving annotation density (comprehensive, multi-faceted coverage). Layer 2 solves both with a single pattern: **before annotations are generated, the library surfaces the relevant existing graph structure.**

The write path becomes a two-step conversation:

```typescript
// Step 1: the library analyzes content and returns annotation context
const ctx = await store.prepareWrite(
  'Dec 11 — John spoke to Sally about the house on 37th Street in Westover'
);

ctx.terms;
// → ['John', 'Sally', '37th Street', 'Westover', 'house']   (TF-IDF, deterministic)

ctx.segments;
// → ['contacts > sally-chen', 'contacts > sally-chen > properties',
//    'properties > westover > 37th-street', 'team > john']   (BM25 edge lookup)

ctx.suggestedChains;
// → ranked deterministic candidates assembled from existing segments

// Step 2: the agent (or AI) assembles final chains from these building blocks
// and commits the write
await ctx.commit({
  chains: [
    'contacts > sally-chen > properties > westover > 37th-street',
    'team > john > activities > client-meetings',
  ],
});
```

Three stages, two of them fully deterministic:

**Stage 1 — Key term extraction.** TF-IDF term weighting over the existing corpus identifies the content's most discriminating terms. No model call; sub-millisecond.

**Stage 2 — Tag graph edge lookup.** Each term is searched via BM25 against the tag graph's nodes and *edges* — directed tag pairs, because edges carry structural context that isolated tags don't. Finding the edge `sally-chen > properties` tells the assembler an existing directed relationship to reuse. Sub-millisecond against a graph of hundreds to low thousands of nodes.

**Stage 3 — Constrained assembly.** The AI (at the agent layer) assembles complete chains from the retrieved building blocks, reusing existing paths and proposing new tags only where nothing fits. This is selection-and-combination, not open generation — a task small local models handle reliably, in under ~1,000 tokens. In well-established graph regions, the deterministic `suggestedChains` from Stage 2 are often sufficient with no AI call at all.

### 4.3 Deterministic Completeness Guarantees

Layer 2's second pillar: the library establishes a **mathematically derived coverage floor** that annotations must satisfy. The library never generates semantic annotations — that's the agent's job — but it deterministically verifies that nothing significant goes unaddressed.

**Term coverage validation.** The TF-IDF terms from Stage 1 form a coverage checklist. Submitted annotations must collectively address every checklist term. If they don't, the write returns a structured rejection naming each gap:

```typescript
const result = await ctx.commit({ chains: ['team > john > meetings'] });

result.ok;        // → false
result.uncovered; // → ['Sally', 'Westover', '37th Street']
// The agent now has a bounded gap-filling task, not an open-ended
// "did I annotate thoroughly enough?" judgment call.
```

This transforms completeness from trust-the-model into a deterministic constraint — the annotation equivalent of `NOT NULL`. Even the least capable consuming model gets told exactly what it missed.

**Retrieval self-test.** Optionally, after accepting annotations, the library executes a retrieval using those annotations and verifies the record appears in its own results. A record that can't be found by its own chains has structurally broken annotations. Deterministic, end-to-end, configurable as warning or rejection.

**Coverage signals on retrieval.** Every retrieval result reports which signal found it. A record reached only via BM25/vector fallback — bypassing chain scoring — is flagged: its annotations are incomplete for this query pattern. The library detects and reports; remediation (retroactive enrichment) is agent territory.

```typescript
results[3].match;
// → { signal: 'bm25-fallback', chainCoverage: 'none' }
// ← implicit signal: this record is relevant but under-annotated
//   for this query shape. The agent may enrich it.
```

### 4.4 Why This Layer Matters

Layer 2 is where Trageti diverges from every annotation-dependent system in the literature. TagRAG, GraphRAG, and TeaRAG all trust their extraction pipelines and offer no coverage guarantees. Trageti makes annotation failures **visible, preventable, and cheap to detect** — deterministically, at write time, with structured errors that double as agent instructions.

**Reference example.** An autonomous ingestion agent processes a folder of meeting notes overnight on a Mac Mini. With term coverage validation enabled, every note either commits with verified-complete annotations or queues with a precise gap list for a second pass. The morning's knowledge store has no silent annotation holes — without a human reviewing a single record.

---

## 5. Layer 3 — Entities and Relationships

### 5.1 The Temporal Knowledge Graph

Layer 3 promotes entities from string references to first-class temporal objects, and adds relationships as typed, directed, temporally scoped connections between them.

**Entities** are persistent objects of interest — clients, providers, medications, characters, locations, projects. They carry typed properties, each with its own temporal validity. Properties change over time; the entity persists as a stable reference point.

**Relationships** are directed, typed edges between entities — and critically, they are *temporally scoped assertions about connections*, not static graph edges. "Client-42 is-treated-by Dr. Garcia" carries `validFrom: 16` (when care transferred), a confidence score, and provenance back to the episode documenting the transition. When Dr. Garcia hands off to another provider, the relationship is superseded, not overwritten — the care history remains queryable.

```typescript
await store.writeEntity({
  id: 'client-42',
  type: 'client',
  properties: { status: 'active' },
  chains: ['clients > active'],
});

await store.writeRelationship({
  from: 'client-42',
  to: 'dr-garcia',
  type: 'is-treated-by',
  validFrom: 16,
  confidence: 0.95,
  chains: ['clinical > care-team'],
});
```

Entities and relationships participate in everything the previous layers built: they carry tag chains, appear in the tag graph, pass through retrieve-before-write, and are subject to coverage validation. The data model widens; the mental model doesn't. Everything in the store has a position in time and a position in concept space — entities and relationships included.

### 5.2 Entity Co-occurrence Validation

Layer 2's completeness machinery extends naturally: the library maintains a BM25-searchable entity index, and when new content mentions two or more known entities, a relationship annotation between them is *expected*. Missing relationships produce structured rejections, exactly like uncovered terms. Existing relationships between the co-occurring entities are surfaced in the write context so the agent can decide whether they already cover the new content.

```typescript
const ctx = await store.prepareWrite('John met Sally to finalize the Westover listing');

ctx.entities;
// → [{ id: 'john', matched: 'John' }, { id: 'sally-chen', matched: 'Sally' }]

ctx.existingRelationships;
// → [{ from: 'john', to: 'sally-chen', type: 'works-with', validFrom: 3 }]
// The agent sees the expectation AND the existing context in one response.
```

### 5.3 Relational Retrieval

Retrieval gains an entity dimension and a fourth temporal mode:

```typescript
// Entity-scoped: everything currently true about Client-42
await store.retrieve('treatment status', { entity: 'client-42', mode: 'snapshot' });

// Traversal: entities connected to Client-42, one hop out, currently valid
await store.retrieve('care network', {
  entity: 'client-42',
  traverse: { depth: 1, types: ['is-treated-by', 'prescribed'] },
});

// Graph mode: the relationship neighborhood as compressed directed edges —
// structure first, full assertions on demand
await store.retrieve('client-42', { mode: 'graph' });
// → [{ from: 'client-42', to: 'dr-garcia', type: 'is-treated-by',
//      since: 16, confidence: 0.95 }, ...]
// Token-efficient structural overview, in the spirit of TeaRAG's triplet
// compression — but every edge is temporally scoped.
```

Hop distance and relationship confidence feed relevance scoring: closer, higher-confidence connections rank above distant, uncertain ones.

### 5.4 Why This Layer Matters

This is where the system becomes a genuine temporal knowledge graph — and where every comparison system falls short simultaneously. GraphRAG has entity graphs but no time. Graphiti has temporal edges but requires Neo4j and Python. T-RAG has entity hierarchies but they're static and manually maintained. Layer 3 delivers temporally scoped entity-relationship structure in embedded SQLite with annotation-driven retrieval on top.

**Reference example.** "How has Client-42's care team changed this year?" is a Trajectory-mode query over relationship supersession chains — one call. The equivalent in any existing RAG library is an application-level reconstruction: retrieve everything mentioning the client, parse provider mentions, infer transitions, hope the LLM gets the chronology right.

---

## 6. Layer 4 — Spatial Awareness

### 6.1 Scope Discipline

Trageti is a temporal knowledge library with spatial awareness — **not a GIS engine**. The line is drawn precisely:

**In the library:** geometry as an entity property type (point; optionally polygon for regions), automatic spatial indexing, and proximity/containment as retrieval filter dimensions.

**Below the abstraction:** the full SpatiaLite function set (spatial joins, buffering, topological analysis), available to consuming applications through the raw SQLite connection for advanced use cases — without any of it appearing in Trageti's API surface.

**Not in scope:** raster data, coordinate system transformation pipelines, multi-agent spatial reasoning, executable spatial programs. Systems like GeoAgentic-RAG demonstrate these belong at the application layer, built atop a spatially aware store.

### 6.2 Implementation Basis

Spatial support is backed by **SpatiaLite** — the SQLite-native spatial extension — rather than a naive haversine-on-columns implementation. This matters: SpatiaLite provides correct geodesic distance computation, proper R-tree spatial indexing, and fifteen-plus years of production hardening. Spatial queries that "mostly work" fail at boundaries (antimeridian, poles, projection edge cases) in ways that silently corrupt results. The library takes the proven dependency, keeps it optional, and hides it entirely behind a property type and a filter parameter.

```typescript
await store.writeEntity({
  id: 'dusty-gulch-saloon',
  type: 'location',
  location: { lat: 41.74, lng: -111.83 },     // geometry property; R-tree indexed automatically
  chains: ['places > settlements > dusty-gulch'],
});
```

### 6.3 Spatial Retrieval

One new filter parameter, composing with every existing dimension:

```typescript
// Proximity: what's near this point?
await store.retrieve('trouble brewing', {
  near: { lat: 41.74, lng: -111.83, radius: 20_000 },   // meters
  mode: 'snapshot',
});

// Or anchor on an entity's location
await store.retrieve('recent events', {
  near: { entity: 'dusty-gulch-saloon', radius: 5_000 },
  mode: 'window', range: [40, 55],
});
```

Distance contributes to relevance scoring: nearer results rank higher within the radius, composing with chain tier and temporal recency.

### 6.4 The Four-Dimensional Query

With Layer 4, a single retrieval call constrains by concept, time, connection, and place simultaneously:

```typescript
// "What does Sheriff Cole currently know about cattle rustling
//  near Dusty Gulch, through people he's met?"
await store.retrieve('cattle rustling', {
  scope: 'events > crimes',                              // concept
  mode: 'snapshot', at: 47,                              // time
  entity: 'sheriff-cole', traverse: { depth: 1 },         // connection
  near: { entity: 'dusty-gulch', radius: 30_000 },        // place
});
```

Each dimension is optional; each one specified narrows the result set. No existing RAG library — flat, graph-based, or temporal — can express this query at all, let alone in one call.

**Reference example.** A fiction-world simulation engine generates events for a frontier town. Before writing "the stagecoach robbery becomes common knowledge in Dusty Gulch," it queries what each character *could* know: events within plausible travel/communication range of their location, within the relevant time window, connected through their relationship network. Spatial scoping makes information propagation realistic by construction — characters in the distant capital don't mysteriously know about yesterday's robbery. The same dimensional composition serves field-service apps ("open issues near this technician, on equipment she's certified for"), clinical networks ("providers within the client's county currently accepting referrals"), and local-knowledge assistants.

---

## 7. Layer 5 — Polish

Layer 5 collects the refinements that complete the system. None is individually large; each is added when a consuming application demonstrates the need rather than speculatively.

### 7.1 Sources and Citations as Explicit Objects

**Sources** — the origins of episodes (documents, recordings, data feeds) — become first-class objects carrying provenance, format, and trust metadata that propagates to derived records. **Citations** — structured links from assertions and relationships back to specific source passages — enable full provenance tracing: any claim resolves to the exact material it derives from.

```typescript
const result = await store.retrieve('medication change', { entity: 'client-42' });

await result[0].trace();
// → { assertion: '...', episode: 'session-15-transcript',
//     source: { type: 'audio-transcription', file: 's15.wav' },
//     excerpt: 'and since we adjusted the dosage I've been sleeping...' }
```

### 7.2 Result Budgets

A configurable maximum result count per call. When more candidates survive filtering than the budget allows, the library returns the top-ranked results plus the total: `{ results: [...10], totalMatches: 147 }`. Defaults are conservative, tuned to small-model context windows.

### 7.3 Query Specificity Feedback

Under-constrained queries become self-diagnosing. Diagnostic metadata accompanies every result set: total match count, score distribution across cascade tiers, and per-dimension selectivity —

```typescript
result.diagnostics;
// → { totalMatches: 312, selectivity: { chain: 0.05, temporal: 0.90, spatial: null } }
// ← "the chain scope barely narrowed anything; the temporal filter did the work;
//    no spatial constraint was applied." Actionable refinement guidance, free to compute.
```

### 7.4 Traversal Depth Limits

Hub entities (a provider treating forty clients) make unbounded traversal explode. Configurable max hop depth (default 1–2), with deeper results score-decayed so hub fan-out sinks in the ranking even when limits are raised.

### 7.5 Intention-Aware Mode Selection

Mode and signal weighting can be inferred from query shape when not explicitly specified: "what is currently…" → Snapshot; "how has … evolved" → Trajectory; "who is connected to…" → Graph with traversal. Explicit parameters always win; inference is a convenience layer for the simplest call sites, implementable as a lightweight classification either in-library (heuristic) or at the agent layer (model-assisted).

---

## 8. The Unified Retrieval Model

### 8.1 One Mental Model

Everything in the store has a **position in time** and a **position in concept space** — and optionally, connections to other things and a position in physical space. Retrieval finds records near the query across whichever dimensions the query specifies. That single sentence is the entire system. Every layer is machinery serving it.

### 8.2 One Write Path, One Read Path

The API surface stays on an index card across all five layers:

```typescript
const store = new Trageti('./knowledge.db');

// ── Writing ──────────────────────────────────────────────
store.writeEpisode(...)       // raw experience
store.writeAssertion(...)     // claims          (+ chains, Layer 1)
store.writeEntity(...)        // things          (Layer 3; + location, Layer 4)
store.writeRelationship(...)  // connections     (Layer 3)
store.prepareWrite(...)       // annotation context + validation (Layer 2)

// ── Reading ──────────────────────────────────────────────
store.retrieve(query, {
  mode?: 'snapshot' | 'window' | 'trajectory' | 'graph',
  scope?: TagChain,                       // concept dimension
  entity?: EntityId, traverse?: {...},    // connection dimension
  near?: {...},                           // spatial dimension
  limit?: number,
})
```

Level zero — `store.retrieve('how is the client sleeping?')` — is a working system with smart defaults. Each optional parameter adds one concept and narrows the results. A developer who never learns past level zero still gets temporally coherent, cited, ranked results; a developer who needs all four dimensions adds parameters to the same call, not a different system.

### 8.3 Multi-Signal Retrieval Under the Hood

Internally, every retrieve call runs a cost-ordered signal cascade, invisible to the caller:

1. **Tag chain scoring** — O(log n) prefix/set operations eliminate most candidates first
2. **Temporal filtering** — validity windows and supersession via the selected mode
3. **Entity-relationship traversal** — when an entity anchor is given; hop distance and confidence feed scoring
4. **Spatial filtering** — R-tree index pass when `near` is given
5. **BM25 keyword matching** — on the narrowed candidate set
6. **Vector similarity** — most expensive; last; only on the smallest surviving set, or as fallback when chains are sparse

The expensive signals run on the fewest records. This is structural token-and-compute efficiency — the result TeaRAG achieves through DPO fine-tuning, achieved here through cheap deterministic pre-filters. (Whether each dimension acts as a hard filter or a ranking signal, and the order in which constraints are applied, follows the semantics defined in Section 9.)

### 8.4 The Precision Inversion

Traditional RAG demands a sophisticated consumer: elaborate query crafting, reranking, post-hoc filtering. This architecture inverts the burden. Each query dimension is a filter; dimensional intersection narrows multiplicatively; cascade tiers stratify whatever survives into well-separated relevance bands. Comprehensive annotation doesn't create noise — it creates precision surfaces queries cut across. In flat vector RAG, richer data makes retrieval fuzzier; here, richer annotation makes retrieval *sharper*.

The consuming agent's job reduces to: state what you want across the dimensions you know, take the top results. Combined with interpretable match explanations and structured validation errors, the system is as easy to use stupidly as it is to use well — the intelligence lives in the library, which is precisely what makes it dependable infrastructure for small, resource-constrained local models.

---

## 9. Retrieval Semantics, Scoring, and Trade-offs

Multi-dimensional retrieval introduces design tensions that single-signal systems never face: hard filtering trades recall for speed, cross-dimensional ranking risks either brittleness or uninterpretable magic numbers, and intersecting constraints can silently produce empty results. This section makes the library's positions on these trade-offs explicit. The governing priority is **capability over speed**: the consumer must be able to get genuinely relevant results, across dimensions, every time such results exist in the store. Performance matters; recall is non-negotiable.

Throughout, behavior follows a consistent configuration hierarchy: **sane defaults**, overridable by **library-level configuration**, overridable by **query-level parameters**, with **custom implementation surfaces** (pluggable scoring and planning strategies) for consumers with needs the defaults can't anticipate. Specificity is always available and never required.

### 9.1 Recall First: Ranking by Default, Filtering by Request

A strict sequential cascade — chain scoring eliminating candidates before BM25 and vector ever run — is fast precisely because it is recall-risky. A record that is genuinely relevant but under-annotated would die at the first stage, and the signals that *would* have found it never get the chance. This failure mode is most severe early in a store's life, when annotation density is lowest — exactly when users form their first impression of retrieval quality.

The library therefore treats the chain dimension as a **ranking signal by default and a hard filter only when explicitly scoped**:

- `retrieve('sleep issues')` — chains *score*. Chain-matched records rank above fallback matches, but BM25 and vector search still run over the unscoped corpus. Under-annotated records surface, flagged as fallback matches (`signal: 'bm25-fallback'`) — which doubles as the Layer 2 coverage signal, turning every recall save into an annotation-gap report.
- `retrieve('sleep issues', { scope: 'clinical > sleep' })` — the caller has explicitly restricted concept space. Chain matching becomes a hard pre-filter, and the efficiency benefit of candidate elimination kicks in.

The same principle generalizes: no dimension silently discards results the caller didn't ask to have discarded.

### 9.2 Constraints vs. Preferences

`near: { radius: 20_000 }` can mean two different things: *"results outside 20km are wrong"* (a constraint — a character cannot know about events beyond plausible information range; a clinical query must not return another client's records) or *"prefer nearby"* (a preference — a perfect match at 25km should still appear, ranked lower). Conflating the two is how multi-dimensional systems quietly produce garbage: hard-filtering a preference yields empty sets; soft-scoring a constraint yields invalid results.

The library makes the distinction explicit in query semantics, with per-dimension defaults chosen by the meaning of the parameter:

- **Constraints by default:** `scope` (an explicit slice of concept space) and `entity` (an explicit anchor). You asked for this slice; you get this slice.
- **Preferences by default:** `near` and temporal recency. They shape ranking; they do not exclude.
- **One flag to switch:** `near: { ..., strict: true }` promotes a preference to a constraint; `scope: { chain: '...', strict: false }` demotes a constraint to a boost. Library-level configuration can change the defaults for an application domain where the semantics differ.

```typescript
// Preference: nearby results rank higher; an excellent distant match still appears
await store.retrieve('cattle rustling', { near: { entity: 'dusty-gulch', radius: 30_000 } });

// Constraint: results beyond the radius are invalid for this query — exclude them
await store.retrieve('what does this character know', {
  near: { entity: 'dusty-gulch', radius: 30_000, strict: true },
});
```

### 9.3 Banded Scoring with Bounded Promotion

Cross-dimensional ranking has two failure modes at its extremes. **Strict lexicographic ordering** (chain tier, then recency, then distance) is interpretable and weight-free but brittle: chain tier dominates absolutely, so an equality-tier match from three years ago outranks a specificity-tier match from yesterday, forever, regardless of every other signal. **Weighted linear fusion** (`0.4·lexical + 0.3·spatial + 0.3·graph`) is flexible but produces meaningless magic numbers requiring per-domain calibration and uninterpretable rankings.

The library's default is the middle path: **banded scoring with bounded promotion**.

1. The chain cascade tier (equality > specificity > similarity > direction > fallback) assigns each result to a coarse **relevance band**. Bands preserve interpretability: a result is explainably "in the specificity band."
2. *Within* a band, a composed score of temporal recency, spatial proximity, traversal distance, and confidence performs fine ranking.
3. **Cross-band promotion is allowed but bounded:** a sufficiently overwhelming within-band score (very recent, very near, directly related) may lift a result one band — never more. The single tunable is the promotion threshold, not a weight vector.

Defaults make this invisible to most consumers. Library configuration exposes the promotion threshold and within-band weighting; the custom surface accepts a caller-supplied scoring function for consumers whose ranking semantics the defaults cannot express:

```typescript
const store = new Trageti('./knowledge.db', {
  scoring: {
    promotionThreshold: 0.9,          // library-level tuning
    // or full custom control:
    rank: (candidate, signals) => myDomainScore(candidate, signals),
  },
});
```

### 9.4 Selectivity-Ordered Constraint Application

"Cheapest signal first" is the right *cost* ordering, but *selectivity* is what actually shrinks candidate sets — and selectivity is query-dependent. `scope: 'clinical'` in a clinical store eliminates almost nothing; a three-position temporal window eliminates almost everything. Applying a non-selective constraint first is pure overhead.

Each dimension's index can estimate its match count cheaply before a full pass: a COUNT on a chain prefix index, an R-tree bounding-box count, an FTS5 match estimate. The library runs these estimates and applies constraints in ascending order of estimated survivors — a miniature query planner costing a few index counts per retrieval. Consumers never see this; a query-level escape hatch (`planner: 'fixed'` with an explicit dimension order) exists for pathological cases and benchmarking.

### 9.5 Empty Intersections Are Diagnosed, Never Silently Relaxed

Intersecting four constraints can legitimately yield zero results — and a bare empty set is uniquely unhelpful in a system whose premise is precision. When an intersection comes back empty, the result includes per-dimension survivor counts identifying which constraint eliminated the set, plus concrete relaxation suggestions:

```typescript
const result = await store.retrieve('cattle rustling', { ...fourConstraints });

result.results;       // → []
result.diagnostics;   // → { survivors: { scope: 41, temporal: 38, traverse: 12, spatial: 0 } }
result.relaxations;   // → [{ dimension: 'near', suggestion: { radius: 75_000 }, wouldMatch: 4 }]
```

The library never auto-relaxes a constraint behind the caller's back — that would violate the constraint/preference contract of 9.2. Preferences degrade gracefully by design (they only ever rank); constraints fail loudly with actionable guidance. The agent decides whether relaxation is semantically acceptable.

### 9.6 Performance Posture: Honest at Target Scale

Trageti targets thousands to low hundreds of thousands of records, single-user, on local commodity hardware. At that scale, SQLite FTS5 answers in milliseconds and even unindexed vector scans via sqlite-vec are tolerable. The dimensional cascade's *speed* benefit is real but secondary; its **primary value is precision and interpretability** — fewer, better-ranked, explainable results that fit a small model's context window. The brief claims capability, not enterprise-scale throughput.

Where performance does warrant genuine design care:

- **Graph traversal.** Recursive CTEs at query time are the one operation that can degrade badly. Traversal is bounded by depth limits (Layer 5), and frequently traversed neighborhoods are served from a materialized hop-distance table maintained incrementally on write — the same pattern as the materialized tag graph — rather than recomputed per query.
- **The write path.** Coverage validation, term extraction, edge lookup, and index maintenance add work per write. At Trageti's write rates (human- and agent-paced ingestion, not streaming telemetry) this is comfortably sub-perceptible; the assumption is stated so consumers with unusual write volumes know to measure.
- **Vector search placement.** Vectors remain last in every plan — operating on the smallest surviving candidate set — both for speed and because their scores are the least interpretable signal in the result explanation.

---

## 10. Comparison with Prior Work

### 10.1 vs. GraphRAG (Microsoft, 2024)

GraphRAG builds a knowledge graph via expensive LLM extraction (reported $33K indexing for large corpora), partitions it into communities with Leiden clustering, and generates community summaries for global queries. Trageti's tag graph achieves community-like structure through chain prefixes — records sharing top-level tags are implicitly co-clustered — with no clustering step, no summarization pass, and incremental construction. GraphRAG has no temporal semantics; every Trageti dimension composes with temporal filtering. GraphRAG assumes cloud infrastructure; Trageti is a single embedded SQLite file.

### 10.2 vs. TagRAG (Tao et al., 2025)

TagRAG independently validates the tag chain concept, organizing knowledge into hierarchical domain tag chains and achieving 14.6x construction efficiency over GraphRAG with a 95%+ win rate. Trageti extends the approach with arbitrary-length chains (vs. fixed domain→object hierarchy), emergent graph construction (no predefined root tags), four-tier cascade scoring (vs. domain tag matching), temporal validity on both records and chains, deterministic completeness validation, and local-first deployment.

### 10.3 vs. TeaRAG (Zhang et al., 2025)

TeaRAG compresses retrieval via knowledge triplets ranked by Personalized PageRank over a co-occurrence graph, cutting token usage ~60%, but requires Redis and DPO fine-tuning. Trageti's chains generalize triplets to variable length; cascade scoring replaces PageRank with a cheaper, interpretable function; Graph mode delivers equivalent compressed-structure retrieval; and efficiency is structural (pre-filtering) rather than trained.

### 10.4 vs. T-RAG (2024)

T-RAG augments vector retrieval with a static, manually maintained entity hierarchy. Trageti subsumes the pattern: an entity tree is a set of fixed chains. Trageti adds temporal validity (the hierarchy at time T vs. T+1), multiple overlapping hierarchies per record, AI-assisted maintenance, and chain-based scoring.

### 10.5 vs. Graphiti / Mem0 (Temporal Memory Systems)

Graphiti provides temporally aware knowledge graph edges but requires Neo4j and Python. Mem0 is cloud-hosted. Trageti is the only TypeScript/SQLite temporal knowledge store — and with these layers, the only one in any stack composing temporal, categorical, relational, and spatial retrieval dimensions with deterministic annotation validation.

### 10.6 vs. Geospatial RAG Systems (GeoAgentic-RAG, 2026)

GeoAgentic-RAG demonstrates multi-agent geospatial reasoning over PostGIS — full GIS analysis with raster fusion and executable spatial programs. Trageti deliberately does not compete at that layer. It provides the spatially aware knowledge substrate (geometry properties, proximity filtering, SpatiaLite escape hatch) on which such application-layer reasoning can be built locally, while remaining a general-purpose knowledge library.

---

## 11. Design Principles

### 11.1 Local-First, SQLite-Native

The entire system — every layer — lives in a single SQLite database file. Tag chains: delimited strings with B-tree prefix indexes. The tag graph: a nodes/edges table pair maintained automatically. Full-text: FTS5. Vectors: sqlite-vec. Spatial: SpatiaLite (optional). No graph database, no Redis, no cloud service, no server process. Production target: 16GB Apple Silicon and comparable commodity hardware.

### 11.2 Complexity in the System, Not the Interface

The API surface is small enough to feel suspicious: a handful of write methods, one retrieve method, composable optional parameters. Smart defaults at level zero; one new concept per level of depth. Each layer generalizes the existing API rather than widening it — and every layer ships backward-compatible.

### 11.3 Deterministic Where Possible, AI Where Necessary

Term extraction, edge lookup, coverage validation, co-occurrence detection, candidate suggestion, self-testing — deterministic, reproducible, sub-millisecond. The AI's role is confined to the genuinely semantic step (chain assembly and refinement), supported by concrete building blocks and bounded by structural validation. The library never makes model calls; it makes the agent's model calls smaller, rarer, and more reliable.

### 11.4 The Library/Agent Boundary

The library provides primitives, constraints, and signals: write-time graph context, schema-enforced coverage, retrieval self-tests, match explanations, gap flags. The agent owns strategy: which model annotates, when to enrich retroactively, how to act on coverage signals. The library makes completeness failures visible, preventable, and cheap to detect — never silently "fixed."

### 11.5 Interpretable Retrieval

Every result explains itself: which signal matched, at which cascade tier, under which temporal mode, at what traversal depth and distance, traced to which source. A human or AI reviewing results can audit any claim back to its origin and understand exactly why it surfaced.

### 11.6 Incremental, Not Batch

Ingestion, annotation, vocabulary growth, graph updates, index maintenance — all incremental. No reindexing, no graph reconstruction, no batch jobs. The store grows continuously as records arrive, on hardware that never gets a maintenance window.

---

## 12. Implementation Sequence

| Layer/Phase | Version | Contents | Independently delivers |
|-------|---------|----------|------------------------|
| 1 | Tag chains, cascade scoring, chain-scoped retrieval | Interpretable categorical retrieval; cheap pre-filtering |
| 2 | Materialized tag graph, retrieve-before-write, term coverage validation, reverse-BM25 suggestion, self-test, coverage signals | Deterministic completeness; annotation integrity at scale |
| 3 | Entities, relationships, co-occurrence validation, traversal, Graph mode | Full temporal knowledge graph |
| 4 | SpatiaLite geometry properties, R-tree indexing, proximity filtering | Four-dimensional retrieval |
| 5 | Sources/citations, budgets, diagnostics, depth limits, intention inference | Production polish, added on demonstrated need |

Each layer is shippable, valuable, and publishable on its own. Development stops being speculative at every boundary: if a consuming application doesn't need the next layer yet, the current layer stands complete.

---

## 13. Open Questions

**Optimal chain length.** What is the practical upper bound on useful chain depth? Too shallow gives weak categorical signal; too deep overfits to instances.

**Vocabulary convergence.** How quickly does the tag vocabulary stabilize in practice? What governance prevents drift, synonym proliferation, and inconsistent usage across sessions?

**Scoring calibration.** The cascade tiers are specified qualitatively. Empirical calibration on domain-specific benchmarks is needed for tier weighting — and for how chain score composes with temporal recency, traversal distance, and spatial proximity in the final ranking. The banded-scoring promotion threshold (Section 9.3) needs the same treatment: how often should a one-band promotion occur in practice, and does a single global threshold suffice or does it vary by band?

**Cross-domain transfer.** Do chains trained in one domain transfer to another? What fraction of a vocabulary is domain-general?

**Term coverage thresholds.** Optimal TF-IDF cutoff and top-N for the coverage checklist: too low yields noisy checklists, too high misses moderately weighted concepts.

**Entity co-occurrence precision.** False-positive rates of BM25 entity detection as the index grows; disambiguation strategies for common-word entity names.

**Deterministic annotation sufficiency.** What percentage of annotations can the reverse-BM25 pipeline produce without AI involvement, passing the self-test unrefined?

**Geometry scope.** Are points plus radius sufficient for the target application classes, or does region containment (polygons) earn its place in the core API rather than the SpatiaLite escape hatch?

**Interaction with orchestration strategies.** How do the dimensional filters and cascade scoring interact with agent-layer strategies (Gather→Reason, Progressive Draft, Exhaustive Search) managing context budgets on constrained hardware?

---

## References

Chen, X. et al. (2025). PathRAG: Pruning Graph-based Retrieval Augmented Generation with Relational Paths.

Edge, D. et al. (2024). From Local to Global: A Graph RAG Approach to Query-Focused Summarization.

Guo, Z. et al. (2024). LightRAG: Simple and Fast Retrieval-Augmented Generation.

Liang, C. et al. (2026). GeoAgentic-RAG: A Multi-Agent Framework for Autonomous Geospatial Reasoning and Visual Insight Generation with LLM. International Journal of Applied Earth Observation and Geoinformation, 147.

Marzovanova, M. (2015). Metataxonomy as a Tool for Intelligent Tagging and Search. University of National and World Economy.

Puspitasari, F.D. et al. (2026). InSemRAG: Efficient RAG with Intent-Aware Retrieval and Semantics-Preserving Chunking. arXiv:2606.01240.

Tao, W., Lan, Y., & Qian, W. (2025). TagRAG: Tag-guided Hierarchical Knowledge Graph Retrieval-Augmented Generation. arXiv:2601.05254.

Zhang, C. et al. (2025). TeaRAG: A Token-Efficient Agentic Retrieval-Augmented Generation Framework. arXiv:2511.05385.

---

*This document is a theoretical technical brief. API examples are illustrative proposals, not finalized signatures; storage schemas and benchmark evaluations are deferred to per-layer specification work.*
