import type { Database } from 'better-sqlite3'
import type { Migration, FTS5TokenizerConfig } from '../../domain/types.js'
import { MigrationError } from '../../errors/index.js'
import { validateTokenizer } from '../../internal/tokenizer.js'
import { getMigrations } from './index.js'

/**
 * The schema-version table is renamed `trl_schema_version` → `trageti_schema_version`
 * by the runner itself, not by a migration: the runner reads it to decide which
 * migrations to run and writes it to record each one, so a migration that
 * renamed it would deadlock its own version tracking. The copy step lives in
 * `getCurrentVersion()`; the legacy table is dropped only after a fully
 * successful `applyMigrations()` run.
 */
const SCHEMA_VERSION_TABLE = 'trageti_schema_version'
const LEGACY_SCHEMA_VERSION_TABLE = 'trl_schema_version'

const BOOTSTRAP_DDL = `
  CREATE TABLE IF NOT EXISTS ${SCHEMA_VERSION_TABLE} (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT NOT NULL
  )
`

export class MigrationRunner {
  private readonly migrations: readonly Migration[]

  constructor(tokenizerConfig?: FTS5TokenizerConfig) {
    // Validate the tokenizer config before any migration DDL is built — a
    // rejected tokenizer must never reach a CREATE VIRTUAL TABLE string.
    if (tokenizerConfig) validateTokenizer(tokenizerConfig, 'init')
    this.migrations = getMigrations(tokenizerConfig)
  }

  getCurrentVersion(db: Database): number {
    db.exec(BOOTSTRAP_DDL)
    // Carry the legacy version history forward (copy only — the legacy table
    // is dropped by applyMigrations once every pending migration has succeeded).
    const legacy = db
      .prepare<
        [string],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(LEGACY_SCHEMA_VERSION_TABLE)
    if (legacy) {
      db.exec(
        `INSERT INTO ${SCHEMA_VERSION_TABLE} (version, applied_at, description)
           SELECT version, applied_at, description FROM ${LEGACY_SCHEMA_VERSION_TABLE}
           WHERE version NOT IN (SELECT version FROM ${SCHEMA_VERSION_TABLE})`,
      )
    }
    const row = db
      .prepare<
        [],
        { version: number | null }
      >(`SELECT MAX(version) AS version FROM ${SCHEMA_VERSION_TABLE}`)
      .get()
    return row?.version ?? 0
  }

  applyMigrations(db: Database): void {
    db.exec(BOOTSTRAP_DDL)
    const current = this.getCurrentVersion(db)

    for (const migration of this.migrations) {
      if (migration.version <= current) continue
      if (migration.requiresForeignKeyToggle) {
        this.runFkToggleMigration(db, migration)
      } else {
        this.runStandardMigration(db, migration)
      }
    }

    // Every pending migration succeeded — retire the legacy version table.
    // A mid-run failure above leaves it in place, so a failed run never
    // strands the version history.
    db.exec(`DROP TABLE IF EXISTS ${LEGACY_SCHEMA_VERSION_TABLE}`)
  }

  /**
   * Standard migration: single transaction wraps the migration body and the
   * schema_version insert (atomic).
   */
  private runStandardMigration(db: Database, migration: Migration): void {
    try {
      db.transaction(() => {
        migration.up(db)
        db.prepare(`INSERT INTO ${SCHEMA_VERSION_TABLE} (version, description) VALUES (?, ?)`).run(
          migration.version,
          migration.description,
        )
      })()
    } catch (err) {
      throw new MigrationError(migration.version, err)
    }
  }

  /**
   * FK-toggle migration (spec §1326). PRAGMA foreign_keys cannot be changed
   * inside an active transaction, so we capture the current setting, disable
   * FKs, then run the migration body in an explicit BEGIN/COMMIT, run
   * `foreign_key_check`, and restore the captured FK state in `finally`.
   *
   * The schema_version insert lives INSIDE the transaction (before COMMIT) so
   * a failed FK check causes the entire migration to roll back atomically.
   */
  private runFkToggleMigration(db: Database, migration: Migration): void {
    const capturedFk = (db.pragma('foreign_keys', { simple: true }) as number) === 1
    db.pragma('foreign_keys = OFF')
    let txOpen = false
    try {
      db.exec('BEGIN')
      txOpen = true
      migration.up(db)
      const violations = db.pragma('foreign_key_check') as Array<Record<string, unknown>>
      if (Array.isArray(violations) && violations.length > 0) {
        throw new MigrationError(
          migration.version,
          'foreign_key_check found violations after migration body',
          {
            violations,
          },
        )
      }
      db.prepare(`INSERT INTO ${SCHEMA_VERSION_TABLE} (version, description) VALUES (?, ?)`).run(
        migration.version,
        migration.description,
      )
      db.exec('COMMIT')
      txOpen = false
    } catch (err) {
      if (txOpen) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* nothing further to do */
        }
      }
      if (err instanceof MigrationError) throw err
      throw new MigrationError(migration.version, err)
    } finally {
      db.pragma(`foreign_keys = ${capturedFk ? 'ON' : 'OFF'}`)
    }
  }

  getMigrations(): readonly Migration[] {
    return this.migrations
  }

  /**
   * Map of `version → applied_at` for every migration recorded in the
   * schema-version table. Used to populate `MigrationDescriptor.appliedAt`.
   */
  getAppliedVersions(db: Database): Map<number, string> {
    db.exec(BOOTSTRAP_DDL)
    const rows = db
      .prepare<
        [],
        { version: number; applied_at: string }
      >(`SELECT version, applied_at FROM ${SCHEMA_VERSION_TABLE}`)
      .all()
    return new Map(rows.map((r) => [r.version, r.applied_at]))
  }
}
