import type { Database, Options as BetterSqlite3ConstructorOptions } from 'better-sqlite3'
import type { Logger, Metrics } from '../internal/logger.js'

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
  /** FK → trageti_assertions.id */
  assertionId: string
  /** FK → trageti_episodes.id — required; validated at write time. Must share the assertion's namespace. */
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
 * Citation shape accepted by `writeCitation()` when attaching a citation to an
 * already-written assertion. The caller supplies `assertionId`; `createdAt` is
 * filled in by the store.
 */
export type NewLateCitation = Omit<AssertionCitation, 'createdAt'>

/**
 * Legacy v0.2 input shape. v0.3 introduces NewAssertionInput (nullable fields
 * become optional) and NormalizedNewAssertion (validators receive null-filled
 * shape). NewAssertion is preserved for back-compat; v0.3 writeAssertion accepts
 * NewAssertionInput and normalizes to NormalizedNewAssertion internally.
 */
/**
 * @deprecated Use `NewAssertionInput` (the v0.3 write-API shape). `NewAssertion`
 * is retained as an alias for back-compat and will be removed in a future
 * major version.
 */
export type NewAssertion = NewAssertionInput

/**
 * v0.3 public write-API shape. `validUntil`, `supersedesId`, `entityId`, and
 * `entityType` are optional; omitting them is equivalent to passing `null`.
 */
export type NewAssertionInput = Omit<
  Assertion,
  | 'createdAt'
  | 'extensions'
  | 'citations'
  | 'validUntil'
  | 'supersedesId'
  | 'entityId'
  | 'entityType'
> & {
  validUntil?: number | null
  supersedesId?: string | null
  entityId?: string | null
  entityType?: string | null
  citations: NewAssertionCitation[]
}

/**
 * v0.3 shape passed to AssertionValidator.validate(). Every nullable field is
 * explicit `null` (never `undefined`).
 */
