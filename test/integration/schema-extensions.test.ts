import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openTestDb } from '../helpers/openTestDb.js'
import { MigrationRunner } from '../../src/db/migrations/runner.js'
import { SchemaExtensionApplier } from '../../src/db/schema/extensions.js'
import { SchemaExtensionError } from '../../src/errors/index.js'

function setupDb(db: Database): void {
  new MigrationRunner().applyMigrations(db)
}

describe('SchemaExtensionApplier.validate', () => {
  it('accepts valid extensions without throwing', async () => {
    const applier = new SchemaExtensionApplier()
    expect(() =>
      applier.validate({
        columns: [
          {
            table: 'trageti_assertions',
            column: 'approval_status',
            definition: "TEXT NOT NULL DEFAULT 'pending'",
          },
        ],
      }),
    ).not.toThrow()
  })

  it('rejects column names starting with trageti_', async () => {
    const applier = new SchemaExtensionApplier()
    expect(() =>
      applier.validate({
        columns: [{ table: 'trageti_assertions', column: 'trageti_foo', definition: 'TEXT' }],
      }),
    ).toThrow(SchemaExtensionError)
  })

  it('rejects SQLite reserved keywords as column names', async () => {
    const applier = new SchemaExtensionApplier()
    expect(() =>
      applier.validate({
        columns: [{ table: 'trageti_assertions', column: 'select', definition: 'TEXT' }],
      }),
    ).toThrow(SchemaExtensionError)
  })

  it('rejects columns that shadow library columns', async () => {
    const applier = new SchemaExtensionApplier()
    expect(() =>
      applier.validate({
        columns: [{ table: 'trageti_assertions', column: 'content', definition: 'TEXT' }],
      }),
    ).toThrow(SchemaExtensionError)
  })

  it('rejects table names starting with trageti_', async () => {
    const applier = new SchemaExtensionApplier()
    expect(() =>
      applier.validate({
        tables: [
          {
            tableName: 'trageti_my_table',
            createSQL: 'CREATE TABLE IF NOT EXISTS trageti_my_table (id TEXT)',
            referencesNamespace: false,
          },
        ],
      }),
    ).toThrow(SchemaExtensionError)
  })

  it('accumulates multiple violations in one error', async () => {
    const applier = new SchemaExtensionApplier()
    let err: SchemaExtensionError | undefined
    try {
      applier.validate({
        columns: [
          { table: 'trageti_assertions', column: 'trageti_bad', definition: 'TEXT' },
          { table: 'trageti_assertions', column: 'select', definition: 'TEXT' },
        ],
      })
    } catch (e) {
      err = e as SchemaExtensionError
    }
    expect(err).toBeInstanceOf(SchemaExtensionError)
    expect(err?.violations.length).toBe(2)
  })
})

describe('SchemaExtensionApplier.apply', () => {
  let db: Database

  beforeEach(async () => {
    db = openTestDb()
    setupDb(db)
  })

  it('adds a new column to trageti_assertions', async () => {
    const applier = new SchemaExtensionApplier()
    applier.apply(db, {
      columns: [
        {
          table: 'trageti_assertions',
          column: 'approval_status',
          definition: "TEXT NOT NULL DEFAULT 'pending'",
        },
      ],
    })
    const cols = db.prepare(`PRAGMA table_info(trageti_assertions)`).all() as Array<{
      name: string
    }>
    expect(cols.map((c) => c.name)).toContain('approval_status')
  })

  it('is idempotent — second apply does not error or duplicate', async () => {
    const applier = new SchemaExtensionApplier()
    const ext = {
      columns: [
        {
          table: 'trageti_assertions' as const,
          column: 'my_flag',
          definition: 'INTEGER DEFAULT 0',
        },
      ],
    }
    applier.apply(db, ext)
    applier.apply(db, ext)
    const cols = db.prepare(`PRAGMA table_info(trageti_assertions)`).all() as Array<{
      name: string
    }>
    expect(cols.filter((c) => c.name === 'my_flag').length).toBe(1)
  })

  it('creates extension tables', async () => {
    const applier = new SchemaExtensionApplier()
    applier.apply(db, {
      tables: [
        {
          tableName: 'app_approvals',
          createSQL: 'CREATE TABLE IF NOT EXISTS app_approvals (id TEXT PRIMARY KEY)',
          referencesNamespace: false,
        },
      ],
    })
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='app_approvals'`)
      .all() as Array<{ name: string }>
    expect(tables.length).toBe(1)
  })

  it('rejects referencesNamespace table without namespaceColumn', async () => {
    const applier = new SchemaExtensionApplier()
    expect(() =>
      applier.validate({
        tables: [
          {
            tableName: 'app_bad_refs',
            createSQL: 'CREATE TABLE IF NOT EXISTS app_bad_refs (id TEXT PRIMARY KEY)',
            referencesNamespace: true,
          },
        ],
      }),
    ).toThrow(SchemaExtensionError)
  })

  it('validates namespaceColumn exists after createSQL runs', async () => {
    const applier = new SchemaExtensionApplier()
    expect(() =>
      applier.apply(db, {
        tables: [
          {
            tableName: 'app_bad_refs',
            createSQL:
              'CREATE TABLE IF NOT EXISTS app_bad_refs (id TEXT PRIMARY KEY, namespace TEXT)',
            referencesNamespace: true,
            namespaceColumn: 'ns',
          },
        ],
      }),
    ).toThrow(SchemaExtensionError)
  })
})

describe('SchemaExtensionApplier.getExtensionColumns', () => {
  let db: Database

  beforeEach(async () => {
    db = openTestDb()
    setupDb(db)
  })

  it('returns empty array when no extensions added', async () => {
    const applier = new SchemaExtensionApplier()
    expect(applier.getExtensionColumns(db, 'trageti_assertions')).toEqual([])
  })

  it('returns added extension columns', async () => {
    const applier = new SchemaExtensionApplier()
    applier.apply(db, {
      columns: [{ table: 'trageti_assertions', column: 'approval_status', definition: 'TEXT' }],
    })
    expect(applier.getExtensionColumns(db, 'trageti_assertions')).toContain('approval_status')
  })

  it('does not include library columns', async () => {
    const applier = new SchemaExtensionApplier()
    const cols = applier.getExtensionColumns(db, 'trageti_assertions')
    expect(cols).not.toContain('content')
    expect(cols).not.toContain('id')
    expect(cols).not.toContain('namespace')
  })
})
