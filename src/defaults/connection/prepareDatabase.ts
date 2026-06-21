import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { createRequire } from 'node:module';
import type { PrepareDatabaseOptions, BetterSqlite3Options } from '../../domain/types.js';
import { MissingPeerDependencyError, ValidationError } from '../../errors/index.js';

// Re-exported from its canonical home in domain/types.ts for back-compat.
export type { BetterSqlite3Options };

const require = createRequire(import.meta.url);
const SAFE_PRAGMA_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_PRAGMA_VALUE = /^[A-Za-z0-9_./:-]+$/;

function validatePragma(key: string, value: string | number): void {
  const errors: string[] = [];
  if (!SAFE_PRAGMA_KEY.test(key)) {
    errors.push(`PRAGMA key "${key}" is not a safe SQLite identifier`);
  }
  if (key.toLowerCase() === 'foreign_keys') {
    errors.push('prepareDatabase pragmas may not override foreign_keys');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push(`PRAGMA "${key}" value must be finite`);
  } else if (!SAFE_PRAGMA_VALUE.test(value)) {
    errors.push(`PRAGMA "${key}" value contains unsafe characters`);
  }
  if (errors.length > 0) throw new ValidationError(errors, 'PrepareDatabase');
}

export function prepareDatabase(source: string | DatabaseType, options: PrepareDatabaseOptions = {}): DatabaseType {
  const db = typeof source === 'string' ? new Database(source, options.betterSqlite3) : source;

  db.pragma(`journal_mode = ${options.journalMode ?? 'WAL'}`);
  db.pragma(`busy_timeout = ${String(options.busyTimeoutMs ?? 5000)}`);
  db.pragma(`temp_store = ${options.tempStore ?? 'MEMORY'}`);
  db.pragma('foreign_keys = ON');

  for (const [key, value] of Object.entries(options.pragmas ?? {})) {
    validatePragma(key, value);
    db.pragma(`${key} = ${String(value)}`);
  }

  if (options.loadSqliteVec ?? true) {
    try {
      const sqliteVec = require('sqlite-vec') as { load(db: DatabaseType): void };
      sqliteVec.load(db);
    } catch {
      throw new MissingPeerDependencyError(
        'sqlite-vec',
        'npm install sqlite-vec',
        'set loadSqliteVec: false and use vectorless namespaces or load the extension manually',
      );
    }
  }

  return db;
}
