import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { DefaultConnectionVerifier } from '../../src/defaults/connection/DefaultConnectionVerifier.js';
import { ConnectionVerificationError } from '../../src/errors/index.js';

describe('DefaultConnectionVerifier', () => {
  it('does NOT require sqlite-vec (vectorless mode is supported in v0.3) and is silent about it', async () => {
    const db = new Database(':memory:');
    // Intentionally do NOT load sqlite-vec.
    const verifier = new DefaultConnectionVerifier();
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => verifier.verify(db)).not.toThrow();
      const calls = writeSpy.mock.calls.map((args) => String(args[0]));
      // v0.3: the verifier emits no generic sqlite-vec warning.
      expect(calls.some((s) => s.includes('SQLITE_VEC'))).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('enables foreign keys and passes when WAL is set', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    const verifier = new DefaultConnectionVerifier();
    expect(() => verifier.verify(db)).not.toThrow();
    // The verifier turns FK enforcement ON.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('passes (with a WAL warning) when journal mode is not WAL', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    // :memory: uses 'memory' journal mode by default — triggers a warn, not a throw.
    const verifier = new DefaultConnectionVerifier();
    expect(() => verifier.verify(db)).not.toThrow();
  });

  it('fails closed when foreign-key enforcement cannot be enabled', async () => {
    // A connection where `PRAGMA foreign_keys` never reports enabled — e.g. a
    // SQLite build compiled without foreign-key support. Modelled with a thin
    // stub so the fail-closed path is exercised deterministically.
    const stub: Pick<Database.Database, 'pragma'> = {
      pragma(source: string, options?: { simple?: boolean }): unknown {
        if (source.startsWith('foreign_keys') && options?.simple) return 0;
        if (source.startsWith('journal_mode') && options?.simple) return 'wal';
        return undefined;
      },
    };
    const verifier = new DefaultConnectionVerifier();
    expect(() => verifier.verify(stub as unknown as Database.Database)).toThrow(ConnectionVerificationError);
  });
});
