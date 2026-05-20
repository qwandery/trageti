import type { Database } from 'better-sqlite3'
import type { Migration } from '../../domain/types.js'
import { quoteIdent } from '../../internal/sql-ident.js'

const OLD_EMBEDDING_PREFIX = 'trl_embeddings_'
const NEW_EMBEDDING_PREFIX = 'trageti_embeddings_'

interface NamespaceRow {
  namespace: string
  embedding_dimension: number | null
  embedding_table: string | null
}

/** True when sqlite-vec's `vec_version()` function is callable. */
function sqliteVecLoaded(db: Database): boolean {
  try {
    db.prepare('SELECT vec_version() AS v').get()
    return true
  } catch {
    return false
  }
}

/**
 * v005: rename every library table from the legacy `trl_` prefix to the
 * `trageti_` prefix (v0.3 Specification Amendment, table-naming overhaul).
 *
 * FK-toggle migration: the core-table renames rely on FK enforcement being
 * disabled while child references are rewritten. Modern SQLite rewrites FK
 * references on `ALTER TABLE … RENAME`; the runner's `foreign_key_check`
 * confirms the result.
 *
 * The schema-version table (`trl_schema_version` → `trageti_schema_version`)
 * is intentionally NOT renamed here — the runner reads and writes that table
 * to drive migration itself, so it is renamed by the runner's own
 * self-migration, not by a migration body.
 *
 * Embedding vec0 tables are renamed eagerly and best-effort: the rename needs
 * `sqlite-vec` loaded to copy vec0 rows, and a BM25-only process may run this
 * migration without it. When the extension is absent the legacy embedding
 * table is left in place and `embedding_table` keeps pointing at it.
 */
