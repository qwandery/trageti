export const ErrorCode = {
  NAMESPACE_NOT_INITIALIZED: 'NAMESPACE_NOT_INITIALIZED',
  NAMESPACE_HASH_COLLISION: 'NAMESPACE_HASH_COLLISION',
  SCHEMA_EXTENSION_ERROR: 'SCHEMA_EXTENSION_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  MIGRATION_ERROR: 'MIGRATION_ERROR',
  CONNECTION_VERIFICATION_ERROR: 'CONNECTION_VERIFICATION_ERROR',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export class TragetiError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
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
    super(ErrorCode.SCHEMA_EXTENSION_ERROR, `Schema extension validation failed:\n${violations.join('\n')}`)
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

  constructor(version: number, cause: unknown) {
    super(
      ErrorCode.MIGRATION_ERROR,
      `Migration v${version} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'MigrationError'
    this.migrationVersion = version
  }
}

export class ConnectionVerificationError extends TragetiError {
  constructor(reason: string) {
    super(ErrorCode.CONNECTION_VERIFICATION_ERROR, `Connection verification failed: ${reason}`)
    this.name = 'ConnectionVerificationError'
  }
}
