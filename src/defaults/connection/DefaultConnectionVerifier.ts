import type { Database } from 'better-sqlite3';
import type { ConnectionVerifier } from '../../domain/types.js';
import type { Logger } from '../../internal/logger.js';
import { getDefaultLogger } from '../../internal/logger.js';
import { ConnectionVerificationError } from '../../errors/index.js';

/**
 * Default connection verifier.
 *
 * v0.3 (BREAKING): foreign keys are enforced. The verifier enables
 * `PRAGMA foreign_keys = ON`, re-reads it, and **fails closed** with a
 * `ConnectionVerificationError` if enforcement cannot be turned on (e.g. the
 * connection has an open transaction, or the SQLite build omits FK support).
 * On success it emits `TRGT_FOREIGN_KEYS_ENABLED` at debug.
 *
 * It does NOT check for `sqlite-vec`: v0.3 makes the extension optional and
 * supports BM25-only operation without it. sqlite-vec absence is surfaced
 * elsewhere — `prepareDatabase()` when loading was requested, the
 * `ensureVectorReady` chokepoint on vector paths, and `TRGT_RETRIEVE_VECTOR_SKIPPED`
 * on hybrid fallback.
 */
export class DefaultConnectionVerifier implements ConnectionVerifier {
  verify(db: Database, logger?: Logger): void {
    const log = logger ?? getDefaultLogger();

    // Foreign keys — enforce, re-check, fail closed.
    db.pragma('foreign_keys = ON');
    const fk = db.pragma('foreign_keys', { simple: true }) as number | undefined;
    if (fk !== 1) {
      throw new ConnectionVerificationError(
        'Foreign-key enforcement could not be enabled (PRAGMA foreign_keys = ON did not take). ' +
          'This usually means the connection has an open transaction, or the SQLite build omits ' +
          'foreign-key support. Provide a custom ConnectionVerifier only if you accept full ' +
          'responsibility for referential integrity.',
      );
    }
    log.debug('TRGT_FOREIGN_KEYS_ENABLED', {});

    // WAL mode is strongly recommended but not enforced.
    const journalMode = (db.pragma('journal_mode', { simple: true }) as string | undefined) ?? '';
    if (journalMode.toLowerCase() !== 'wal') {
      log.warn('TRGT_NON_WAL_MODE', { journalMode });
    }
  }
}
