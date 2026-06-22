import type { Database } from 'better-sqlite3';
import type { FTS5TokenizerConfig, Migration } from '../../domain/types.js';
import { validateTokenizer } from '../../internal/tokenizer.js';

const DEFAULT_TOKENIZER: FTS5TokenizerConfig = {
  tokenizer: 'unicode61',
  tokenizerArgs: ['remove_diacritics', '1'],
};

function buildTokenizeArg(cfg: FTS5TokenizerConfig): string {
  validateTokenizer(cfg, 'init');
  return [cfg.tokenizer, ...(cfg.tokenizerArgs ?? [])].join(' ');
}

export function createV001BaselineMigration(tokenizerConfig?: FTS5TokenizerConfig): Migration {
  const tokenizer = tokenizerConfig ?? DEFAULT_TOKENIZER;
  const tokenize = buildTokenizeArg(tokenizer);

  return {
    version: 1,
    name: 'v001_baseline',
    description: 'Baseline v0.3 schema',
    requiresForeignKeyToggle: false,
    up(db: Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS trageti_namespaces (
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

        CREATE TABLE IF NOT EXISTS trageti_episodes (
          id           TEXT PRIMARY KEY,
          namespace    TEXT NOT NULL REFERENCES trageti_namespaces(namespace),
          position     REAL NOT NULL,
          occurred_at  TEXT NOT NULL,
          type         TEXT NOT NULL,
          content      TEXT NOT NULL,
          created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS trageti_assertions (
          id                TEXT PRIMARY KEY,
          namespace         TEXT NOT NULL REFERENCES trageti_namespaces(namespace),
          type              TEXT NOT NULL,
          content           TEXT NOT NULL,
          valid_from        REAL NOT NULL,
          valid_until       REAL,
          confidence        REAL NOT NULL DEFAULT 1.0
            CHECK (confidence >= 0.0 AND confidence <= 1.0),
          source_episode_id TEXT NOT NULL REFERENCES trageti_episodes(id),
          supersedes_id     TEXT REFERENCES trageti_assertions(id),
          entity_id         TEXT,
          entity_type       TEXT,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (valid_until IS NULL OR valid_until > valid_from)
        );

        CREATE TABLE IF NOT EXISTS trageti_links (
          id                TEXT PRIMARY KEY,
          namespace         TEXT NOT NULL REFERENCES trageti_namespaces(namespace),
          from_id           TEXT NOT NULL REFERENCES trageti_assertions(id),
          to_id             TEXT NOT NULL REFERENCES trageti_assertions(id),
          link_type         TEXT NOT NULL,
          valid_from        REAL NOT NULL,
          valid_until       REAL,
          source_episode_id TEXT NOT NULL REFERENCES trageti_episodes(id),
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (valid_until IS NULL OR valid_until > valid_from)
        );

        CREATE TABLE IF NOT EXISTS trageti_citations (
          id              TEXT PRIMARY KEY,
          assertion_id    TEXT NOT NULL REFERENCES trageti_assertions(id),
          episode_id      TEXT NOT NULL REFERENCES trageti_episodes(id),
          source_ref      TEXT NOT NULL,
          excerpt         TEXT,
          excerpt_start   TEXT,
          excerpt_end     TEXT,
          metadata        TEXT,
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS trageti_tokenizer (
          id              INTEGER PRIMARY KEY CHECK (id = 1),
          tokenizer       TEXT NOT NULL,
          tokenizer_args  TEXT NOT NULL DEFAULT '[]',
          updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS trageti_idx_assertions_ns_pos
          ON trageti_assertions(namespace, valid_from, valid_until);
        CREATE INDEX IF NOT EXISTS trageti_idx_assertions_entity
          ON trageti_assertions(namespace, entity_id, entity_type);
        CREATE INDEX IF NOT EXISTS trageti_idx_assertions_episode
          ON trageti_assertions(source_episode_id);
        CREATE INDEX IF NOT EXISTS trageti_idx_assertions_supersedes
          ON trageti_assertions(namespace, supersedes_id);
        CREATE INDEX IF NOT EXISTS trageti_idx_links_from
          ON trageti_links(namespace, from_id, valid_until);
        CREATE INDEX IF NOT EXISTS trageti_idx_links_to
          ON trageti_links(namespace, to_id, valid_until);
        CREATE INDEX IF NOT EXISTS trageti_idx_episodes_ns_pos
          ON trageti_episodes(namespace, position);
        CREATE INDEX IF NOT EXISTS trageti_idx_citations_assertion
          ON trageti_citations(assertion_id);
      `);

      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS trageti_fulltext USING fts5(
          assertion_id UNINDEXED,
          content,
          content='trageti_assertions',
          content_rowid='rowid',
          tokenize='${tokenize}'
        );
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trageti_fulltext_ai
          AFTER INSERT ON trageti_assertions BEGIN
            INSERT INTO trageti_fulltext(rowid, assertion_id, content)
            VALUES (new.rowid, new.id, new.content);
          END;

        CREATE TRIGGER IF NOT EXISTS trageti_fulltext_ad
          AFTER DELETE ON trageti_assertions BEGIN
            INSERT INTO trageti_fulltext(trageti_fulltext, rowid, assertion_id, content)
            VALUES ('delete', old.rowid, old.id, old.content);
          END;

        CREATE TRIGGER IF NOT EXISTS trageti_fulltext_au
          AFTER UPDATE OF content ON trageti_assertions BEGIN
            INSERT INTO trageti_fulltext(trageti_fulltext, rowid, assertion_id, content)
            VALUES ('delete', old.rowid, old.id, old.content);
            INSERT INTO trageti_fulltext(rowid, assertion_id, content)
            VALUES (new.rowid, new.id, new.content);
          END;
      `);

      db.prepare(
        `INSERT INTO trageti_tokenizer (id, tokenizer, tokenizer_args)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET tokenizer = excluded.tokenizer,
                                       tokenizer_args = excluded.tokenizer_args`,
      ).run(tokenizer.tokenizer, JSON.stringify(tokenizer.tokenizerArgs ?? []));
    },
  };
}
