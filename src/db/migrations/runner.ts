import type { Database } from 'better-sqlite3';
import type { FTS5TokenizerConfig, Migration } from '../../domain/types.js';
import { MigrationError } from '../../errors/index.js';
import { validateTokenizer } from '../../internal/tokenizer.js';
import { getMigrations } from './index.js';

const SCHEMA_VERSION_TABLE = 'trageti_schema_version';

const BOOTSTRAP_DDL = `
  CREATE TABLE IF NOT EXISTS ${SCHEMA_VERSION_TABLE} (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT NOT NULL
  )
`;

export class MigrationRunner {
  private readonly migrations: readonly Migration[];

  constructor(tokenizerConfig?: FTS5TokenizerConfig) {
    if (tokenizerConfig) validateTokenizer(tokenizerConfig, 'init');
    this.migrations = getMigrations(tokenizerConfig);
  }

  getCurrentVersion(db: Database): number {
    db.exec(BOOTSTRAP_DDL);
    const row = db
      .prepare<[], { version: number | null }>(`SELECT MAX(version) AS version FROM ${SCHEMA_VERSION_TABLE}`)
      .get();
    return row?.version ?? 0;
  }

  applyMigrations(db: Database): void {
    db.exec(BOOTSTRAP_DDL);
    const current = this.getCurrentVersion(db);

    for (const migration of this.migrations) {
      if (migration.version <= current) continue;
      this.runStandardMigration(db, migration);
    }
  }

  private runStandardMigration(db: Database, migration: Migration): void {
    try {
      db.transaction(() => {
        migration.up(db);
        db.prepare(`INSERT INTO ${SCHEMA_VERSION_TABLE} (version, description) VALUES (?, ?)`).run(
          migration.version,
          migration.description,
        );
      })();
    } catch (err) {
      throw new MigrationError(migration.version, err);
    }
  }

  getMigrations(): readonly Migration[] {
    return this.migrations;
  }

  getAppliedVersions(db: Database): Map<number, string> {
    db.exec(BOOTSTRAP_DDL);
    const rows = db
      .prepare<[], { version: number; applied_at: string }>(`SELECT version, applied_at FROM ${SCHEMA_VERSION_TABLE}`)
      .all();
    return new Map(rows.map((r) => [r.version, r.applied_at]));
  }
}
