import type { Database } from 'better-sqlite3';
import type { Assertion, TemporalSnapshotOptions } from '../domain/types.js';
import type { AssertionRepository } from '../db/repositories/AssertionRepository.js';

export function getTemporalSnapshot(
  _db: Database,
  assertionRepo: AssertionRepository,
  options: TemporalSnapshotOptions,
): Assertion[] {
  let results = assertionRepo.query(options.namespace, {
    validAt: options.atPosition,
    ...(options.includeSuperseded !== undefined && {
      includeSuperseded: options.includeSuperseded,
    }),
  });

  if (options.entityTypes && options.entityTypes.length > 0) {
    const set = new Set(options.entityTypes);
    results = results.filter((a) => a.entityType !== null && set.has(a.entityType));
  }

  if (options.assertionTypes && options.assertionTypes.length > 0) {
    const set = new Set(options.assertionTypes);
    results = results.filter((a) => set.has(a.type));
  }

  return results;
}
