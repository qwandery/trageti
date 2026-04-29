import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { DefaultConnectionVerifier } from '../../src/defaults/connection/DefaultConnectionVerifier.js'
import { ConnectionVerificationError } from '../../src/errors/index.js'

describe('DefaultConnectionVerifier', () => {
  it('throws when sqlite-vec is not loaded', () => {
    const db = new Database(':memory:')
    // Intentionally do NOT load sqlite-vec
    const verifier = new DefaultConnectionVerifier()
    expect(() => verifier.verify(db)).toThrow(ConnectionVerificationError)
  })

  it('passes when sqlite-vec is loaded and WAL+FK are set', () => {
    const db = new Database(':memory:')
    sqliteVec.load(db)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    const verifier = new DefaultConnectionVerifier()
    expect(() => verifier.verify(db)).not.toThrow()
  })

  it('passes (with warnings) when WAL is not set', () => {
    const db = new Database(':memory:')
    sqliteVec.load(db)
    // :memory: uses 'memory' journal mode by default — triggers warn but should not throw
    db.pragma('foreign_keys = ON')
    const verifier = new DefaultConnectionVerifier()
    expect(() => verifier.verify(db)).not.toThrow()
  })

  it('passes (with warnings) when foreign_keys are disabled', () => {
    const db = new Database(':memory:')
    sqliteVec.load(db)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = OFF')
    const verifier = new DefaultConnectionVerifier()
    expect(() => verifier.verify(db)).not.toThrow()
  })
})
