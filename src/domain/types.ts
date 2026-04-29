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
  /** FK → assertions.id — the assertion this replaces. */
  supersedesId: string | null
  /** Optional: groups assertions about the same entity. */
  entityId: string | null
  /** Optional: caller-defined entity classification. */
  entityType: string | null
  /** ISO 8601 — when the system recorded this assertion. */
  createdAt: string
  /** Caller-registered extended columns, populated at query time. */
  extensions: Record<string, unknown>
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
  scorer?: RetrievalScorer
  middleware?: RetrievalMiddleware[]
}

export interface RetrievedAssertion extends Assertion {
  score: number
  /** Raw scorer inputs; always populated for transparency. */
  scoreComponents: {
    semanticDistance: number
    bm25Score: number | null
    position: number
  }
  linkedAssertions?: Assertion[]
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

export interface PathOptions extends TraversalOptions {}

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
}

export interface ContextFormatter {
  format(assertions: RetrievedAssertion[], options: ContextAssemblyOptions): FormattedContext
}

export interface AssertionValidator {
  validate(assertion: Omit<Assertion, 'createdAt' | 'extensions'>): ValidationResult
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
