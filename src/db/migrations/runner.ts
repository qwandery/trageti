import type { Database } from 'better-sqlite3'
import type { Migration, FTS5TokenizerConfig } from '../../domain/types.js'
import { MigrationError } from '../../errors/index.js'
import { getMigrations } from './index.js'

const BOOTSTRAP_DDL = `
  CREATE TABLE IF NOT EXISTS trl_schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT NOT NULL
  )
`

export class MigrationRunner {
  private readonly migrations: readonly Migration[]

  constructor(tokenizerConfig?: FTS5TokenizerConfig) {
    this.migrations = getMigrations(tokenizerConfig)
  }

  getCurrentVersion(db: Database): number {
    db.exec(BOOTSTRAP_DDL)
    const row = db
      .prepare<
        [],
        { version: number | null }
      >('SELECT MAX(version) AS version FROM trl_schema_version')
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
  }

  /**
   * Standard migration: single transaction wraps the migration body and the
   * schema_version insert (atomic).
   */
  private runStandardMigration(db: Database, migration: Migration): void {
    try {
      db.transaction(() => {
        migration.up(db)
        db.prepare('INSERT INTO trl_schema_version (version, description) VALUES (?, ?)').run(
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
      db.prepare('INSERT INTO trl_schema_version (version, description) VALUES (?, ?)').run(
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
}
