# Toward a Unified Temporal Knowledge Retrieval Architecture with Tag Graphs

**Technical Brief — Draft v0.4**
**Brian Lacy, Qwandery, Inc.**
**June 2026**

---

## Abstract

Current retrieval-augmented generation (RAG) systems treat knowledge as a flat collection of text chunks retrieved by vector similarity, discarding temporal validity, structural relationships between entities, provenance chains, and the categorical context that makes retrieved knowledge actionable. Graph-based RAG approaches (GraphRAG, LightRAG, TagRAG) address structural deficiencies by introducing knowledge graphs, but none account for when knowledge became valid, whether it has been superseded, or how understanding evolved over time. Meanwhile, temporal knowledge stores lack the structured annotation and graph-based retrieval capabilities that make graph RAG systems efficient.

This brief proposes a unified retrieval architecture that integrates episodic temporal awareness, entity-relationship modeling, source citation tracking, intention-aware retrieval, and a novel annotation primitive — the **directed tag chain** — into a cohesive system. Every object in the knowledge store (episodes, assertions, entities, relationships, citations, and sources) is annotated with one or more directed tag chain segments. These segments collectively form an emergent directed acyclic graph (DAG) — the **tag graph** — which serves as a lightweight, interpretable, and computationally inexpensive primary retrieval signal. The tag graph composes naturally with temporal filtering, entity-relationship traversal, and vector similarity to enable multi-dimensional retrieval that is simultaneously temporally coherent, structurally aware, categorically precise, and intention-sensitive.

---

## 1. Problem Statement

### 1.1 Limitations of Flat RAG

Standard RAG pipelines embed documents into vector space and retrieve the top-k chunks most similar to a query. This approach suffers from three fundamental limitations. First, all retrieved content is treated as equally current — a claim written three years ago and a claim written yesterday carry equal weight. Second, the relationships between retrieved chunks are invisible — the system cannot distinguish between two chunks that describe the same entity and two that are entirely unrelated. Third, the retrieval signal (cosine similarity on embeddings) is expensive, opaque, and imprecise for categorically structured knowledge.

### 1.2 Limitations of Graph RAG

Graph-based RAG systems (Microsoft GraphRAG, LightRAG, TagRAG, TeaRAG) address the structural limitation by extracting entities and relationships from documents and building knowledge graphs. However, these systems share a common deficiency: they are temporally naive. A knowledge graph constructed from a corpus treats every extracted triplet as equally valid. If a document from 2022 states "Alice is the CEO" and a document from 2024 states "Bob is the CEO," both triplets coexist in the graph with no indication that the latter supersedes the former. The graph reflects everything that was ever true, with no mechanism for distinguishing what is currently true, what was true during a specific period, or how understanding evolved.

