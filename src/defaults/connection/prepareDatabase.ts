import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import { createRequire } from 'node:module'
import type { PrepareDatabaseOptions } from '../../domain/types.js'
import { MissingPeerDependencyError } from '../../errors/index.js'

export type BetterSqlite3Options = Database.Options

const require = createRequire(import.meta.url)

export function prepareDatabase(
  source: string | DatabaseType,
  options: PrepareDatabaseOptions = {},
): DatabaseType {
  const db = typeof source === 'string' ? new Database(source, options.betterSqlite3) : source

  db.pragma(`journal_mode = ${options.journalMode ?? 'WAL'}`)
  db.pragma(`busy_timeout = ${String(options.busyTimeoutMs ?? 5000)}`)
  db.pragma(`temp_store = ${options.tempStore ?? 'MEMORY'}`)
  db.pragma('foreign_keys = ON')

  for (const [key, value] of Object.entries(options.pragmas ?? {})) {
    db.pragma(`${key} = ${String(value)}`)
  }

  if (options.loadSqliteVec ?? true) {
    try {
      const sqliteVec = require('sqlite-vec') as { load(db: DatabaseType): void }
      sqliteVec.load(db)
    } catch {
      throw new MissingPeerDependencyError(
        'sqlite-vec',
        'npm install sqlite-vec',
        'set loadSqliteVec: false and use vectorless namespaces or load the extension manually',
      )
    }
  }

  return db
}