export type NormalizedNewAssertion = Omit<Assertion, 'createdAt' | 'extensions' | 'citations'> & {
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
  /** Null for vectorless namespaces in v0.3. */
  embeddingDimension: number | null
  createdAt: string
  /** Arbitrary caller metadata; stored as JSON. */
  config: Record<string, unknown>
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

export type RetrievalMode = 'snapshot' | 'trajectory'
export type RetrievalStrategy = 'hybrid' | 'vector' | 'bm25'
export type QueryTextMode = 'phrase' | 'fts5'

export interface RetrievalDebug {
  onStep?: (step: string, info: Record<string, unknown>) => void
}

export interface RetrievalQuery {
  namespace: string
  /** Optional in v0.3; required when retrievalStrategy is 'vector' and no provider configured. */
  queryEmbedding?: Float32Array | number[]
  /** Enables BM25 scoring if provided. */
  queryText?: string
  /** v0.3: default 'phrase' (escapes user input). 'fts5' preserves raw FTS5 syntax. */
  queryTextMode?: QueryTextMode
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
  /** Default: 'hybrid'. */
  retrievalStrategy?: RetrievalStrategy
  scorer?: RetrievalScorer
  middleware?: RetrievalMiddleware[]
  debug?: RetrievalDebug
  /** Optional cancellation signal for provider-derived query embeddings. */
  signal?: AbortSignal
}

export interface RetrievedAssertion extends Assertion {
  score: number
  /**
   * Raw scorer inputs; always populated for transparency.
   * bm25Score is the raw FTS5 BM25 value (negative; more-negative = better).
   * semanticDistance is null when this candidate came from a BM25-only branch.
   */
  scoreComponents: {
    semanticDistance: number | null
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

/** A single non-fatal warning surfaced through a `RetrievalResult`. */
export interface RetrievalWarning {
  code: string
  message: string
}

/** Metadata envelope returned alongside retrieval results. */
export interface RetrievalMeta {
  namespace: string
  temporalAnchor: number
  limit: number
  /** Count of candidates considered before scoring/truncation. */
  candidateCount: number
  retrievalStrategy: RetrievalStrategy
  vectorApplied: boolean
  bm25Applied: boolean
  queryTextMode: QueryTextMode
  /** Wall-clock duration of the retrieval call, in milliseconds. */
  tookMs?: number
  warnings: RetrievalWarning[]
}

/**
 * v0.3 retrieval envelope. `retrieve()` returns this shape; the bare-array
 * v0.2 return type is removed.
 */
export interface RetrievalResult {
  results: RetrievedAssertion[]
  meta: RetrievalMeta
}

export interface RetrievalExplainStep {
  /** Step identifier (e.g. 'temporal-filter', 'vector', 'bm25', 'score'). */
  step: string
  /** SQL the step would execute, when applicable. */
  sql?: string
  /** SQLite query plan for `sql`, when introspected. */
  queryPlan?: string
  /** Estimated row count entering/leaving the step. */
  estimatedRows?: number
  /** Whether the namespace's vec0 table is ready for this step. */
  vectorReady?: boolean
  notes?: string[]
}

export interface RetrievalExplainResult {
  query: RetrievalQuery
  retrievalStrategy: RetrievalStrategy
  steps: RetrievalExplainStep[]
  wouldApplyVector: boolean
  wouldApplyBm25: boolean
  notes: string[]
}

export interface ScoredCandidate {
  assertion: Assertion
  /** Cosine distance from sqlite-vec; null when candidate came from BM25-only. */
  semanticDistance: number | null
  /** FTS5 BM25 score; null when no queryText or vector-only branch. More negative = better. */
  bm25Score: number | null
  /** assertion's validFrom, for recency calculations. */
  position: number
}

export interface ScoringContext {
  temporalAnchor: number
  /** validFrom range across the namespace's active assertions; both null
   *  when the namespace has no active assertions. */
  namespacePositionRange: {
    min: number | null
    max: number | null
  }
  query: RetrievalQuery
}

// ─── Context assembly ─────────────────────────────────────────────────────────

export interface ContextAssemblyOptions {
  namespace: string
  queryEmbedding?: Float32Array | number[]
  queryText?: string
  queryTextMode?: QueryTextMode
  temporalAnchor: number
  tokenBudget: number
  expandLinks?: boolean
  maxDepth?: number
  /** Default: 'snapshot'. Trajectory mode propagates to retrieve(). */
  mode?: RetrievalMode
  retrievalStrategy?: RetrievalStrategy
  scorer?: RetrievalScorer
  middleware?: RetrievalMiddleware[]
  /** Per-call formatter override. */
  formatter?: ContextFormatter
  /** Per-step retrieval debug hook (propagated to retrieve()). */
  debug?: RetrievalDebug
  /** Optional cancellation signal (propagated to retrieve()). */
  signal?: AbortSignal
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
  /** How many of the supplied assertions the formatter actually included
   *  (≤ the input count when truncated by token budget). An explicit field
   *  so context assembly never has to read a formatter-private metadata key. */
  includedCount: number
  metadata: Record<string, unknown>
}

// ─── Graph ────────────────────────────────────────────────────────────────────

/**
 * Adapter-facing traversal tuning. `GraphQueryAdapter` methods receive
 * `namespace` and the source ids as separate parameters, so this carries only
 * the traversal knobs. `maxDepth` is required here — the store resolves its
 * default before building this object.
 */
export interface GraphAdapterTraversalOptions {
  temporalAnchor: number
  /** Hop budget. */
  maxDepth: number
  /** undefined = all link types */
  linkTypes?: string[]
  /** When true, expired links (valid_until <= temporalAnchor) are traversed. */
  includeSuperseded?: boolean
}

/** Public options for `store.getConnected()`. */
export interface TraversalOptions {
  namespace: string
  fromAssertionId: string
  temporalAnchor: number
  /** Hop budget. Optional — the store applies a documented default. */
  maxDepth?: number
  /** undefined = all link types */
  linkTypes?: string[]
  includeSuperseded?: boolean
}

/** Public options for `store.findPath()`. */
export interface PathOptions {
  namespace: string
  fromAssertionId: string
  toAssertionId: string
  temporalAnchor: number
  /** Hop budget. Optional — the store applies a documented default. */
  maxDepth?: number
  /** undefined = all link types */
  linkTypes?: string[]
  includeSuperseded?: boolean
}

/** Public options for `store.getTemporalSnapshot()`. */
export interface TemporalSnapshotOptions {
  namespace: string
  atPosition: number
  entityTypes?: string[]
  assertionTypes?: string[]
  includeSuperseded?: boolean
}

// ─── Extension interfaces (contracts) ────────────────────────────────────────

export interface GraphQueryAdapter {
  findConnected(
    db: Database,
    namespace: string,
    fromIds: string[],
    options: GraphAdapterTraversalOptions,
  ): AssertionLink[]

  findPath(
    db: Database,
    namespace: string,
    fromId: string,
    toId: string,
    options: GraphAdapterTraversalOptions,
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
  validate(assertion: NormalizedNewAssertion): ValidationResult
}

export interface ConnectionVerifier {
  verify(db: Database, logger?: Logger): void
}

export interface RetrievalMiddleware {
  before?(query: RetrievalQuery): RetrievalQuery
  after?(results: RetrievedAssertion[], query: RetrievalQuery): RetrievedAssertion[]
  /** Optional disposal hook; called from TemporalStore.close(). */
  dispose?(): void | Promise<void>
}

// ─── Embedding provider ──────────────────────────────────────────────────────

export interface EmbedOptions {
  signal?: AbortSignal
  purpose?: 'assertion' | 'query' | 'reindex'
}

export interface EmbeddingProvider {
  readonly name: string
  readonly dimension: number
  embed(texts: readonly string[], options?: EmbedOptions): Promise<Float32Array[]>
}

// ─── Indexing ────────────────────────────────────────────────────────────────

export interface IndexBatchItem {
  assertionId: string
  /** Optional pre-computed embedding. Required if no EmbeddingProvider is
   *  configured for the namespace. */
  embedding?: Float32Array | number[]
}

export interface IndexBatchOptions {
  /** Default 'fail-fast'. */
  onProviderError?: 'fail-fast' | 'skip'
  /** Default 64. Ignored in 'skip' mode. */
  batchSize?: number
  signal?: AbortSignal
}

export interface IndexBatchSkipped {
  assertionId: string
  reason: string
  errorCode?: string
}

export interface IndexBatchResult {
  indexed: number
  skipped: IndexBatchSkipped[]
}

// ─── Reindex / rebuild FTS ──────────────────────────────────────────────────

export interface ReindexOptions {
  /** Default 'staging-swap'. */
  strategy?: 'staging-swap' | 'in-place'
  /** Default 'fail-fast'. */
  onProviderError?: 'fail-fast' | 'skip'
  /** Default false. Required to commit a partial staging swap when skipped > 0. */
  allowPartialSwap?: boolean
  /** Optional new dimension; defaults to the namespace's current dimension. */
  newDimension?: number
  /** Per-batch row size while re-embedding. Default 200. */
  batchSize?: number
  /** Optional cancellation signal. */
  signal?: AbortSignal
  /** Embedding provider override for this reindex. */
  embeddingProvider?: EmbeddingProvider
}

export interface ReindexResult {
  reindexed: number
  skipped: IndexBatchSkipped[]
  swappedAt?: string
  durationMs: number
}

export interface RebuildFtsOptions {
  tokenizer?: FTS5TokenizerConfig
  batchSize?: number
  signal?: AbortSignal
}

export interface RebuildFtsResult {
  reindexedRows: number
  newTokenizer: FTS5TokenizerConfig
  durationMs: number
}

// ─── Schema extensions ────────────────────────────────────────────────────────

export type LibraryTable = 'trageti_assertions' | 'trageti_episodes' | 'trageti_links'

export interface ColumnExtension {
  table: LibraryTable
  /** Must not start with 'trageti_', shadow any library column, or be a reserved keyword. */
  column: string
  /** SQL column definition: type + optional DEFAULT + optional CHECK. */
  definition: string
  /** Documentation only; not stored in the database. */
  description?: string
}

export interface TableExtension {
  /** Must not start with 'trageti_'. */
  tableName: string
  /** Full CREATE TABLE IF NOT EXISTS statement. */
  createSQL: string
  /** v0.3: when true, deleteNamespace() requires cascade: true and generates a
   *  DELETE on the namespaceColumn. */
  referencesNamespace: boolean
  /** v0.3: required when referencesNamespace is true. Validated at init() time
   *  against PRAGMA table_info on the created table. */
  namespaceColumn?: string
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
  /** v0.3: optional short name for migration logs. */
  name?: string
  /** v0.3: when true, runner toggles PRAGMA foreign_keys around the migration. */
  requiresForeignKeyToggle?: boolean
  up: (db: Database) => void
  down?: (db: Database) => void
}

export interface MigrationDescriptor {
  version: number
  name: string
  description: string
  requiresForeignKeyToggle: boolean
  /** ISO-8601 timestamp recorded when the migration was applied to this
   *  database, or `null` if it has not been applied yet. */
  appliedAt: string | null
}

// ─── FTS5 tokenizer ───────────────────────────────────────────────────────────

export interface FTS5TokenizerConfig {
  tokenizer: string
  tokenizerArgs?: string[]
  /** Opt-out of the built-in-tokenizer allow-list and argument validation.
   *  Set true only for a vetted custom FTS5 tokenizer the caller fully trusts —
   *  the library then interpolates the name/args into DDL without checks. */
  trustedCustomTokenizer?: boolean
}

// ─── Init options ─────────────────────────────────────────────────────────────

export interface ValidationOptions {
  /** When true, writing a citation with null excerpt fails validation. When
   *  false (default), it emits TRGT_CITATION_EXCERPT_MISSING and proceeds. */
  requireCitationExcerpt?: boolean
}

export interface TemporalStoreOptions {
  namespace: string
  /** v0.3: optional. Omitting it registers the namespace as vectorless
   *  (BM25-only retrieval; cannot index vectors until upgradeNamespaceToVector). */
  embeddingDimension?: number
  /** v0.3: optional embedding provider for the default namespace. */
  embeddingProvider?: EmbeddingProvider
  maxEpisodeContentBytes?: number
  graphAdapter?: GraphQueryAdapter
  scorer?: RetrievalScorer
  defaultFormatter?: ContextFormatter
  validators?: AssertionValidator[]
  connectionVerifier?: ConnectionVerifier
  middleware?: RetrievalMiddleware[]
  fts5Tokenizer?: FTS5TokenizerConfig
  schemaExtensions?: SchemaExtensions
  /** v0.3: optional structured logger. Defaults to ConsoleLogger (warn/error to stderr). */
  logger?: Logger
  /** v0.3: optional metrics sink. No default; emission is a no-op when unset. */
  metrics?: Metrics
  validation?: ValidationOptions
}

export interface CreateStoreOptions extends TemporalStoreOptions {
  /** Filename to open a new better-sqlite3 database, OR an existing Database
   *  instance to wrap. */
  database: string | Database
  /** Forwarded to prepareDatabase() when `database` is a string. */
  prepare?: PrepareDatabaseOptions
  /** When true, close() also closes the underlying database. Defaults: true
   *  if `database` was a string (store opened it), false if a Database
   *  instance was passed in (caller owns it). */
  closeDatabaseOnStoreClose?: boolean
}

/** Re-export of better-sqlite3's constructor options, so callers can pass
 *  strongly-typed forwarding options without importing better-sqlite3
 *  types directly. */
export type BetterSqlite3Options = BetterSqlite3ConstructorOptions

export interface PrepareDatabaseOptions {
  /** Default true. */
  loadSqliteVec?: boolean
  /** Default 'WAL'. */
  journalMode?: 'WAL' | 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'OFF'
  /** Default 5000. */
  busyTimeoutMs?: number
  /** Default 'MEMORY'. */
  tempStore?: 'DEFAULT' | 'FILE' | 'MEMORY'
  pragmas?: Record<string, string | number>
  /** Forwarded to `new Database(filename, options)` when source is a filename. */
  betterSqlite3?: BetterSqlite3Options
}

/**
 * A vectorless namespace is upgraded by supplying a dimension, a provider, or
 * both. When both are supplied, `embeddingProvider.dimension` MUST match
 * `embeddingDimension`. When only a provider is supplied, the provider's
 * dimension becomes the namespace dimension.
 */
export type UpgradeNamespaceToVectorOptions =
  | {
      /** Dimension for the new vector configuration. */
      embeddingDimension: number
      /** Optional provider to attach; when supplied, `provider.dimension`
       *  MUST match `embeddingDimension`. */
      embeddingProvider?: EmbeddingProvider
    }
  | {
      /** Provider to attach. Its dimension becomes the namespace dimension. */
      embeddingProvider: EmbeddingProvider
      embeddingDimension?: never
    }

export interface InitNamespaceOptions {
  /** Embedding dimension. Omit for a vectorless namespace. On reopen of an
   *  existing vector-configured namespace, a mismatching value throws
   *  NamespaceDimensionMismatchError. */
  embeddingDimension?: number
  /** Per-namespace embedding provider (process-local; never persisted). */
  embeddingProvider?: EmbeddingProvider
  /** Arbitrary caller metadata stored as JSON. */
  config?: Record<string, unknown>
}

export interface DeleteNamespaceOptions {
  /** Required when extension tables with referencesNamespace: true exist. */
  cascade?: boolean
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface NamespaceStats {
  namespace: string
  /** Null for vectorless namespaces. */
  embeddingDimension: number | null
  /** True iff sqlite-vec is loaded AND the namespace's vec0 table exists. */
  vectorReady: boolean
  episodeCount: number
  assertionCount: number
  activeAssertionCount: number
  supersededCount: number
  citationCount: number
  linkCount: number
  indexedCount: number
  positionRange: { min: number | null; max: number | null }
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean
  errors: string[]
}