export function createV005Migration(): Migration {
  return {
    version: 5,
    name: 'v005_rename',
    description: 'Rename all library tables from the trl_ prefix to trageti_',
    requiresForeignKeyToggle: true,
    up(db: Database): void {
      // 1. Core tables. Modern SQLite rewrites FK references on rename.
      db.exec(`
        ALTER TABLE trl_namespaces RENAME TO trageti_namespaces;
        ALTER TABLE trl_episodes   RENAME TO trageti_episodes;
        ALTER TABLE trl_assertions RENAME TO trageti_assertions;
        ALTER TABLE trl_links      RENAME TO trageti_links;
        ALTER TABLE trl_citations  RENAME TO trageti_citations;
      `)

      // 2. Read the active tokenizer config (v003 created trl_fts_meta).
      const meta = db
        .prepare<
          [],
          { tokenizer: string; tokenizer_args: string }
        >('SELECT tokenizer, tokenizer_args FROM trl_fts_meta WHERE id = 1')
        .get()
      const tokenizer = meta?.tokenizer ?? 'unicode61'
      const tokenizerArgs = meta ? (JSON.parse(meta.tokenizer_args) as string[]) : []
      const tokenize = [tokenizer, ...tokenizerArgs].join(' ')

      // 3. Drop the old FTS5 table + sync triggers.
      db.exec(`
        DROP TRIGGER IF EXISTS trl_fts_ai;
        DROP TRIGGER IF EXISTS trl_fts_ad;
        DROP TRIGGER IF EXISTS trl_fts_au;
        DROP TABLE IF EXISTS trl_fts;
      `)

      // 4. Recreate the FTS5 table + triggers under the trageti_ names,
      //    preserving the tokenizer read in step 2.
      db.exec(`
        CREATE VIRTUAL TABLE trageti_fulltext USING fts5(
          assertion_id UNINDEXED,
          content,
          content='trageti_assertions',
          content_rowid='rowid',
          tokenize='${tokenize}'
        );
      `)
      db.exec(`
        CREATE TRIGGER trageti_fulltext_ai
          AFTER INSERT ON trageti_assertions BEGIN
            INSERT INTO trageti_fulltext(rowid, assertion_id, content)
            VALUES (new.rowid, new.id, new.content);
          END;

        CREATE TRIGGER trageti_fulltext_ad
          AFTER DELETE ON trageti_assertions BEGIN
            INSERT INTO trageti_fulltext(trageti_fulltext, rowid, assertion_id, content)
            VALUES ('delete', old.rowid, old.id, old.content);
          END;

        CREATE TRIGGER trageti_fulltext_au
          AFTER UPDATE OF content ON trageti_assertions BEGIN
            INSERT INTO trageti_fulltext(trageti_fulltext, rowid, assertion_id, content)
            VALUES ('delete', old.rowid, old.id, old.content);
            INSERT INTO trageti_fulltext(rowid, assertion_id, content)
            VALUES (new.rowid, new.id, new.content);
          END;
      `)

      // 5. Repopulate the FTS index, preserving the rowid invariant
      //    (trageti_fulltext.rowid === trageti_assertions.rowid).
      db.exec(`
        INSERT INTO trageti_fulltext(rowid, assertion_id, content)
          SELECT rowid, id, content FROM trageti_assertions;
      `)

      // 6. Indexes: drop the trl_idx_* set, recreate as trageti_idx_*.
      const oldIndexes = db
        .prepare<
          [],
          { name: string }
        >("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'trl_idx_%'")
        .all()
      for (const idx of oldIndexes) {
        db.exec(`DROP INDEX IF EXISTS ${quoteIdent(idx.name)}`)
      }
      db.exec(`
        CREATE INDEX trageti_idx_assertions_ns_pos
          ON trageti_assertions(namespace, valid_from, valid_until);
        CREATE INDEX trageti_idx_assertions_entity
          ON trageti_assertions(namespace, entity_id, entity_type);
        CREATE INDEX trageti_idx_assertions_episode
          ON trageti_assertions(source_episode_id);
        CREATE INDEX trageti_idx_links_from
          ON trageti_links(namespace, from_id, valid_until);
        CREATE INDEX trageti_idx_links_to
          ON trageti_links(namespace, to_id, valid_until);
        CREATE INDEX trageti_idx_episodes_ns_pos
          ON trageti_episodes(namespace, position);
        CREATE INDEX trageti_idx_citations_assertion
          ON trageti_citations(assertion_id);
        CREATE INDEX trageti_idx_assertions_supersedes
          ON trageti_assertions(namespace, supersedes_id);
      `)

      // 7. Tokenizer-metadata table.
      db.exec('ALTER TABLE trl_fts_meta RENAME TO trageti_tokenizer;')

      // 8. Embedding vec0 tables — eager, best-effort.
      const vecLoaded = sqliteVecLoaded(db)
      const namespaces = db
        .prepare<
          [],
          NamespaceRow
        >('SELECT namespace, embedding_dimension, embedding_table FROM trageti_namespaces')
        .all()
      const repoint = db.prepare(
        'UPDATE trageti_namespaces SET embedding_table = ? WHERE namespace = ?',
      )
      for (const ns of namespaces) {
        const oldTable = ns.embedding_table
        if (!oldTable || !oldTable.startsWith(OLD_EMBEDDING_PREFIX)) continue
        const newTable = NEW_EMBEDDING_PREFIX + oldTable.slice(OLD_EMBEDDING_PREFIX.length)
        const physical = db
          .prepare<
            [string],
            { name: string }
          >("SELECT name FROM sqlite_master WHERE name = ? AND type = 'table'")
          .get(oldTable)
        if (!physical) {
          // The vec0 table was never lazily created — repoint only.
          repoint.run(newTable, ns.namespace)
          continue
        }
        if (!vecLoaded || ns.embedding_dimension === null) {
          // A vec0 table cannot be copied without sqlite-vec loaded; leave the
          // legacy table inert and keep embedding_table pointing at it.
          continue
        }
        db.exec(
          `CREATE VIRTUAL TABLE ${quoteIdent(newTable)} USING vec0(assertion_id TEXT PRIMARY KEY, embedding FLOAT[${String(ns.embedding_dimension)}])`,
        )
        db.exec(
          `INSERT INTO ${quoteIdent(newTable)} (assertion_id, embedding) SELECT assertion_id, embedding FROM ${quoteIdent(oldTable)}`,
        )
        repoint.run(newTable, ns.namespace)
        db.exec(`DROP TABLE ${quoteIdent(oldTable)}`)
      }
    },
  }
}
