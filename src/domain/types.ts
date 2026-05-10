import type { Database } from 'better-sqlite3'

// ─── Core domain ─────────────────────────────────────────────────────────────

export interface Episode {
  id: string
  namespace: string
  /** Caller-defined ordinal: consistent, comparable, stable within a namespace. */
  position: number
  /** ISO 8601 — real-world time of the event; display and audit only. */
  occurredAt: string
  /** Caller-defined; opaque to the library. */
  type: string
  content: string
  /** ISO 8601 — when the system recorded this episode. */
  createdAt: string
}

export interface Assertion {
  id: string
  namespace: string
  /** Caller-defined; opaque to the library. */
  type: string
  /** The claim, in natural language. */
  content: string
  /** Position at which this became true. */
  validFrom: number
  /** Position at which superseded; null = currently valid. Must be > validFrom when set. */
  validUntil: number | null
  /** 0.0–1.0; caller-assigned. */
  confidence: number
  /** FK → episodes.id */
  sourceEpisodeId: string
  /** FK → assertions.id — the assertion this replaces (strictly new → old). */
  supersedesId: string | null
  /** Optional: groups assertions about the same entity. */
  entityId: string | null
  /** Optional: caller-defined entity classification. */
  entityType: string | null
  /** Required, always populated on read. At least one citation per spec v0.2. */
  citations: AssertionCitation[]
  /** ISO 8601 — when the system recorded this assertion. */
  createdAt: string
  /** Caller-registered extended columns, populated at query time. */
  extensions: Record<string, unknown>
}

/**
 * Source reference for an assertion. Every assertion must have at least one citation.
 * Multiple citations are permitted for assertions synthesised from more than one passage.
 */
export interface AssertionCitation {
  id: string
  /** FK → trl_assertions.id */
  assertionId: string
  /** FK → trl_episodes.id — required; validated at write time. Must share the assertion's namespace. */
  episodeId: string
  /** Required, non-empty. Caller-defined reference string; format opaque to the library. */
  sourceRef: string
  /** Verbatim text from the source passage. Strongly recommended; null permitted but warned on write. */
  excerpt: string | null
  /** Optional positional anchor within the source; format caller-defined. */
  excerptStart?: string
  /** Optional positional anchor within the source; format caller-defined. */
  excerptEnd?: string
  /** Caller-defined additional citation data; stored as JSON. */
  metadata?: Record<string, unknown>
  /** ISO 8601 */
  createdAt: string
}

/**
 * Inline citation shape accepted by writeAssertion(). Caller supplies id; assertionId
 * and createdAt are filled in by the store at insert time.
 */
export type NewAssertionCitation = Omit<AssertionCitation, 'assertionId' | 'createdAt'>

/**
 * Assertion shape accepted by writeAssertion(). createdAt and extensions are filled
 * in by the store; citations are inline NewAssertionCitation objects.
 */
export type NewAssertion =
  Omit<Assertion, 'createdAt' | 'extensions' | 'citations'> & {
    citations: NewAssertionCitation[]
  }

export interface AssertionLink {
  id: string
  namespace: string
  fromId: string
  toId: string
  /** Caller-defined; opaque to the library. */
  linkType: string
  validFrom: number
  validUntil: number | null
  /** FK → episodes.id */
  sourceEpisodeId: string
  /** ISO 8601 */
  createdAt: string
}

