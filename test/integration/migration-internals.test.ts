import { describe, it, expect } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openTestDb } from '../helpers/openTestDb.js'
import { MigrationRunner } from '../../src/db/migrations/runner.js'
import { createV001Migration } from '../../src/db/migrations/v001_initial.js'
import { createV002Migration } from '../../src/db/migrations/v002_citations.js'
import { createV003Migration } from '../../src/db/migrations/v003_vectorless.js'
import { createV004Migration } from '../../src/db/migrations/v004_timestamps.js'
import { createV005Migration } from '../../src/db/migrations/v005_rename.js'
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
    expect(runner.getCurrentVersion(db)).toBe(5)
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

/** Run v001–v004 migration bodies directly, FK enforcement disabled. */
function seedV004Schema(db: Database): void {
  db.pragma('foreign_keys = OFF')
  createV001Migration().up(db)
  createV002Migration().up(db)
  createV003Migration().up(db)
  createV004Migration().up(db)
}

describe('v005 embedding-table rename (copy-swap)', () => {
  it('copies vec0 rows into a trageti_embeddings_ table and drops the legacy table', () => {
    const db = openTestDb()
    seedV004Schema(db)

    // Register a vector namespace carrying a legacy trl_embeddings_ table.
    db.prepare(
      'INSERT INTO trl_namespaces (namespace, embedding_dimension, embedding_table) VALUES (?, ?, ?)',
    ).run('vec-ns', 4, 'trl_embeddings_legacyhash')
    db.exec(
      'CREATE VIRTUAL TABLE trl_embeddings_legacyhash USING vec0(assertion_id TEXT PRIMARY KEY, embedding FLOAT[4])',
    )
    db.prepare('INSERT INTO trl_embeddings_legacyhash (assertion_id, embedding) VALUES (?, ?)').run(
      'a-1',
      new Float32Array([0.1, 0.2, 0.3, 0.4]),
    )

    createV005Migration().up(db)
    db.pragma('foreign_keys = ON')

    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name)
    // The legacy embedding table is gone; the renamed one carries the rows.
    expect(tables).toContain('trageti_embeddings_legacyhash')
    expect(tables).not.toContain('trl_embeddings_legacyhash')
    expect(tables.some((t) => t.startsWith('trl_'))).toBe(false)

    const count = db
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM trageti_embeddings_legacyhash')
      .get()
    expect(count?.c).toBe(1)

    // embedding_table now points at the renamed table — the authoritative name.
    const ns = db
      .prepare<
        [string],
        { embedding_table: string }
      >('SELECT embedding_table FROM trageti_namespaces WHERE namespace = ?')
      .get('vec-ns')
    expect(ns?.embedding_table).toBe('trageti_embeddings_legacyhash')
  })

  it('repoints embedding_table without a vec0 op when the legacy table was never created', () => {
    const db = openTestDb()
    seedV004Schema(db)
    db.prepare(
      'INSERT INTO trl_namespaces (namespace, embedding_dimension, embedding_table) VALUES (?, ?, ?)',
    ).run('lazy-ns', 4, 'trl_embeddings_neverbuilt')

    createV005Migration().up(db)
    db.pragma('foreign_keys = ON')

    const ns = db
      .prepare<
        [string],
        { embedding_table: string }
      >('SELECT embedding_table FROM trageti_namespaces WHERE namespace = ?')
      .get('lazy-ns')
    expect(ns?.embedding_table).toBe('trageti_embeddings_neverbuilt')
  })
})
