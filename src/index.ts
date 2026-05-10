// ─── Main facade ───────────────────────────────────────────────────────────────
export { TemporalStore } from './store/TemporalStore.js'

// ─── Domain types ──────────────────────────────────────────────────────────────
export type {
  Episode,
  Assertion,
  AssertionCitation,
  NewAssertion,
  NewAssertionCitation,
  AssertionLink,
  NamespaceConfig,
  RetrievalQuery,
  RetrievalMode,
  RetrievedAssertion,
  ScoredCandidate,
  ScoringContext,
  ContextAssemblyOptions,
  AssembledContext,
  FormattedContext,
  TraversalOptions,
  PathOptions,
  LibraryTable,
  ColumnExtension,
  TableExtension,
  SchemaExtensions,
  Migration,
  FTS5TokenizerConfig,
  TemporalStoreOptions,
  NamespaceStats,
  ValidationResult,
  // Extension interfaces
  GraphQueryAdapter,
  RetrievalScorer,
  ContextFormatter,
  AssertionValidator,
  ConnectionVerifier,
  RetrievalMiddleware,
} from './domain/types.js'

// ─── Vocabulary constants ──────────────────────────────────────────────────────
export { RecommendedAssertionTypes, RecommendedLinkTypes } from './domain/vocabulary.js'
export type { RecommendedAssertionType, RecommendedLinkType } from './domain/vocabulary.js'

// ─── Default implementations ───────────────────────────────────────────────────
export { CTEGraphAdapter } from './defaults/graph/CTEGraphAdapter.js'
export { DefaultScorer } from './defaults/scoring/DefaultScorer.js'
export { ProseFormatter } from './defaults/formatting/ProseFormatter.js'
export { StructuredFormatter } from './defaults/formatting/StructuredFormatter.js'
export { JsonFormatter } from './defaults/formatting/JsonFormatter.js'
export { DefaultAssertionValidator } from './defaults/validation/DefaultAssertionValidator.js'
export { DefaultConnectionVerifier } from './defaults/connection/DefaultConnectionVerifier.js'

// ─── Error classes ──────────────────────────────────────────────────────────────
export {
  ErrorCode,
  TragetiError,
  NamespaceNotInitializedError,
  NamespaceHashCollisionError,
  SchemaExtensionError,
  ValidationError,
  MigrationError,
  ConnectionVerificationError,
} from './errors/index.js'
