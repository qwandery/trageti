import type { LibraryTable } from '../../domain/types.js';

/**
 * Canonical list of library-owned columns per table.
 * Used by SchemaExtensionApplier for shadow detection.
 * Must stay in sync with the baseline DDL in migrations/v001_baseline.ts.
 */
export const LIBRARY_COLUMNS: Readonly<Record<LibraryTable, readonly string[]>> = {
  trageti_assertions: [
    'id',
    'namespace',
    'type',
    'content',
    'valid_from',
    'valid_until',
    'confidence',
    'source_episode_id',
    'supersedes_id',
    'entity_id',
    'entity_type',
    'created_at',
  ],
  trageti_episodes: ['id', 'namespace', 'position', 'occurred_at', 'type', 'content', 'created_at'],
  trageti_links: [
    'id',
    'namespace',
    'from_id',
    'to_id',
    'link_type',
    'valid_from',
    'valid_until',
    'source_episode_id',
    'created_at',
  ],
};