Additionally, existing graph RAG systems rely on expensive LLM-based entity extraction during indexing (GraphRAG's reported $33K cost for large datasets), require cloud-scale infrastructure, and produce graphs that are difficult to update incrementally.

### 1.3 The Missing Synthesis

No existing system combines temporal knowledge semantics (when claims are valid, how they evolve, what supersedes what) with structured graph-based retrieval (entity-relationship traversal, community-level summarization, path-based relevance scoring) and lightweight categorical annotation (structured metadata that enables retrieval cheaper than vector similarity). This brief describes such a system.

---

## 2. Core Data Model

The proposed system is organized around six primary object types, each of which participates in the temporal knowledge layer and the tag graph.

### 2.1 Episodes

An **episode** is a discrete unit of observed or recorded experience anchored to a specific temporal position. Episodes are the raw input to the system — a therapy session transcript, a meeting note, a document ingestion event, a sensor reading. Each episode carries a temporal position (its place in the sequential ordering of events), a timestamp, a source type classification, and raw content.

Episodes are the provenance root. All other objects in the system trace their lineage back to one or more episodes.

### 2.2 Assertions

An **assertion** is a discrete claim about the world, extracted from or derived from one or more episodes. Assertions are the system's unit of belief. Each assertion carries temporal validity metadata: a `validFrom` position indicating when the assertion became operative, an optional `validTo` position indicating when it ceased to be operative, a confidence score, and a supersession reference pointing to the assertion (if any) that replaced it.

Assertions reference the entity they describe and cite the episodes from which they were derived. The supersession chain — the linked sequence of assertions that replaced one another over time — is a first-class queryable structure.

### 2.3 Entities

An **entity** is a persistent object of interest in the knowledge domain. In a clinical context, entities include clients, providers, medications, and diagnoses. In a research context, entities include papers, authors, concepts, and datasets. Entities carry typed properties, each with its own temporal validity. An entity's properties may change over time; the entity itself persists as a stable reference point.

### 2.4 Relationships

A **relationship** is a typed, directed connection between two entities. Relationships carry their own temporal validity, confidence, and provenance — they are not static edges in a graph but temporally scoped assertions about connections. "Client-42 is-treated-by Dr. Garcia" is a relationship with a `validFrom` of position 16 (when Dr. Garcia took over care), a confidence of 0.95, and a citation chain back to the episode where the transition was documented.

Relationships enable graph traversal: given an entity, the system can walk its relationship edges to find connected entities, filter by temporal validity, and score by confidence and recency.

### 2.5 Sources

A **source** is the origin of one or more episodes — a document, a recording, a data feed, an external system. Sources carry metadata about provenance, format, access permissions, and trustworthiness. Source-level metadata propagates to the episodes derived from the source and, transitively, to the assertions, entities, and relationships extracted from those episodes.

### 2.6 Citations

A **citation** is a structured link from an assertion or relationship back to the specific episode and source passage that supports it. Citations enable provenance tracing: given any assertion, the system can produce the exact source material from which it was derived. Citations carry excerpt text, source references, and positional metadata (where in the source the supporting evidence appears).

---

## 3. The Tag Graph

### 3.1 Tag Chains as Annotation Primitives

A **directed tag chain** is a variable-length, ordered sequence of tags that annotates any object in the knowledge store. The ordering is semantically significant: `Clinical > Sleep > Improvement > Medication-Change` means something different from `Medication-Change > Clinical > Sleep > Improvement` or any other permutation. Each position in the chain narrows or contextualizes the preceding position, moving from broad domain to specific aspect.

Every object in the data model — episodes, assertions, entities, relationships, sources, and citations — may carry one or more directed tag chains. A single assertion might carry chains `Clinical > Sleep > Improvement` and `Client-42 > Session-15 > Outcome`, positioning it simultaneously in the clinical-domain concept space and the client-session organizational space.

### 3.2 The Emergent Graph

The full set of tag chains across all objects in the store collectively defines an emergent directed acyclic graph — the **tag graph**. This graph is never explicitly constructed as a separate data structure. It is implied by the union of all chain segments. When one assertion carries the chain `Clinical > Sleep > Improvement` and another carries `Clinical > Sleep > Disruption`, the graph implicitly contains a node `Clinical > Sleep` with two outgoing edges (to `Improvement` and `Disruption`).

The tag graph may optionally be materialized as an explicit graph structure (a nodes table and a directed edges table with usage weights) for efficient traversal queries, but the authoritative source of truth remains the chain annotations on individual objects. Materialization is an optimization, not a requirement.

### 3.3 Chain Vocabulary and Governance

Tag chains draw from a shared vocabulary that grows over time. During early system use, the vocabulary is seeded manually or from domain ontologies. As objects are ingested, the AI annotation layer may propose new tags or chain segments, subject to vocabulary governance rules: normalization (case, synonyms), deduplication, and consistency checking.

The vocabulary is not a predefined hierarchy (unlike TagRAG's root domain tags). It is an open, evolving set of terms whose hierarchical structure emerges from usage patterns in the chains themselves.

---

## 4. Annotation and Ingestion

### 4.1 The Retrieve-Before-Write Pattern

The most critical challenge in tag chain annotation is maintaining graph integrity (avoiding near-duplicate tags, inconsistent vocabulary, orphaned branches) while achieving meaningful annotation density (comprehensive, multi-faceted chain coverage on every record). The system addresses both challenges through a **retrieve-before-write** pattern: before generating chain annotations for new content, the system searches the existing tag graph for relevant segments, then presents those segments to the AI as building blocks for chain assembly.

The process has three stages.

### 4.2 Stage 1: Key Term Extraction

When new content arrives for ingestion, the system extracts key terms using lightweight methods — named entity recognition (NER), keyword extraction, or simple noun phrase detection. This is not an LLM call; it is a cheap, deterministic preprocessing step. For an input like "Dec 11, 2025 — John spoke to Sally about the house on 37th Street in Westover," extraction produces terms such as `John`, `Sally`, `37th Street`, `Westover`, `house`, and `conversation`.

### 4.3 Stage 2: Tag Graph Edge Lookup

Each extracted term is used to search the existing tag graph via BM25 over the graph's nodes and edges. The search targets **edges** (pairs of adjacent tags that form a directed connection) rather than individual tags, because edges carry structural context that isolated tags do not. Finding the edge `Sally > Properties` tells the annotation layer something that finding `Sally` and `Properties` separately cannot — it reveals an existing directed relationship in the graph.

The lookup returns a set of existing path segments relevant to the new content. For example, searching the terms above might return edges and short paths such as `Contacts > Sally Chen`, `Contacts > Sally Chen > Properties`, `Properties > Westover > 37th Street`, `Team > John`, and `Activities > Client Meetings`. These are concrete, pre-validated building blocks drawn from the established graph vocabulary.

The cost of this stage is negligible: a handful of BM25 queries against a small index (the tag graph typically contains hundreds to low thousands of nodes). No vector embeddings are required.

### 4.4 Stage 3: AI-Assisted Chain Assembly

The AI annotation layer receives the original content plus the set of relevant existing path segments retrieved in Stage 2. Its task is to assemble complete tag chains from these building blocks, reusing existing paths wherever possible and proposing new tags only when no existing path adequately covers an aspect of the content.

This is a **constrained assembly** task, not open-ended generation. The AI is selecting from and combining pre-validated pieces, which produces three benefits. First, graph integrity is preserved because the AI preferentially reuses existing vocabulary and paths rather than inventing synonymous alternatives. Second, annotation density is higher because the AI sees the graph's existing structure and can annotate along dimensions it might not have considered independently. Third, the annotation call is inexpensive — the prompt contains the content plus a short list of candidate path segments, and the output is a few chain sequences, typically under 1,000 tokens total.

For the example above, the AI might produce chains such as `Contacts > Sally Chen > Properties > Westover > 37th Street`, `Team > John > Activities > Client Meetings`, and `Properties > Westover > 37th Street > Inquiries`. The first two chains are assembled entirely from existing graph segments. The third extends an existing path (`Properties > Westover > 37th Street`) with a new terminal tag (`Inquiries`), incrementally growing the graph.

### 4.5 Propagation to Derived Objects

When assertions, entities, and relationships are extracted from an episode, they inherit the episode's chain annotations as a starting point. The extraction process may refine, extend, or add chains specific to the derived object. An episode annotated with `Clinical > Session-15` might produce an assertion annotated with `Clinical > Sleep > Improvement` (more specific) and an entity annotated with `Client > Client-42` (different facet). Each derived object's chains go through the same retrieve-before-write pattern, ensuring consistency with the existing graph at every level.

### 4.6 Incremental Vocabulary Growth

As new chains are written, the tag vocabulary and the emergent tag graph grow incrementally. No full reindexing or graph reconstruction is required. Each new chain annotation is a local addition — it may extend existing paths, add new branches, or create new roots. The system periodically runs consistency checks to merge synonymous tags, prune unused branches, and flag drift in tag usage patterns.

---

## 5. Deterministic Completeness Guarantees

The most critical challenge in any annotation-driven retrieval system is completeness: ensuring that annotations are comprehensive enough that future queries will find relevant records and that relationships between records are accurately captured. Most systems address this through agent-level strategies — multiple LLM passes, retroactive enrichment, periodic re-ingestion. These strategies are valuable but non-deterministic and belong at the consuming application layer, not in the library itself.

Trageti addresses completeness at the library level through deterministic validation primitives built into the write path. These primitives do not generate annotations — that remains the agent's responsibility. Instead, they establish a mathematically derived coverage floor that annotations must satisfy before a write is committed.

### 5.1 Term Coverage Validation

When content is submitted for writing, the library computes term significance scores using TF-IDF (term frequency–inverse document frequency) over the existing corpus. This is a standard, fully deterministic operation: each term in the content receives a weight reflecting how frequently it appears in this content relative to how commonly it appears across all stored records. Terms with high TF-IDF scores are the content's most discriminating features — the terms that, if searched for, would most specifically retrieve this record.

The library selects the top N most significant terms (where N and the minimum TF-IDF threshold are implementer-configured) and assembles them into a **term coverage checklist**. The agent's submitted annotations — tag chains, entity references, relationship links — must collectively address every term on the checklist. "Address" means that at least one submitted annotation contains a tag, entity reference, or relationship endpoint that matches or is associated with the checklist term.

If the submitted annotations leave a checklist term uncovered, the write returns a structured rejection identifying each uncovered term. The agent knows exactly what it missed and can amend its annotations accordingly. This transforms completeness from an open-ended judgment call ("did I annotate this thoroughly enough?") into a bounded gap-filling task against a known list — a task that even small, resource-constrained models handle reliably.

The term coverage checklist is deterministic and reproducible: the same content against the same corpus will always produce the same checklist. No model calls, no randomness, no judgment. The mathematical properties of TF-IDF guarantee that the most semantically distinctive aspects of the content will appear on the checklist.

### 5.2 Relationship Coverage Validation

Term coverage ensures that the content's significant topics are represented in the tag graph. Relationship coverage ensures that connections between entities mentioned in the content are captured.

The library maintains an entity index — a BM25-searchable index of all known entities in the store. When new content is submitted, the library scans for mentions of known entities using BM25 matching against the entity index. When two or more known entities co-occur in the same content, the library flags an expected relationship: "Entities [John] and [Sally] both appear in this content. A relationship annotation between them is expected."

Like term coverage, this check is deterministic. Entity detection is a BM25 lookup against a known index. Co-occurrence detection is set intersection. The library does not determine what the relationship is — only that one is expected. If the agent submits annotations without a relationship link between co-occurring entities, the write returns a structured rejection: "Entities [John] and [Sally] co-occur in content but no relationship annotation was submitted between them."

When co-occurring entities already have existing relationships in the graph, the library surfaces those relationships as part of the write-time context: "Existing relationships between [John] and [Sally]: [John —referred-by→ Sally, valid from position 5]." This gives the agent the information needed to decide whether the existing relationship covers the new content or whether a new relationship annotation is warranted.

### 5.3 Reverse BM25 Tag Suggestion

Beyond validation, the library can deterministically propose candidate annotations. Because the tag graph's nodes accumulate document associations over time (each node tracks which records it has been applied to), the library can score each existing tag node against the new content using TF-IDF term weighting. The result is a ranked list of existing tags most relevant to the content — derived purely from the mathematical relationship between the content's term profile and each tag's historical document associations.

This **reverse BM25** operation produces a deterministic set of candidate tags, ranked by relevance. In many cases — particularly for content that falls within well-established areas of the tag graph — the deterministic candidates may be sufficient to build complete chain annotations without any AI involvement at all. The AI becomes a refinement layer that handles edge cases, novel concepts, and ambiguous categorization, rather than the sole source of annotation.

The performance cost of these validation and suggestion operations is negligible. TF-IDF computation, BM25 lookups against a tag graph of hundreds to low thousands of nodes, and entity co-occurrence detection are all sub-millisecond operations on commodity hardware — two to three orders of magnitude cheaper than the AI annotation call they support.

### 5.4 Coverage Signals on Retrieval

Completeness validation also operates at retrieval time. When the library returns results, each result includes metadata describing which retrieval signal produced the match: tag chain scoring (and which cascade tier), BM25 keyword fallback, or vector similarity fallback. A result retrieved only by BM25 or vector fallback — bypassing the tag chain scoring layer entirely — is an implicit signal that the record's chain annotations are incomplete for this query pattern.

The library does not act on this signal automatically. It includes it in the result payload, making annotation gaps visible to the consuming agent. The agent may choose to retroactively enrich the record's annotations, log the gap for later review, or ignore it. The library's responsibility is detection and visibility, not remediation.

### 5.5 Retrieval Self-Test

As a final validation step, the library offers an optional self-test mode on write. After accepting a record's annotations, the library executes a retrieval query using those annotations and verifies that the record would be found in the results. If the annotations do not produce a retrievable record — indicating a structural disconnect between what was annotated and what the retrieval system can find — the write returns a warning or rejection (configurable).

This is a fully deterministic end-to-end integrity check. It does not assess whether the annotations are semantically correct, but it guarantees they are structurally functional: a record that passes the retrieval self-test is findable by its own annotations.

---

## 6. Retrieval Architecture

### 6.1 Multi-Signal Retrieval

The system retrieves knowledge using multiple complementary signals, ordered by computational cost from cheapest to most expensive.

**Signal 1: Tag Chain Scoring.** The primary retrieval signal. The query (or the query's generated chain annotation) is compared against the chains on candidate objects using a cascading relevance function (described in Section 7). This is a string/set operation — O(log n) with proper indexing — and eliminates the majority of irrelevant candidates before any expensive computation occurs.

**Signal 2: Temporal Filtering.** The surviving candidates are filtered by temporal validity using one of four retrieval modes.

- **Snapshot** returns what is currently true at a given temporal position. Superseded assertions are excluded.
- **Window** returns everything that was valid during a specified temporal range.
- **Trajectory** returns the full supersession chain for a given entity or topic, showing how understanding evolved over time.
- **Graph** returns the entity-relationship neighborhood around a query entity as compressed directed edges with temporal metadata, suitable for structural overview queries.

**Signal 3: Entity-Relationship Traversal.** For queries that reference known entities, the system walks relationship edges to find connected entities, filtering by temporal validity and relationship type. Hop distance and relationship confidence contribute to relevance scoring.

**Signal 4: BM25 Keyword Matching.** Standard full-text search over assertion and episode content, operating on the already-narrowed candidate set.

**Signal 5: Vector Similarity.** Cosine similarity on embeddings, used only when chain-based scoring and keyword matching produce ambiguous results or when chain annotations are sparse. This is the most expensive signal and operates on the smallest candidate set.

### 6.2 Intention-Aware Retrieval Mode Selection

The system selects retrieval modes and signal weighting based on detected query intention. A query asking "What is currently true about Client-42's sleep?" triggers Snapshot mode with entity-focused chain scoring. A query asking "How has Client-42's treatment plan evolved?" triggers Trajectory mode with relationship traversal. A query asking "What do we know about sleep improvement across all clients?" triggers a Graph-mode query scoped by chain prefix `Clinical > Sleep > Improvement`.

Intention detection may be explicit (the calling application specifies the mode) or implicit (the system infers mode from query structure and content). Implicit detection is itself a lightweight classification task.

---

## 7. Tag Chain Cascade Scoring

The relevance between a query chain and a candidate object's chain(s) is computed using a cascading scoring function with four tiers, evaluated in priority order.

### 7.1 Equality (Highest Priority)

The query chain and candidate chain are identical. This is the strongest possible relevance signal. Score: maximum.

### 7.2 Specificity

The query chain and candidate chain share a directed prefix of depth d. Longer shared prefixes indicate more specific overlap. `Clinical > Sleep > Improvement` matching `Clinical > Sleep > Improvement > Medication-Change` shares a prefix of depth 3. Score: proportional to prefix depth relative to chain length.

### 7.3 Similarity

The query chain and candidate chain share tags regardless of ordering. `Clinical > Sleep > Improvement` and `Improvement > Sleep > Clinical` contain the same tags but in different order. This indicates shared conceptual territory despite different structural positioning. Score: proportional to tag set overlap (Jaccard or similar), weighted below specificity.

### 7.4 Direction (Lowest Priority, Nonzero)

For candidates that match on the similarity tier, directional agreement provides a tiebreaking signal. Two chains with the same tags in similar (though not identical) order score higher than two chains with the same tags in reversed order. Score: proportional to longest common subsequence relative to chain length.

### 7.5 Multi-Chain Scoring

When a candidate carries multiple chains, the score is the maximum score across all chain-to-chain comparisons between the query chain(s) and the candidate's chain(s). A candidate is relevant if any of its chains match the query well, regardless of what its other chains describe.

---

## 8. Temporal Composition

The tag graph composes with temporal semantics at every level.

### 8.1 Chain-Filtered Temporal Queries

Tag chain scoring narrows the candidate set before temporal filtering is applied. "What is currently true about `Clinical > Sleep`?" first selects all objects whose chains match the `Clinical > Sleep` prefix, then applies Snapshot-mode temporal filtering to return only currently valid assertions. This avoids scanning temporally across the entire store.

### 8.2 Temporal Validity on Chains

Tag chains themselves may carry temporal metadata. A chain annotation that was accurate at ingestion time may become inaccurate as the domain evolves. The system supports chain supersession: a new chain annotation may replace an old one on the same object, with the old chain retained for historical queries. This enables "What was this episode categorized as when it was first ingested, vs. how we categorize it now?"

### 8.3 Graph Evolution

Because the tag graph is emergent from chain annotations, and chain annotations may be temporally scoped, the graph itself has a temporal dimension. The tag graph at position 10 may differ from the tag graph at position 50 as vocabulary evolves, new branches emerge, and old categorizations are refined. Trajectory-mode queries over the graph structure itself are possible: "How has the structure of clinical categorization evolved over the past year?"

---

## 9. Retrieval Precision and Context Volume

A system that excels at comprehensive annotation and multi-dimensional retrieval faces an inverted version of the traditional RAG problem. Where flat vector retrieval struggles to find enough relevant content, a thoroughly annotated tag graph with temporal filtering, entity traversal, and cascade scoring may surface more relevant content than a consuming model's context window can accommodate. This section addresses how the architecture manages result volume and ensures that thorough annotation translates to retrieval precision rather than retrieval noise.

### 9.1 Dimensional Intersection as Natural Narrowing

Each query dimension acts as a filter that eliminates candidates. A single-dimension query — "find things about sleep" — may match broadly. A multi-dimensional query — "find things matching `Clinical > Sleep > Improvement` AND currently valid AND related to entity Client-42" — is the intersection of three independent filters. Each additional dimension narrows the result set. Comprehensive annotation does not create noise; it creates precision surfaces that queries can cut across. The more dimensions the implementer specifies, the more selective the retrieval becomes.

This is a fundamental architectural property, not an optimization. In flat vector RAG, adding context makes retrieval fuzzier. In a multi-dimensional system with tag chains, temporal filtering, and entity scoping, adding context makes retrieval sharper — because each additional annotation gives the query one more axis to constrain on.

### 9.2 Cascade Scoring as Rank Separation

The tag chain cascade scoring function (Section 7) provides natural separation between highly relevant results and loosely related ones. For any query, records matching at the equality tier are maximally relevant. Records matching at the specificity tier are strongly relevant. Records matching at the similarity tier are tangentially relevant. Records matching only at the direction tier are weakly relevant.

In a broad query that returns many results, the cascade tiers stratify them into well-separated relevance bands. The top-K results by cascade score are the most precisely relevant without any additional filtering. The consuming agent or implementer does not need to understand the scoring function to benefit from it — they take the top-K results and receive naturally ranked, relevance-stratified content.

### 9.3 Result Budgets

The library enforces a configurable maximum result count per retrieval call. When more candidates survive filtering than the budget allows, the library returns the top-ranked results and reports the total match count: "Returning 10 of 147 matching records." The implementer or agent can then narrow with additional constraints or paginate for more results.

This is analogous to how search engines handle large result sets — the system does not attempt to deliver everything relevant in a single response. The default budget should be conservative (tuned to the target model's context window constraints), with the implementer able to adjust based on their application's requirements.

### 9.4 Traversal Depth Limits

Entity-relationship traversal can fan out explosively from hub entities — a primary care provider who treats dozens of clients, a common medication prescribed across many patients. Unbounded traversal from a hub entity produces result sets that are technically relevant but practically unusable.

The library enforces a configurable maximum traversal depth, defaulting to 1 or 2 hops. Results from deeper traversals receive lower scores than direct matches, so even without hard depth limits, hub explosion is pushed down the ranking. The implementer can increase or decrease the traversal depth based on their query's intent — a narrow factual query warrants shallow traversal, while a broad "map the care network" query warrants deeper exploration with an explicitly larger result budget.

### 9.5 Query Specificity Feedback

When a query matches an unusually large proportion of the store — a chain prefix of depth 1 in a domain where most records share that prefix, or an entity query with no chain or temporal constraints — the library returns diagnostic metadata alongside results. This metadata includes the total match count, the score distribution across cascade tiers, and which query dimensions were most and least selective.

This makes under-constrained queries self-diagnosing. The implementer or agent receives a signal equivalent to "your query matched 80% of the store; the chain dimension eliminated 5% of candidates while the temporal dimension eliminated 90%." This feedback enables informed query refinement without requiring the implementer to understand the internal retrieval mechanics. The metadata is cheap to compute — the library already knows which filters contributed what — and provides actionable guidance toward more precise retrieval.

### 9.6 The Precision Inversion

Traditional RAG systems require the consuming agent to be sophisticated about retrieval: crafting elaborate queries, reranking results, filtering out irrelevant content, managing chunk overlap. This architecture inverts that burden. The library handles ranking, filtering, budgeting, and precision through its multi-dimensional constraint system. The consuming agent's job simplifies to: express what you want across as many dimensions as you can, and take the top results.

A well-constrained query on a comprehensively annotated store produces a small, precisely relevant, temporally coherent, provenance-traced result set — exactly the input a language model needs to reason effectively. The system's thoroughness in annotation directly translates to the implementer's ability to retrieve with surgical precision. More annotation means more ways to constrain, not more noise to wade through.

---

## 10. Comparison with Prior Work

### 10.1 vs. GraphRAG (Microsoft, 2024)

GraphRAG builds a comprehensive knowledge graph via expensive LLM extraction, partitions it into communities using Leiden clustering, and generates community summaries for global queries. The tag graph achieves community-like structure through tag chain prefixes (objects sharing top-level tags are implicitly in the same community) without requiring clustering or summarization. GraphRAG has no temporal semantics. The tag graph composes with full temporal filtering. GraphRAG requires cloud-scale infrastructure; the tag graph is designed for local-first, SQLite-backed deployment.

### 10.2 vs. TagRAG (Tao et al., 2025)

TagRAG organizes knowledge into hierarchical domain tag chains linked to predefined root domain tags, achieving 14.6x construction efficiency over GraphRAG. The tag graph extends this approach with arbitrary-length chains (not constrained to domain-object two-level hierarchy), emergent graph construction (no predefined roots required), cascading multi-tier relevance scoring (vs. TagRAG's domain tag matching), and temporal validity semantics on both the annotated objects and the chains themselves.

### 10.3 vs. TeaRAG (Zhang et al., 2025)

TeaRAG compresses retrieval content using knowledge triplets and a co-occurrence association graph ranked by Personalized PageRank. The tag graph uses variable-length directed chains rather than fixed triplets, and replaces PageRank with a cascading scoring function that is cheaper to compute and more interpretable. TeaRAG requires DPO fine-tuning for reasoning efficiency; the tag graph achieves token efficiency structurally through chain-based pre-filtering.

### 10.4 vs. T-RAG (2024)

T-RAG augments vector retrieval with a static entity hierarchy tree (organizational chart). The tag graph subsumes this pattern: a hierarchical entity tree is a set of directed chains with fixed structure. The tag graph adds temporal validity (the org chart at time T vs. time T+1), multiple overlapping hierarchies per entity, and chain-based relevance scoring.

### 10.5 vs. Standard Temporal RAG

Existing temporal knowledge stores (including Trageti v0.3) track assertion validity and supersession but lack structured annotation for categorical retrieval. Adding the tag graph to a temporal knowledge store provides a lightweight, interpretable, computationally cheap retrieval signal that composes with temporal filtering — enabling queries that are simultaneously categorically precise and temporally coherent.

---

## 11. Design Principles

### 11.1 Local-First, SQLite-Native

The entire system — episodes, assertions, entities, relationships, citations, tag chains, and the optional materialized tag graph — is stored in a single SQLite database. Tag chains are stored as delimited strings with B-tree prefix indexes for O(log n) prefix queries. The materialized graph (if used) is a lightweight nodes-and-edges table pair. No external graph database, Redis instance, or cloud service is required.

### 11.2 AI-Friendly by Design

The annotation and retrieval interfaces are designed for consumption by small, resource-constrained language models. Chain annotations are short, structured, and unambiguous. Retrieval results include chain-level relevance explanations ("matched on prefix `Clinical > Sleep` at depth 2") that help the model understand why a result was returned. The system does not require the consuming model to perform complex reasoning over graph structures — it delivers pre-scored, pre-filtered, temporally coherent results.

### 11.3 Incremental, Not Batch

Every operation — ingestion, annotation, chain generation, vocabulary growth, graph updates — is incremental. No full reindexing or graph reconstruction is required at any point. The system grows continuously as new episodes arrive.

### 11.4 Interpretable Retrieval

Every retrieval result carries a full provenance chain: the chain annotations that matched, the temporal filter that was applied, the citation that links the assertion to its source episode, and the source metadata. A human or AI reviewing the results can trace any claim back to its origin and understand why it was retrieved.

---

## 12. Open Questions

Several aspects of this architecture require further investigation before implementation.

**Optimal chain length.** What is the practical upper bound on useful chain depth? Chains that are too shallow provide weak categorical signal; chains that are too deep may overfit to specific instances and reduce generalization.

**Vocabulary convergence.** How quickly does the tag vocabulary stabilize in practice? What governance mechanisms are needed to prevent vocabulary drift, synonym proliferation, or inconsistent tag usage across ingestion sessions?

**Scoring function calibration.** The relative weights between the four cascade tiers (equality, specificity, similarity, direction) are described qualitatively. Empirical calibration on domain-specific retrieval benchmarks is needed to determine optimal weighting.

**Cross-domain chain transfer.** Can tag chains trained in one domain (e.g., clinical) transfer meaningfully to another domain (e.g., legal)? What proportion of a tag vocabulary is domain-specific vs. domain-general?

**Graph materialization tradeoffs.** Under what conditions does materializing the tag graph as an explicit graph structure provide sufficient retrieval performance benefit to justify the maintenance overhead?

**Interaction with existing retrieval strategies.** How do the tag graph and cascade scoring interact with established orchestration strategies (e.g., Gather→Reason, Progressive Draft, Exhaustive Search) that manage context window constraints on resource-limited hardware?

**Term coverage threshold calibration.** What is the optimal TF-IDF threshold and top-N term count for the term coverage checklist? A threshold too low produces noisy checklists with insignificant terms; a threshold too high may miss important but moderately weighted concepts. Empirical calibration across domain-specific corpora is needed.

**Entity co-occurrence precision.** How reliably does BM25-based entity detection identify true entity mentions versus false positives (e.g., common words that happen to match entity names)? What disambiguation strategies are needed as the entity index grows?

**Deterministic annotation sufficiency.** In practice, what percentage of annotations can be fully derived from the deterministic reverse BM25 pipeline without AI involvement? Under what conditions does the deterministic base produce annotations that pass the retrieval self-test without refinement?

---

## References

Chen, X. et al. (2025). PathRAG: Pruning Graph-based Retrieval Augmented Generation with Relational Paths.

Edge, D. et al. (2024). From Local to Global: A Graph RAG Approach to Query-Focused Summarization.

Guo, Z. et al. (2024). LightRAG: Simple and Fast Retrieval-Augmented Generation.

Marzovanova, M. (2015). Metataxonomy as a Tool for Intelligent Tagging and Search. University of National and World Economy.

Puspitasari, F.D. et al. (2026). InSemRAG: Efficient RAG with Intent-Aware Retrieval and Semantics-Preserving Chunking. arXiv:2606.01240.

Tao, W., Lan, Y., & Qian, W. (2025). TagRAG: Tag-guided Hierarchical Knowledge Graph Retrieval-Augmented Generation. arXiv:2601.05254.

Zhang, C. et al. (2025). TeaRAG: A Token-Efficient Agentic Retrieval-Augmented Generation Framework. arXiv:2511.05385.

---

*This document is a theoretical technical brief and does not describe a production implementation. API specifications, storage schemas, and benchmark evaluations are deferred to subsequent work.*
