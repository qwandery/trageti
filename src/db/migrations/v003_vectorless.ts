import type { Database } from 'better-sqlite3'
import type { Migration, FTS5TokenizerConfig } from '../../domain/types.js'
import { MigrationCompatibilityError } from '../../errors/index.js'

const DEFAULT_TOKENIZER: FTS5TokenizerConfig = {
  tokenizer: 'unicode61',
  tokenizerArgs: ['remove_diacritics', '1'],
}

/**
 * v003: vectorless namespace support + tokenizer metadata table.
 *
 * - Makes trl_namespaces.embedding_dimension / embedding_table nullable, with a
 *   both-null-or-both-non-null CHECK constraint so the schema cannot represent
 *   the impossible "dimension set but no table" state.
 * - Adds trl_fts_meta to record the currently-active FTS5 tokenizer
 *   (library-managed rather than parsed from sqlite_master).
 *
 * FK-toggle migration: rebuilds trl_namespaces so we must disable FK
 * enforcement while child FK references (trl_episodes.namespace,
 * trl_assertions.namespace, trl_links.namespace) point at the old table.
 */
export function createV003Migration(tokenizerConfig?: FTS5TokenizerConfig): Migration {
  const cfg = tokenizerConfig ?? DEFAULT_TOKENIZER
  return {
    version: 3,
    name: 'v003_vectorless',
    description:
      'Vectorless namespaces (nullable embedding_dimension/table) + trl_fts_meta metadata',
    requiresForeignKeyToggle: true,
    up(db: Database): void {
      // Rebuild trl_namespaces with nullable embedding columns and the
      // both-null-or-both-non-null CHECK. Explicit column lists guard against
      // future column-order drift in v001.
      db.exec(`
        CREATE TABLE trl_namespaces_v003 (
          namespace           TEXT PRIMARY KEY,
          embedding_dimension INTEGER,
          embedding_table     TEXT,
          created_at          TEXT NOT NULL DEFAULT (datetime('now')),
          config              TEXT NOT NULL DEFAULT '{}',
          CHECK (
            (embedding_dimension IS NULL AND embedding_table IS NULL)
            OR
            (embedding_dimension IS NOT NULL AND embedding_table IS NOT NULL)
          )
        );

        INSERT INTO trl_namespaces_v003 (namespace, embedding_dimension, embedding_table, created_at, config)
          SELECT namespace, embedding_dimension, embedding_table, created_at, config
            FROM trl_namespaces;

        DROP TABLE trl_namespaces;
        ALTER TABLE trl_namespaces_v003 RENAME TO trl_namespaces;
      `)

      // Tokenizer metadata. Single-row table, version-keyed so future tokenizer
      // changes via rebuildFts() can be observed without parsing DDL.
      db.exec(`
        CREATE TABLE IF NOT EXISTS trl_fts_meta (
          id              INTEGER PRIMARY KEY CHECK (id = 1),
          tokenizer       TEXT NOT NULL,
          tokenizer_args  TEXT NOT NULL DEFAULT '[]',
          updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)

      const existing = db
        .prepare<
          [],
          { tokenizer: string; tokenizer_args: string }
        >('SELECT tokenizer, tokenizer_args FROM trl_fts_meta WHERE id = 1')
        .get()
      if (existing) {
        const actual = JSON.stringify({
          tokenizer: existing.tokenizer,
          tokenizerArgs: JSON.parse(existing.tokenizer_args) as string[],
        })
        const expected = JSON.stringify({
          tokenizer: cfg.tokenizer,
          tokenizerArgs: cfg.tokenizerArgs ?? [],
        })
        if (actual !== expected) {
          throw new MigrationCompatibilityError(
            'fts-tokenizer',
            'Existing FTS tokenizer configuration is incompatible with the requested tokenizer.',
            {
              actual,
              expected,
            },
          )
        }
        return
      }

      // Seed the active tokenizer config so callers can read it back without
      // having to call rebuildFts() first.
      const args = JSON.stringify(cfg.tokenizerArgs ?? [])
      db.prepare(
        `INSERT INTO trl_fts_meta (id, tokenizer, tokenizer_args)
         VALUES (1, ?, ?)`,
      ).run(cfg.tokenizer, args)
    },
  }
}
