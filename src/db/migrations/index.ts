import type { Migration, FTS5TokenizerConfig } from '../../domain/types.js'
import { createV001Migration } from './v001_initial.js'

/** Returns the ordered migration list. Must be kept sorted by version with no gaps. */
export function getMigrations(tokenizerConfig?: FTS5TokenizerConfig): readonly Migration[] {
  const migrations: Migration[] = [createV001Migration(tokenizerConfig)]

  // Invariant: version must equal array index + 1 (no gaps, no reordering)
  for (let i = 0; i < migrations.length; i++) {
    const m = migrations[i]
    if (m === undefined || m.version !== i + 1) {
      throw new Error(
        `Migration list invariant violated at index ${i}: expected version ${i + 1}, got ${m?.version ?? 'undefined'}`,
      )
    }
  }

  return migrations
}
