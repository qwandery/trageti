import type { Database } from 'better-sqlite3';
import type { Assertion, TemporalSnapshotOptions } from '../domain/types.js';
import type { AssertionRepository } from '../db/repositories/AssertionRepository.js';

export function getTemporalSnapshot(
  _db: Database,
  assertionRepo: AssertionRepository,
  options: TemporalSnapshotOptions,
): Assertion[] {
  const results = assertionRepo.query(options.namespace, {
    validAt: options.atPosition,
    ...(options.entityTypes !== undefined && {
      entityTypes: options.entityTypes,
    }),
    ...(options.assertionTypes !== undefined && {
      types: options.assertionTypes,
    }),
    ...(options.includeSuperseded !== undefined && {
      includeSuperseded: options.includeSuperseded,
    }),
  });

  return results;
}
