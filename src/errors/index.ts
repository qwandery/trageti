/**
 * v0.3 error model.
 *
 * Stable `code` values are part of the public contract. Every error class
 * exposes a `.code` value that callers can match on without parsing messages.
 *
 * Codes use the TRGT_ prefix for stability and a few sub-namespaces:
 *   - VALIDATION_* — write-time validation
 *   - INDEXING_*   — indexAssertion / indexBatch
 *   - RETRIEVAL_*  — retrieve / explain input validation
 *   - SCORER_*     — DefaultScorer / RetrievalScorer contract violations
 *   - MIGRATION_*  — migration runner / tokenizer compatibility
 *   - STORE_*      — lifecycle (closed, not initialized, hash collision)
 *   - SCHEMA_*     — schema-extension validation
 *   - PEER_DEP_*   — missing sqlite-vec or other peer dependency
 *   - REINDEX_*    — reindex failures
 *   - EMBEDDING_*  — embedding-provider failures
 */

export const ErrorCode = {
  // v0.2 codes — preserved for back-compat
  NAMESPACE_NOT_INITIALIZED: 'NAMESPACE_NOT_INITIALIZED',
  NAMESPACE_HASH_COLLISION: 'NAMESPACE_HASH_COLLISION',
  SCHEMA_EXTENSION_ERROR: 'SCHEMA_EXTENSION_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  MIGRATION_ERROR: 'MIGRATION_ERROR',
  CONNECTION_VERIFICATION_ERROR: 'CONNECTION_VERIFICATION_ERROR',

  // v0.3 codes
  STORE_CLOSED: 'STORE_CLOSED',
  NAMESPACE_DIMENSION_MISMATCH: 'NAMESPACE_DIMENSION_MISMATCH',
  MIGRATION_COMPATIBILITY: 'MIGRATION_COMPATIBILITY',
  REFERENCED_EXTENSION_TABLE: 'REFERENCED_EXTENSION_TABLE',
  MISSING_PEER_DEPENDENCY: 'MISSING_PEER_DEPENDENCY',
  EMBEDDING_PROVIDER_ERROR: 'EMBEDDING_PROVIDER_ERROR',
  REINDEX_ERROR: 'REINDEX_ERROR',
  REINDEX_PARTIAL_REJECTED: 'REINDEX_PARTIAL_REJECTED',

  // Domain-prefixed codes used inside IndexingError / RetrievalInputError / DefaultScorer
  INDEXING_NAMESPACE_VECTORLESS: 'INDEXING_NAMESPACE_VECTORLESS',
  INDEXING_ASSERTION_NOT_FOUND: 'ASSERTION_NOT_FOUND',
  INDEXING_EMBEDDING_DIMENSION_MISMATCH: 'EMBEDDING_DIMENSION_MISMATCH',
  INDEXING_NO_EMBEDDING_AND_NO_PROVIDER: 'NO_EMBEDDING_AND_NO_PROVIDER',

  RETRIEVAL_INPUT_EMPTY: 'RETRIEVAL_INPUT_EMPTY',
  RETRIEVAL_REQUIRES_QUERY_TEXT: 'RETRIEVAL_REQUIRES_QUERY_TEXT',
  RETRIEVAL_REQUIRES_VECTOR_INPUT: 'RETRIEVAL_REQUIRES_VECTOR_INPUT',
  RETRIEVAL_DIMENSION_MISMATCH: 'RETRIEVAL_DIMENSION_MISMATCH',
  RETRIEVAL_INVALID_LIMIT: 'RETRIEVAL_INVALID_LIMIT',
  RETRIEVAL_INVALID_MAX_DEPTH: 'RETRIEVAL_INVALID_MAX_DEPTH',
  RETRIEVAL_NAMESPACE_VECTORLESS: 'RETRIEVAL_NAMESPACE_VECTORLESS',

  SCORER_NO_USABLE_SIGNAL: 'SCORER_NO_USABLE_SIGNAL',
  SCORER_INVALID_OUTPUT: 'SCORER_INVALID_OUTPUT',

  // Internal-invariant violations — a "this should never happen" guard tripped.
  INTERNAL_INVARIANT: 'INTERNAL_INVARIANT',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export class TragetiError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TragetiError'
    this.code = code
  }
}

