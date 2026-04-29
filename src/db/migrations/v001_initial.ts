import type { Database } from 'better-sqlite3'
import type { Migration, FTS5TokenizerConfig } from '../../domain/types.js'

const DEFAULT_TOKENIZER: FTS5TokenizerConfig = {
  tokenizer: 'unicode61',
  tokenizerArgs: ['remove_diacritics', '1'],
}

function buildTokenizeArg(cfg: FTS5TokenizerConfig): string {
  const parts = [cfg.tokenizer, ...(cfg.tokenizerArgs ?? [])]
  return parts.join(' ')
}

export function createV001Migration(tokenizerConfig?: FTS5TokenizerConfig): Migration {
  const tokenize = buildTokenizeArg(tokenizerConfig ?? DEFAULT_TOKENIZER)

  return {
    version: 1,
    description: 'Initial schema: namespaces, episodes, assertions, links, FTS5, indexes',
    up(db: Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS trl_namespaces (
          namespace           TEXT PRIMARY KEY,
          embedding_dimension INTEGER NOT NULL,
          embedding_table     TEXT NOT NULL,
          created_at          TEXT NOT NULL DEFAULT (datetime('now')),
          config              TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS trl_episodes (
          id           TEXT PRIMARY KEY,
          namespace    TEXT NOT NULL REFERENCES trl_namespaces(namespace),
          position     REAL NOT NULL,
          occurred_at  TEXT NOT NULL,
          type         TEXT NOT NULL,
          content      TEXT NOT NULL,
          created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS trl_assertions (
          id                TEXT PRIMARY KEY,
          namespace         TEXT NOT NULL REFERENCES trl_namespaces(namespace),
          type              TEXT NOT NULL,
          content           TEXT NOT NULL,
          valid_from        REAL NOT NULL,
          valid_until       REAL,
          confidence        REAL NOT NULL DEFAULT 1.0
            CHECK (confidence >= 0.0 AND confidence <= 1.0),
          source_episode_id TEXT NOT NULL REFERENCES trl_episodes(id),
          supersedes_id     TEXT REFERENCES trl_assertions(id),
          entity_id         TEXT,
          entity_type       TEXT,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (valid_until IS NULL OR valid_until > valid_from)
        );

        CREATE TABLE IF NOT EXISTS trl_links (
          id                TEXT PRIMARY KEY,
          namespace         TEXT NOT NULL REFERENCES trl_namespaces(namespace),
          from_id           TEXT NOT NULL REFERENCES trl_assertions(id),
          to_id             TEXT NOT NULL REFERENCES trl_assertions(id),
          link_type         TEXT NOT NULL,
          valid_from        REAL NOT NULL,
          valid_until       REAL,
          source_episode_id TEXT NOT NULL REFERENCES trl_episodes(id),
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (valid_until IS NULL OR valid_until > valid_from)
        );

        CREATE INDEX IF NOT EXISTS trl_idx_assertions_ns_pos
          ON trl_assertions(namespace, valid_from, valid_until);
        CREATE INDEX IF NOT EXISTS trl_idx_assertions_entity
          ON trl_assertions(namespace, entity_id, entity_type);
        CREATE INDEX IF NOT EXISTS trl_idx_assertions_episode
          ON trl_assertions(source_episode_id);
        CREATE INDEX IF NOT EXISTS trl_idx_links_from
          ON trl_links(namespace, from_id, valid_until);
        CREATE INDEX IF NOT EXISTS trl_idx_links_to
          ON trl_links(namespace, to_id, valid_until);
        CREATE INDEX IF NOT EXISTS trl_idx_episodes_ns_pos
          ON trl_episodes(namespace, position);
      `)

      // FTS5 external-content table
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS trl_fts USING fts5(
          assertion_id UNINDEXED,
          content,
          content='trl_assertions',
          content_rowid='rowid',
          tokenize='${tokenize}'
        );
      `)

      // FTS5 sync triggers — required for external-content tables
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trl_fts_ai
          AFTER INSERT ON trl_assertions BEGIN
            INSERT INTO trl_fts(rowid, assertion_id, content)
            VALUES (new.rowid, new.id, new.content);
          END;

        CREATE TRIGGER IF NOT EXISTS trl_fts_ad
          AFTER DELETE ON trl_assertions BEGIN
            INSERT INTO trl_fts(trl_fts, rowid, assertion_id, content)
            VALUES ('delete', old.rowid, old.id, old.content);
          END;

        CREATE TRIGGER IF NOT EXISTS trl_fts_au
          AFTER UPDATE OF content ON trl_assertions BEGIN
            INSERT INTO trl_fts(trl_fts, rowid, assertion_id, content)
            VALUES ('delete', old.rowid, old.id, old.content);
            INSERT INTO trl_fts(rowid, assertion_id, content)
            VALUES (new.rowid, new.id, new.content);
          END;
      `)
    },
  }
}
