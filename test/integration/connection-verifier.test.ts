import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { DefaultConnectionVerifier } from '../../src/defaults/connection/DefaultConnectionVerifier.js'

describe('DefaultConnectionVerifier', () => {
  it('does NOT throw when sqlite-vec is not loaded (vectorless mode is now supported in v0.3)', async () => {
    const db = new Database(':memory:')
    // Intentionally do NOT load sqlite-vec
    const verifier = new DefaultConnectionVerifier()
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(() => verifier.verify(db)).not.toThrow()
      const calls = writeSpy.mock.calls.map((args) => String(args[0]))
      const warned = calls.some((s) => s.includes('TRGT_SQLITE_VEC_NOT_LOADED'))
      expect(warned).toBe(true)
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('passes when sqlite-vec is loaded and WAL+FK are set', async () => {
    const db = new Database(':memory:')
    sqliteVec.load(db)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    const verifier = new DefaultConnectionVerifier()
    expect(() => verifier.verify(db)).not.toThrow()
  })

  it('passes (with warnings) when WAL is not set', async () => {
    const db = new Database(':memory:')
    sqliteVec.load(db)
    // :memory: uses 'memory' journal mode by default — triggers warn but should not throw
    db.pragma('foreign_keys = ON')
    const verifier = new DefaultConnectionVerifier()
    expect(() => verifier.verify(db)).not.toThrow()
  })

  it('passes (with warnings) when foreign_keys are disabled', async () => {
    const db = new Database(':memory:')
    sqliteVec.load(db)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = OFF')
    const verifier = new DefaultConnectionVerifier()
    expect(() => verifier.verify(db)).not.toThrow()
  })
})