export class NamespaceNotInitializedError extends TragetiError {
  constructor(namespace: string) {
    super(
      ErrorCode.NAMESPACE_NOT_INITIALIZED,
      `Namespace "${namespace}" has not been initialized. Call store.init() or store.initNamespace() first.`,
    )
    this.name = 'NamespaceNotInitializedError'
  }
}

export class NamespaceHashCollisionError extends TragetiError {
  constructor(namespace: string, collidingNamespace: string, tableName: string) {
    super(
      ErrorCode.NAMESPACE_HASH_COLLISION,
      `Namespace "${namespace}" hashes to embedding table "${tableName}", which is already in use by namespace "${collidingNamespace}". Rename one of the namespaces.`,
    )
    this.name = 'NamespaceHashCollisionError'
  }
}

export class SchemaExtensionError extends TragetiError {
  readonly violations: string[]

  constructor(violations: string[]) {
    super(
      ErrorCode.SCHEMA_EXTENSION_ERROR,
      `Schema extension validation failed:\n${violations.join('\n')}`,
    )
    this.name = 'SchemaExtensionError'
    this.violations = violations
  }
}

export class ValidationError extends TragetiError {
  readonly errors: string[]

  constructor(errors: string[]) {
    super(ErrorCode.VALIDATION_ERROR, `Assertion validation failed:\n${errors.join('\n')}`)
    this.name = 'ValidationError'
    this.errors = errors
  }
}

export class MigrationError extends TragetiError {
  readonly migrationVersion: number
  readonly violations?: ReadonlyArray<Record<string, unknown>>

