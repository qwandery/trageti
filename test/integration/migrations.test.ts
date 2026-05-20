import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openTestDb } from '../helpers/openTestDb.js'
import { MigrationRunner } from '../../src/db/migrations/runner.js'

interface SqliteMasterRow {
  name: string
  type: string
  sql: string
}

function getObjects(db: Database, type: string): SqliteMasterRow[] {
  return db
    .prepare<[string], SqliteMasterRow>(`SELECT name, type, sql FROM sqlite_master WHERE type = ?`)
    .all(type)
}

describe('MigrationRunner', () => {
  let db: Database

  beforeEach(async () => {
    db = openTestDb()
  })

  it('applies all migrations on a fresh database', async () => {
    const runner = new MigrationRunner()
    runner.applyMigrations(db)

    expect(runner.getCurrentVersion(db)).toBe(5)

    const tables = getObjects(db, 'table').map((r) => r.name)
    expect(tables).toContain('trageti_namespaces')
    expect(tables).toContain('trageti_episodes')
    expect(tables).toContain('trageti_assertions')
    expect(tables).toContain('trageti_links')
    expect(tables).toContain('trageti_citations')
    expect(tables).toContain('trageti_tokenizer')
    expect(tables).toContain('trageti_schema_version')

    // After the v005 rename, no legacy trl_* table survives.
    expect(tables.some((t) => t.startsWith('trl_'))).toBe(false)
  })

  it('is idempotent — second applyMigrations does not re-apply', async () => {
    const runner = new MigrationRunner()
    runner.applyMigrations(db)
    runner.applyMigrations(db)
    expect(runner.getCurrentVersion(db)).toBe(5)

    const versionRows = db.prepare('SELECT COUNT(*) AS cnt FROM trageti_schema_version').get() as {
      cnt: number
    }
    expect(versionRows.cnt).toBe(5)
  })

  it('creates the FTS5 table', async () => {
    const runner = new MigrationRunner()
    runner.applyMigrations(db)
    const vtables = getObjects(db, 'table').map((r) => r.name)
    expect(vtables).toContain('trageti_fulltext')
  })

  it('creates FTS5 sync triggers', async () => {
    const runner = new MigrationRunner()
    runner.applyMigrations(db)
    const triggers = getObjects(db, 'trigger').map((r) => r.name)
    expect(triggers).toContain('trageti_fulltext_ai')
    expect(triggers).toContain('trageti_fulltext_ad')
    expect(triggers).toContain('trageti_fulltext_au')
  })

  it('creates all required indexes', async () => {
    const runner = new MigrationRunner()
    runner.applyMigrations(db)
    const indexes = getObjects(db, 'index').map((r) => r.name)
    expect(indexes).toContain('trageti_idx_assertions_ns_pos')
    expect(indexes).toContain('trageti_idx_assertions_entity')
    expect(indexes).toContain('trageti_idx_assertions_episode')
    expect(indexes).toContain('trageti_idx_links_from')
    expect(indexes).toContain('trageti_idx_links_to')
    expect(indexes).toContain('trageti_idx_episodes_ns_pos')
    // v002: citations + reverse-supersession lookup
    expect(indexes).toContain('trageti_idx_citations_assertion')
    expect(indexes).toContain('trageti_idx_assertions_supersedes')
  })

  it('upgrades a v001-only DB to v005 cleanly with legacy citation-less assertions', async () => {
    const { createV001Migration } = await import('../../src/db/migrations/v001_initial.js')
    const v001 = createV001Migration()
    // The v0.1-era database is bootstrapped with the legacy trl_* names —
    // v001 factually creates trl_* tables; v005 renames them later.
    db.exec(
      `CREATE TABLE IF NOT EXISTS trl_schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')), description TEXT NOT NULL)`,
    )
    v001.up(db)
    db.prepare('INSERT INTO trl_schema_version (version, description) VALUES (?, ?)').run(
      1,
      v001.description,
    )

    // Insert a legacy citation-less assertion via direct SQL (bypassing the validator).
    db.prepare(
      'INSERT INTO trl_namespaces (namespace, embedding_dimension, embedding_table) VALUES (?, ?, ?)',
    ).run('legacy', 4, 'trl_embeddings_legacy')
    db.prepare(
      `INSERT INTO trl_episodes (id, namespace, position, occurred_at, type, content) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('ep-old', 'legacy', 1, '2024-01-01', 'doc', 'old')
    db.prepare(
      `INSERT INTO trl_assertions (id, namespace, type, content, valid_from, valid_until, confidence, source_episode_id, supersedes_id, entity_id, entity_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('a-legacy', 'legacy', 'fact', 'pre-v002 row', 1, null, 1.0, 'ep-old', null, null, null)

    expect(new MigrationRunner().getCurrentVersion(db)).toBe(1)

    // Now run the full runner — should upgrade to the latest version cleanly.
    new MigrationRunner().applyMigrations(db)
    expect(new MigrationRunner().getCurrentVersion(db)).toBe(5)

    // The v005 rename retired every trl_* table, including the legacy
    // schema-version table (renamed by the runner's self-migration).
    const tables = getObjects(db, 'table').map((r) => r.name)
    expect(tables.some((t) => t.startsWith('trl_'))).toBe(false)

    // trageti_citations exists and is empty.
    expect(tables).toContain('trageti_citations')
    const citCount = db.prepare('SELECT COUNT(*) AS c FROM trageti_citations').get() as {
      c: number
    }
    expect(citCount.c).toBe(0)

    // The legacy row survived the migration chain non-destructively.
    const a = db.prepare('SELECT id FROM trageti_assertions WHERE id = ?').get('a-legacy') as
      | { id: string }
      | undefined
    expect(a?.id).toBe('a-legacy')
  })

  it('records tokenizer args in the FTS5 table DDL', async () => {
    const runner = new MigrationRunner({
      tokenizer: 'unicode61',
      tokenizerArgs: ['remove_diacritics', '1'],
    })
    runner.applyMigrations(db)
    const ftsObj = getObjects(db, 'table').find((r) => r.name === 'trageti_fulltext')
    expect(ftsObj?.sql).toContain('unicode61')
    expect(ftsObj?.sql).toContain('remove_diacritics')
  })

  it('trageti_namespaces has the embedding_table column', async () => {
    const runner = new MigrationRunner()
    runner.applyMigrations(db)
    const cols = db.prepare(`PRAGMA table_info(trageti_namespaces)`).all() as Array<{
      name: string
    }>
    const names = cols.map((c) => c.name)
    expect(names).toContain('embedding_table')
  })

  it('v003 makes namespace vector columns nullable and v005 exposes tokenizer metadata', async () => {
    const runner = new MigrationRunner()
    runner.applyMigrations(db)

    db.prepare(
      'INSERT INTO trageti_namespaces (namespace, embedding_dimension, embedding_table) VALUES (?, ?, ?)',
    ).run('vectorless', null, null)
    const row = db
      .prepare('SELECT tokenizer, tokenizer_args FROM trageti_tokenizer WHERE id = 1')
      .get() as {
      tokenizer: string
      tokenizer_args: string
    }
    expect(row.tokenizer).toBe('unicode61')
    expect(JSON.parse(row.tokenizer_args) as string[]).toEqual(['remove_diacritics', '1'])
  })
})
