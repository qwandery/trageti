import { describe, it, expect } from 'vitest'
import { openTestDb } from '../helpers/openTestDb.js'
import { MigrationRunner } from '../../src/db/migrations/runner.js'
import { MigrationError } from '../../src/errors/index.js'

describe('MigrationRunner internals', () => {
  it('reports one baseline descriptor with a recorded applied timestamp', () => {
    const db = openTestDb()
    const runner = new MigrationRunner()
    runner.applyMigrations(db)

    const migrations = runner.getMigrations()
    const applied = runner.getAppliedVersions(db)

    expect(migrations).toHaveLength(1)
    expect(migrations[0]).toMatchObject({
      version: 1,
      name: 'v001_baseline',
      requiresForeignKeyToggle: false,
    })
    expect(applied.get(1)).toEqual(expect.any(String))
  })

  it('rolls back the baseline version row when baseline DDL fails', () => {
    const db = openTestDb()
    db.exec('CREATE TABLE trageti_tokenizer (id INTEGER PRIMARY KEY)')
    const runner = new MigrationRunner()

    expect(() => runner.applyMigrations(db)).toThrow(MigrationError)
    expect(runner.getCurrentVersion(db)).toBe(0)
  })
})
