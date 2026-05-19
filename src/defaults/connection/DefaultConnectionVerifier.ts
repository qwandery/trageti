import type { Database } from 'better-sqlite3'
import type { ConnectionVerifier } from '../../domain/types.js'
import { structuredWarn } from '../../internal/logger.js'

export class DefaultConnectionVerifier implements ConnectionVerifier {
  verify(db: Database): void {
    // sqlite-vec is optional at init time in v0.3; vector paths check it at the
    // vector-readiness chokepoint.
    try {
      db.prepare('SELECT vec_version()').get()
    } catch {
      structuredWarn('SQLITE_VEC_NOT_LOADED', {})
    }

    // WAL mode is strongly recommended but not enforced
    const journalMode = (db.pragma('journal_mode', { simple: true }) as string | undefined) ?? ''
    if (journalMode.toLowerCase() !== 'wal') {
      structuredWarn('NON_WAL_MODE', { journalMode })
    }

    // Foreign keys should be enabled; warn if not
    const fk = db.pragma('foreign_keys', { simple: true }) as number | undefined
    if (!fk) {
      structuredWarn('FOREIGN_KEYS_DISABLED', { foreignKeys: 0 })
    }
  }
}
