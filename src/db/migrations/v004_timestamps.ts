import type { Database } from 'better-sqlite3'
import type { Migration } from '../../domain/types.js'

/**
 * v004: canonical ISO-8601 `created_at` backfill.
 *
 * v0.1–v0.3 wrote `created_at` via the SQLite column default `datetime('now')`,
 * which produces `'YYYY-MM-DD HH:MM:SS'` (space separator, second precision).
 * The v0.3 determinism tie-break orders by `createdAt ASC` lexicographically,
 * so the column must hold a single canonical format. v0.3 repositories now
 * generate `new Date().toISOString()` for new rows; this migration rewrites
 * any pre-existing rows to the same canonical ISO-8601 form so the whole
 * column is consistent.
 *
 * Standard (non-FK-toggle) migration — it only UPDATEs a column value.
 * `strftime` accepts both the old space-separated form and ISO-8601 input,
 * so the migration is idempotent.
 */
export function createV004Migration(): Migration {
  return {
    version: 4,
    name: 'v004_timestamps',
    description: 'Backfill created_at columns to canonical ISO-8601',
    up(db: Database): void {
      const tables = [
        'trl_namespaces',
        'trl_episodes',
        'trl_assertions',
        'trl_links',
        'trl_citations',
      ]
      for (const table of tables) {
        db.exec(
          `UPDATE ${table}
              SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
            WHERE created_at IS NOT NULL`,
        )
      }
    },
  }
}
