import { describe, it, expect } from 'vitest'
import { openTestDb } from '../helpers/openTestDb.js'
import { MigrationRunner } from '../../src/db/migrations/runner.js'
import { createV001Migration } from '../../src/db/migrations/v001_initial.js'
import { createV002Migration } from '../../src/db/migrations/v002_citations.js'
import { MigrationError } from '../../src/errors/index.js'

/** Bring a fresh db to the v002 schema state without running v003+. */
function seedV002(db: ReturnType<typeof openTestDb>): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS trl_schema_version (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now')),
       description TEXT NOT NULL
     )`,
  )
  const v001 = createV001Migration()
  const v002 = createV002Migration()
  v001.up(db)
  v002.up(db)
  const record = db.prepare('INSERT INTO trl_schema_version (version, description) VALUES (?, ?)')
  record.run(1, v001.description)
  record.run(2, v002.description)
}

describe('v003 tokenizer-compatibility check', () => {
  it('upgrades cleanly when a pre-existing trl_fts_meta row matches the requested tokenizer', () => {
    const db = openTestDb()
    seedV002(db)
    db.exec(`
      CREATE TABLE trl_fts_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tokenizer TEXT NOT NULL,
        tokenizer_args TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    db.prepare('INSERT INTO trl_fts_meta (id, tokenizer, tokenizer_args) VALUES (1, ?, ?)').run(
      'unicode61',
      JSON.stringify(['remove_diacritics', '1']),
    )

    const runner = new MigrationRunner()
    expect(() => runner.applyMigrations(db)).not.toThrow()
    expect(runner.getCurrentVersion(db)).toBe(4)
  })

  it('rejects the upgrade and rolls back when the pre-existing tokenizer is incompatible', () => {
    const db = openTestDb()
    seedV002(db)
    db.exec(`
      CREATE TABLE trl_fts_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tokenizer TEXT NOT NULL,
        tokenizer_args TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    db.prepare('INSERT INTO trl_fts_meta (id, tokenizer, tokenizer_args) VALUES (1, ?, ?)').run(
      'porter',
      JSON.stringify([]),
    )

    const runner = new MigrationRunner()
    expect(() => runner.applyMigrations(db)).toThrow(MigrationError)
    // The FK-toggle migration rolled back: the schema stayed at v002.
    expect(runner.getCurrentVersion(db)).toBe(2)
  })
})
