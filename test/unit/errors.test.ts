import { describe, it, expect } from 'vitest';
import {
  ErrorCode,
  TragetiError,
  NamespaceNotInitializedError,
  NamespaceHashCollisionError,
  SchemaExtensionError,
  ValidationError,
  MigrationError,
  ConnectionVerificationError,
} from '../../src/errors/index.js';

describe('TragetiError hierarchy', () => {
  it('NamespaceNotInitializedError carries the right code and name', async () => {
    const err = new NamespaceNotInitializedError('my-ns');
    expect(err).toBeInstanceOf(TragetiError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(ErrorCode.NAMESPACE_NOT_INITIALIZED);
    expect(err.name).toBe('NamespaceNotInitializedError');
    expect(err.message).toContain('my-ns');
  });

  it('NamespaceHashCollisionError reports both namespaces and table', async () => {
    const err = new NamespaceHashCollisionError('a', 'b', 'trageti_embeddings_xxx');
    expect(err.code).toBe(ErrorCode.NAMESPACE_HASH_COLLISION);
    expect(err.name).toBe('NamespaceHashCollisionError');
    expect(err.message).toContain('"a"');
    expect(err.message).toContain('"b"');
    expect(err.message).toContain('trageti_embeddings_xxx');
  });

  it('SchemaExtensionError exposes violations array', async () => {
    const violations = ['column shadows library column', 'reserved word'];
    const err = new SchemaExtensionError(violations);
    expect(err.code).toBe(ErrorCode.SCHEMA_EXTENSION_ERROR);
    expect(err.violations).toEqual(violations);
    expect(err.message).toContain('column shadows library column');
  });

  it('ValidationError exposes errors array', async () => {
    const err = new ValidationError(['id is required', 'content is required']);
    expect(err.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(err.errors).toHaveLength(2);
    expect(err.message).toContain('id is required');
  });

  it('MigrationError captures version and underlying cause', async () => {
    const cause = new Error('SQLITE_ERROR');
    const err = new MigrationError(2, cause);
    expect(err.code).toBe(ErrorCode.MIGRATION_ERROR);
    expect(err.migrationVersion).toBe(2);
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('v2');
    expect(err.message).toContain('SQLITE_ERROR');
  });

  it('MigrationError stringifies non-Error causes', async () => {
    const err = new MigrationError(3, 'plain string cause');
    expect(err.message).toContain('plain string cause');
  });

  it('ConnectionVerificationError carries the right code', async () => {
    const err = new ConnectionVerificationError('vec extension not loaded');
    expect(err.code).toBe(ErrorCode.CONNECTION_VERIFICATION_ERROR);
    expect(err.name).toBe('ConnectionVerificationError');
    expect(err.message).toContain('vec extension not loaded');
  });

  it('ErrorCode values are stable strings', async () => {
    expect(ErrorCode.NAMESPACE_NOT_INITIALIZED).toBe('NAMESPACE_NOT_INITIALIZED');
    expect(ErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
  });
});
