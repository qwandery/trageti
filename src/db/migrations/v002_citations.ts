import type { Database } from 'better-sqlite3'
import type { Migration } from '../../domain/types.js'

export function createV002Migration(): Migration {
  return {
    version: 2,
    description: 'Citations table + reverse-supersession index',
    up(db: Database): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS trl_citations (
          id              TEXT PRIMARY KEY,
          assertion_id    TEXT NOT NULL REFERENCES trl_assertions(id),
          episode_id      TEXT NOT NULL REFERENCES trl_episodes(id),
          source_ref      TEXT NOT NULL,
          excerpt         TEXT,
          excerpt_start   TEXT,
          excerpt_end     TEXT,
          metadata        TEXT,
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS trl_idx_citations_assertion
          ON trl_citations(assertion_id);

        -- Reverse-supersession lookup: "what replaced X?"
        -- supersedes_id is strictly new -> old (decision §1); without this index,
        -- finding the successor of a known assertion would require scanning the
        -- whole namespace.
        CREATE INDEX IF NOT EXISTS trl_idx_assertions_supersedes
          ON trl_assertions(namespace, supersedes_id);
      `)
    },
  }
}
