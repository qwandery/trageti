// ─── Main facade ───────────────────────────────────────────────────────────────
export { TemporalStore } from './store/TemporalStore.js';

// ─── Domain types ──────────────────────────────────────────────────────────────
export type {
  Episode,
  Assertion,
  AssertionCitation,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate public back-compat alias
  NewAssertion,
  NewAssertionInput,
  NormalizedNewAssertion,
  NewAssertionCitation,
  NewLateCitation,
  AssertionLink,
  NamespaceConfig,
  RetrievalQuery,
  RetrievalMode,
  RetrievalStrategy,
  QueryTextMode,
  RetrievalResult,
  RetrievalMeta,
  RetrievalWarning,
  RetrievedAssertion,
  ScoredCandidate,
  ScoringContext,
  ContextAssemblyOptions,
  AssembledContext,
  FormattedContext,
  TraversalOptions,
  PathOptions,
  GraphAdapterTraversalOptions,
  TemporalSnapshotOptions,
  LibraryTable,
  ColumnExtension,
  TableExtension,
  SchemaExtensions,
  Migration,
  MigrationDescriptor,
  FTS5TokenizerConfig,
  TemporalStoreOptions,
  CreateStoreOptions,
  PrepareDatabaseOptions,
  ValidationOptions,
  DeleteNamespaceOptions,
  UpgradeNamespaceToVectorOptions,
  InitNamespaceOptions,
  NamespaceStats,
  IndexBatchItem,
  IndexBatchOptions,
  IndexBatchResult,
  ReindexOptions,
  ReindexResult,
  RebuildFtsOptions,
  RebuildFtsResult,
  RetrievalExplainResult,
  RetrievalExplainStep,
  RetrievalDebug,
  RetrievalStep,
  RetrievalStepInfo,
  EmbeddingProvider,
  EmbedOptions,
  ValidationResult,
  // Extension interfaces
  GraphQueryAdapter,
  RetrievalScorer,
  ContextFormatter,
  AssertionValidator,
  ConnectionVerifier,
  RetrievalMiddleware,
} from './domain/types.js';
export type { Logger, Metrics, LogFields } from './internal/logger.js';

// ─── Vocabulary constants ──────────────────────────────────────────────────────
export { RecommendedAssertionTypes, RecommendedLinkTypes } from './domain/vocabulary.js';
export type { RecommendedAssertionType, RecommendedLinkType } from './domain/vocabulary.js';

// ─── Default implementations ───────────────────────────────────────────────────
export { CTEGraphAdapter } from './defaults/graph/CTEGraphAdapter.js';
export { DefaultScorer } from './defaults/scoring/DefaultScorer.js';
export { ProseFormatter } from './defaults/formatting/ProseFormatter.js';
export { StructuredFormatter } from './defaults/formatting/StructuredFormatter.js';
export { JsonFormatter } from './defaults/formatting/JsonFormatter.js';
export { DefaultAssertionValidator } from './defaults/validation/DefaultAssertionValidator.js';
export { DefaultConnectionVerifier } from './defaults/connection/DefaultConnectionVerifier.js';
export { prepareDatabase } from './defaults/connection/prepareDatabase.js';
export type { BetterSqlite3Options } from './defaults/connection/prepareDatabase.js';
export { ConsoleLogger, NoopLogger } from './internal/logger.js';
export { MockEmbeddingProvider } from './defaults/providers/MockEmbeddingProvider.js';
export type { MockEmbeddingProviderOptions } from './defaults/providers/MockEmbeddingProvider.js';
export type { DefaultAssertionValidatorOptions } from './defaults/validation/DefaultAssertionValidator.js';
export { RawVectorProvider } from './defaults/providers/RawVectorProvider.js';

// ─── Error classes ──────────────────────────────────────────────────────────────
export {
  ErrorCode,
  TragetiError,
  NamespaceNotInitializedError,
  NamespaceHashCollisionError,
  SchemaExtensionError,
  ValidationError,
  MigrationError,
  MigrationCompatibilityError,
  ConnectionVerificationError,
  StoreClosedError,
  NamespaceDimensionMismatchError,
  IndexingError,
  RetrievalInputError,
  ReindexError,
  EmbeddingProviderError,
  ReferencedExtensionTableError,
  MissingPeerDependencyError,
} from './errors/index.js';
