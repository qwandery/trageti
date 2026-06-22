import type { Database } from 'better-sqlite3';
import type { Migration } from '../../domain/types.js';

export const v003NamespaceLockHeartbeat: Migration = {
  version: 3,
  name: 'v003_namespace_lock_heartbeat',
  description: 'Namespace operation lock heartbeat timestamp',
  requiresForeignKeyToggle: false,
  up(db: Database): void {
    const columns = db
      .prepare<[], { name: string }>('PRAGMA table_info(trageti_namespace_locks)')
      .all()
      .map((row) => row.name.toLowerCase());
    if (!columns.includes('heartbeat_at')) {
      db.exec('ALTER TABLE trageti_namespace_locks ADD COLUMN heartbeat_at TEXT');
    }
    db.exec(`
      UPDATE trageti_namespace_locks
      SET heartbeat_at = acquired_at
      WHERE heartbeat_at IS NULL;

      CREATE INDEX IF NOT EXISTS trageti_idx_namespace_locks_heartbeat
        ON trageti_namespace_locks(heartbeat_at);
    `);
  },
};
