// ─── Main facade ───────────────────────────────────────────────────────────────
export { TragetiStore } from './store/TragetiStore.js';

// ─── Domain types ──────────────────────────────────────────────────────────────
export type {
  Episode,
  Assertion,
  AssertionCitation,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate public back-compat alias
  NewAssertion,
  NewAssertionInput,
  NewEpisodeInput,
  NewEpisodeBundleInput,
  EpisodeBundleWriteResult,
  NewAssertionLinkInput,
  NormalizedNewAssertion,
  NewAssertionCitation,
  NewLateCitation,
  AssertionLink,
  GraphAdapterLink,
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
  RerankCandidate,
  RerankingContext,
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
  TragetiStoreOptions,
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
  IRetrievalScorer,
  IRetrievalReranker,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate public back-compat alias
  RetrievalScorer,
  TokenCounter,
  FormatterTokenOptions,
  ContextFormatter,
  AssertionValidator,
  ConnectionVerifier,
  RetrievalMiddleware,
} from './domain/types.js';
export { selfCitation } from './domain/citations.js';
export type { SelfCitationInput } from './domain/citations.js';
export type { Logger, Metrics, LogFields } from './internal/logger.js';

// ─── Vocabulary constants ──────────────────────────────────────────────────────
export { RecommendedAssertionTypes, RecommendedLinkTypes } from './domain/vocabulary.js';
export type { RecommendedAssertionType, RecommendedLinkType } from './domain/vocabulary.js';

// ─── Default implementations ───────────────────────────────────────────────────
export { CTEGraphAdapter } from './defaults/graph/CTEGraphAdapter.js';
// eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate public compatibility export
export { DefaultScorer } from './defaults/scoring/DefaultScorer.js';
export { LinearScorer } from './defaults/scoring/LinearScorer.js';
export type { LinearScorerOptions, LinearScorerWeights } from './defaults/scoring/LinearScorer.js';
export { RRFScorer } from './defaults/scoring/RRFScorer.js';
export type { RRFScorerOptions } from './defaults/scoring/RRFScorer.js';
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
