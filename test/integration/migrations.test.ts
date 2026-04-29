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

  beforeEach(() => {
    db = openTestDb()
  })

  it('applies v001 on a fresh database', () => {
    const runner = new MigrationRunner()
    runner.applyMigrations(db)

    expect(runner.getCurrentVersion(db)).toBe(1)

    const tables = getObjects(db, 'table').map((r) => r.name)
    expect(tables).toContain('trl_namespaces')
    expect(tables).toContain('trl_episodes')
    expect(tables).toContain('trl_assertions')
    expect(tables).toContain('trl_links')
    expect(tables).toContain('trl_schema_version')
  })

  it('is idempotent — second applyMigrations does not re-apply v001', () => {
    const runner = new MigrationRunner()
    runner.applyMigrations(db)
    runner.applyMigrations(db)
    expect(runner.getCurrentVersion(db)).toBe(1)

    const versionRows = db.prepare('SELECT COUNT(*) AS cnt FROM trl_schema_version').get() as { cnt: number }
    expect(versionRows.cnt).toBe(1)
  })

  it('creates FTS5 table', () => {
    const runner = new MigrationRunner()
    runner.applyMigrations(db)
    const vtables = getObjects(db, 'table').map((r) => r.name)
    expect(vtables).toContain('trl_fts')
  })

  it('creates FTS5 sync triggers', () => {
    const runner = new MigrationRunner()
    runner.applyMigrations(db)
    const triggers = getObjects(db, 'trigger').map((r) => r.name)
    expect(triggers).toContain('trl_fts_ai')
    expect(triggers).toContain('trl_fts_ad')
    expect(triggers).toContain('trl_fts_au')
  })

  it('creates all required indexes', () => {
    const runner = new MigrationRunner()
    runner.applyMigrations(db)
    const indexes = getObjects(db, 'index').map((r) => r.name)
    expect(indexes).toContain('trl_idx_assertions_ns_pos')
    expect(indexes).toContain('trl_idx_assertions_entity')
    expect(indexes).toContain('trl_idx_assertions_episode')
    expect(indexes).toContain('trl_idx_links_from')
    expect(indexes).toContain('trl_idx_links_to')
    expect(indexes).toContain('trl_idx_episodes_ns_pos')
  })

  it('records tokenizer args in FTS5 table DDL', () => {
    const runner = new MigrationRunner({ tokenizer: 'unicode61', tokenizerArgs: ['remove_diacritics', '1'] })
    runner.applyMigrations(db)
    const ftsObj = getObjects(db, 'table').find((r) => r.name === 'trl_fts')
    expect(ftsObj?.sql).toContain('unicode61')
    expect(ftsObj?.sql).toContain('remove_diacritics')
  })

  it('trl_namespaces has embedding_table column', () => {
    const runner = new MigrationRunner()
    runner.applyMigrations(db)
    const cols = db
      .prepare(`PRAGMA table_info(trl_namespaces)`)
      .all() as Array<{ name: string }>
    const names = cols.map((c) => c.name)
    expect(names).toContain('embedding_table')
  })
})