export interface NamespaceConfig {
  namespace: string
  embeddingDimension: number
  createdAt: string
  /** Arbitrary caller metadata; stored as JSON. */
  config: Record<string, unknown>
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

export type RetrievalMode = 'snapshot' | 'trajectory'

export interface RetrievalQuery {
  namespace: string
  queryEmbedding: Float32Array | number[]
  /** Enables BM25 scoring if provided. */
  queryText?: string
  /** Retrieve assertions valid AT this position. */
  temporalAnchor: number
  temporalWindow?: {
    from?: number
    to?: number
  }
  entityTypes?: string[]
  /** Any string values accepted — no enum enforced. */
  assertionTypes?: string[]
  minConfidence?: number
  /** Default: false */
  includeSuperseded?: boolean
  /** Default: false — one hop via GraphQueryAdapter */
  expandLinks?: boolean
  maxDepth?: number
  /** Default: 10 */
  limit?: number
  /** Default: 'snapshot'. Trajectory mode attaches each result's supersession chain. */
  mode?: RetrievalMode
  scorer?: RetrievalScorer
  middleware?: RetrievalMiddleware[]
}

export interface RetrievedAssertion extends Assertion {
  score: number
  /**
   * Raw scorer inputs; always populated for transparency.
   * bm25Score is the raw FTS5 BM25 value (negative; more-negative = better) —
   * v0.2 changed this from a normalised [0, 1] value (BREAKING for custom scorers).
   */
  scoreComponents: {
    semanticDistance: number
    bm25Score: number | null
    position: number
  }
  linkedAssertions?: Assertion[]
  /**
   * Populated only when query.mode === 'trajectory'. Contains all *prior* versions
   * of this assertion in chronological order (oldest first), each with full citations.
   * Empty array means trajectory mode was requested but the result has no predecessors.
   * Absent (undefined) when mode is 'snapshot' or omitted.
   */
  supersessionChain?: Assertion[]
}

export interface ScoredCandidate {
  assertion: Assertion
  /** Cosine distance from sqlite-vec; lower = more similar. */
  semanticDistance: number
  /** FTS5 BM25 score; null if no queryText. More negative = better match. */
  bm25Score: number | null
  /** assertion's validFrom, for recency calculations. */
  position: number
}

export interface ScoringContext {
  temporalAnchor: number
  namespacePositionRange: {
    min: number
    max: number
  }
  query: RetrievalQuery
}

// ─── Context assembly ─────────────────────────────────────────────────────────

export interface ContextAssemblyOptions {
  namespace: string
  queryEmbedding: Float32Array | number[]
  queryText?: string
  temporalAnchor: number
  tokenBudget: number
  expandLinks?: boolean
  maxDepth?: number
  /** Default: 'snapshot'. Trajectory mode propagates to retrieve(). */
  mode?: RetrievalMode
  scorer?: RetrievalScorer
  middleware?: RetrievalMiddleware[]
  /** Per-call formatter override. */
  formatter?: ContextFormatter
}

export interface AssembledContext {
  text: string
  assertions: RetrievedAssertion[]
  tokenEstimate: number
  truncated: boolean
  /** Formatter-specific metadata. */
  metadata: Record<string, unknown>
  coverage: {
    totalAssertions: number
    includedAssertions: number
    positionRange: { from: number; to: number }
  }
}

export interface FormattedContext {
  text: string
  tokenEstimate: number
  truncated: boolean
  metadata: Record<string, unknown>
}

// ─── Graph ────────────────────────────────────────────────────────────────────

export interface TraversalOptions {
  temporalAnchor: number
  /** No hard cap; caller and adapter negotiate. */
  maxDepth: number
  /** undefined = all types */
  linkTypes?: string[]
  includeSuperseded?: boolean
}

export type PathOptions = TraversalOptions

// ─── Extension interfaces (contracts) ────────────────────────────────────────

export interface GraphQueryAdapter {
  findConnected(
    db: Database,
    namespace: string,
    fromIds: string[],
    options: TraversalOptions,
  ): AssertionLink[]

  findPath(
    db: Database,
    namespace: string,
    fromId: string,
    toId: string,
    options: PathOptions,
  ): AssertionLink[] | null
}

export interface RetrievalScorer {
  score(candidate: ScoredCandidate, context: ScoringContext): number
  /**
   * Optional batch scoring hook. When implemented, the retrieval pipeline calls this
   * instead of per-candidate score(). Use for scorers that need cross-candidate
   * normalisation (e.g., DefaultScorer's BM25 min-max normalisation).
   * Must return an array whose length equals candidates.length; otherwise the
   * pipeline throws.
   */
  scoreBatch?(candidates: ScoredCandidate[], context: ScoringContext): number[]
}

export interface ContextFormatter {
  format(assertions: RetrievedAssertion[], options: ContextAssemblyOptions): FormattedContext
}

export interface AssertionValidator {
  validate(assertion: NewAssertion): ValidationResult
}

export interface ConnectionVerifier {
  verify(db: Database): void
}

export interface RetrievalMiddleware {
  before?(query: RetrievalQuery): RetrievalQuery
  after?(results: RetrievedAssertion[], query: RetrievalQuery): RetrievedAssertion[]
}

// ─── Schema extensions ────────────────────────────────────────────────────────

export type LibraryTable = 'trl_assertions' | 'trl_episodes' | 'trl_links'

export interface ColumnExtension {
  table: LibraryTable
  /** Must not start with 'trl_', shadow any library column, or be a reserved keyword. */
  column: string
  /** SQL column definition: type + optional DEFAULT + optional CHECK. */
  definition: string
  /** Documentation only; not stored in the database. */
  description?: string
}

export interface TableExtension {
  /** Must not start with 'trl_'. */
  tableName: string
  /** Full CREATE TABLE IF NOT EXISTS statement. */
  createSQL: string
  /** If true, deleteNamespace() warns before proceeding. */
  referencesNamespace: boolean
  description?: string
}

export interface SchemaExtensions {
  columns?: ColumnExtension[]
  tables?: TableExtension[]
}

// ─── Migrations ───────────────────────────────────────────────────────────────

export interface Migration {
  version: number
  description: string
  up: (db: Database) => void
  down?: (db: Database) => void
}

// ─── FTS5 tokenizer ───────────────────────────────────────────────────────────

export interface FTS5TokenizerConfig {
  tokenizer: string
  tokenizerArgs?: string[]
}

// ─── Init options ─────────────────────────────────────────────────────────────

export interface TemporalStoreOptions {
  namespace: string
  embeddingDimension: number
  maxEpisodeContentBytes?: number
  graphAdapter?: GraphQueryAdapter
  scorer?: RetrievalScorer
  defaultFormatter?: ContextFormatter
  validators?: AssertionValidator[]
  connectionVerifier?: ConnectionVerifier
  middleware?: RetrievalMiddleware[]
  fts5Tokenizer?: FTS5TokenizerConfig
  schemaExtensions?: SchemaExtensions
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface NamespaceStats {
  episodeCount: number
  assertionCount: number
  activeAssertionCount: number
  supersededCount: number
  indexedCount: number
  linkCount: number
  positionRange: { min: number; max: number }
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean
  errors: string[]
}
