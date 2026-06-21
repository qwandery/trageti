import type { Database } from 'better-sqlite3';
import type { Migration } from '../../domain/types.js';

export const v002NamespaceOperationLocks: Migration = {
  version: 2,
  name: 'v002_namespace_operation_locks',
  description: 'Namespace operation locks and source-episode link index',
  requiresForeignKeyToggle: false,
  up(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS trageti_namespace_locks (
        namespace   TEXT PRIMARY KEY REFERENCES trageti_namespaces(namespace) ON DELETE CASCADE,
        operation   TEXT NOT NULL,
        owner       TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS trageti_idx_links_source_episode
        ON trageti_links(source_episode_id);
    `);
  },
};