  constructor(
    version: number,
    cause: unknown,
    options?: { violations?: ReadonlyArray<Record<string, unknown>> },
  ) {
    super(
      ErrorCode.MIGRATION_ERROR,
      `Migration v${version} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'MigrationError'
    this.migrationVersion = version
    if (options?.violations) this.violations = options.violations
  }
}

export class ConnectionVerificationError extends TragetiError {
  constructor(reason: string) {
    super(ErrorCode.CONNECTION_VERIFICATION_ERROR, `Connection verification failed: ${reason}`)
    this.name = 'ConnectionVerificationError'
  }
}

// ─── v0.3 errors ────────────────────────────────────────────────────────────

export class StoreClosedError extends TragetiError {
  constructor(operation?: string) {
    super(
      ErrorCode.STORE_CLOSED,
      operation
        ? `TemporalStore has been closed; cannot invoke "${operation}".`
        : 'TemporalStore has been closed; no further operations are allowed.',
    )
    this.name = 'StoreClosedError'
  }
}

export class NamespaceDimensionMismatchError extends TragetiError {
  readonly namespace: string
  /** The namespace's registered dimension, or `null` when it is vectorless
   *  (the caller attempted a vectorless → vector re-registration). */
  readonly expected: number | null
  readonly actual: number

  constructor(namespace: string, expected: number | null, actual: number) {
    super(
      ErrorCode.NAMESPACE_DIMENSION_MISMATCH,
      expected === null
        ? `Namespace "${namespace}" is registered as vectorless (no embedding dimension). ` +
            `To add vector support call ` +
            `store.upgradeNamespaceToVector("${namespace}", { embeddingDimension: ${String(actual)} }) ` +
            `— re-registering it via initNamespace() with a dimension is not the upgrade path.`
        : `Namespace "${namespace}" was registered with embedding dimension ${String(expected)}; got ${String(actual)}.`,
    )
    this.name = 'NamespaceDimensionMismatchError'
    this.namespace = namespace
    this.expected = expected
    this.actual = actual
  }
}

export class MigrationCompatibilityError extends TragetiError {
  readonly kind: string
  readonly details: Record<string, unknown>

  constructor(kind: string, message: string, details: Record<string, unknown> = {}) {
    super(ErrorCode.MIGRATION_COMPATIBILITY, message)
    this.name = 'MigrationCompatibilityError'
    this.kind = kind
    this.details = details
  }
}

export class ReferencedExtensionTableError extends TragetiError {
  readonly namespace: string
  readonly blockingTables: string[]

  constructor(namespace: string, blockingTables: string[]) {
    super(
      ErrorCode.REFERENCED_EXTENSION_TABLE,
      `Cannot delete namespace "${namespace}" — extension tables reference it: ${blockingTables.join(', ')}. Pass { cascade: true } to delete per-namespace rows from each.`,
    )
    this.name = 'ReferencedExtensionTableError'
    this.namespace = namespace
    this.blockingTables = blockingTables
  }
}

export class MissingPeerDependencyError extends TragetiError {
  readonly packageName: string
  readonly installCommand: string
  readonly alternative?: string

  constructor(packageName: string, installCommand: string, alternative?: string) {
    const altSuffix = alternative ? ` Alternative: ${alternative}` : ''
    super(
      ErrorCode.MISSING_PEER_DEPENDENCY,
      `Missing peer dependency "${packageName}". Install with: ${installCommand}.${altSuffix}`,
    )
    this.name = 'MissingPeerDependencyError'
    this.packageName = packageName
    this.installCommand = installCommand
    if (alternative !== undefined) this.alternative = alternative
  }
}

export class IndexingError extends TragetiError {
  readonly assertionId?: string

  constructor(code: string, message: string, options: { assertionId?: string } = {}) {
    super(code, message)
    this.name = 'IndexingError'
    if (options.assertionId !== undefined) this.assertionId = options.assertionId
  }
}

export class RetrievalInputError extends TragetiError {
  constructor(code: string, message: string) {
    super(code, message)
    this.name = 'RetrievalInputError'
  }
}

/** Per-item failure entry shared by IndexBatchResult and ReindexResult. */
export interface SkippedEntry {
  assertionId: string
  reason: string
  errorCode?: string
}

export class ReindexError extends TragetiError {
  readonly namespace: string
  readonly indexed: number
  /** Populated for a REINDEX_PARTIAL_REJECTED error: the per-item skips that
   *  the staging build collected under `onProviderError: 'skip'`. */
  readonly skipped?: readonly SkippedEntry[]
  /** Populated for a REINDEX_PARTIAL_REJECTED error: actionable recovery guidance. */
  readonly advice?: string

  constructor(
    namespace: string,
    indexed: number,
    cause: unknown,
    options?: { code?: string; skipped?: readonly SkippedEntry[]; advice?: string },
  ) {
    super(
      options?.code ?? ErrorCode.REINDEX_ERROR,
      `Reindex failed for namespace "${namespace}" after indexing ${indexed} rows: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    )
    this.name = 'ReindexError'
    this.namespace = namespace
    this.indexed = indexed
    if (options?.skipped) this.skipped = options.skipped
    if (options?.advice) this.advice = options.advice
  }
}

export class EmbeddingProviderError extends TragetiError {
  readonly providerName: string
  readonly indexed: number

  constructor(providerName: string, indexed: number, cause: unknown, extraMessage?: string) {
    const tail = extraMessage ? ` ${extraMessage}` : ''
    super(
      ErrorCode.EMBEDDING_PROVIDER_ERROR,
      `Embedding provider "${providerName}" failed after ${indexed} rows: ${
        cause instanceof Error ? cause.message : String(cause)
      }.${tail}`,
      { cause },
    )
    this.name = 'EmbeddingProviderError'
    this.providerName = providerName
    this.indexed = indexed
  }
}

/**
 * Derive a short, sanitized, stable error-code token from an unknown thrown
 * value — the thrown error's `.code` when it carries one, otherwise `'UNKNOWN'`.
 * Used for `skipped[].errorCode` and `TRGT_RETRIEVAL_DEBUG_HOOK_ERROR` logging,
 * where a raw error message must never be surfaced (it may leak content,
 * query text, or secrets).
 */
export function errorCodeOf(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code: unknown = err.code
    if (typeof code === 'string' && code.length > 0) {
      return code.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64)
    }
  }
  return 'UNKNOWN'
}
