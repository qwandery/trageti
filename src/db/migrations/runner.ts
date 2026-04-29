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
      .prepare<[], { version: number | null }>('SELECT MAX(version) AS version FROM trl_schema_version')
      .get()
    return row?.version ?? 0
  }

  applyMigrations(db: Database): void {
    db.exec(BOOTSTRAP_DDL)
    const current = this.getCurrentVersion(db)

    for (const migration of this.migrations) {
      if (migration.version <= current) continue

      try {
        db.transaction(() => {
          migration.up(db)
          db.prepare(
            'INSERT INTO trl_schema_version (version, description) VALUES (?, ?)',
          ).run(migration.version, migration.description)
        })()
      } catch (err) {
        throw new MigrationError(migration.version, err)
      }
    }
  }

  getMigrations(): readonly Migration[] {
    return this.migrations
  }
}
