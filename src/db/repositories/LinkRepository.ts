import type { Database } from 'better-sqlite3';
import type { AssertionLink, NewAssertionLinkInput } from '../../domain/types.js';
import { ErrorCode, TragetiError, ValidationError } from '../../errors/index.js';
import { buildCandidateJson } from '../candidates.js';

interface LinkRow {
  id: string;
  namespace: string;
  from_id: string;
  to_id: string;
  link_type: string;
  valid_from: number;
  valid_until: number | null;
  source_episode_id: string;
  created_at: string;
  [key: string]: unknown;
}

function rowToLink(row: LinkRow, extensionColumns: readonly string[] = []): AssertionLink {
  const extensions: Record<string, unknown> = {};
  for (const col of extensionColumns) {
    extensions[col] = row[col] ?? null;
  }
  return {
    id: row.id,
    namespace: row.namespace,
    fromId: row.from_id,
    toId: row.to_id,
    linkType: row.link_type,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    sourceEpisodeId: row.source_episode_id,
    createdAt: row.created_at,
    extensions,
  };
}

export class LinkRepository {
  private readonly db: Database;
  private readonly extensionColumns: readonly string[];

  constructor(db: Database, extensionColumns: readonly string[] = []) {
    this.db = db;
    this.extensionColumns = extensionColumns;
  }

  insert(link: NewAssertionLinkInput): AssertionLink {
    try {
      this.db
        .prepare(
          `INSERT INTO trageti_links (id, namespace, from_id, to_id, link_type, valid_from, valid_until, source_episode_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          link.id,
          link.namespace,
          link.fromId,
          link.toId,
          link.linkType,
          link.validFrom,
          link.validUntil ?? null,
          link.sourceEpisodeId,
          new Date().toISOString(),
        );
    } catch (err) {
      if (isSqliteConstraint(err)) {
        throw new ValidationError([`Link ID "${link.id}" already exists`], 'Link');
      }
      throw err;
    }
    const row = this.db.prepare<[string], LinkRow>('SELECT * FROM trageti_links WHERE id = ?').get(link.id);
    if (!row) {
      throw new TragetiError(ErrorCode.INTERNAL_INVARIANT, `Link "${link.id}" not found after insert`);
    }
    return rowToLink(row, this.extensionColumns);
  }

  getByIds(ids: readonly string[]): AssertionLink[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare<[string], LinkRow>('SELECT * FROM trageti_links WHERE id IN (SELECT value FROM json_each(?))')
      .all(buildCandidateJson(ids));
    const byId = new Map(rows.map((row) => [row.id, rowToLink(row, this.extensionColumns)]));
    return ids.flatMap((id) => {
      const link = byId.get(id);
      return link ? [link] : [];
    });
  }

  getCount(namespace: string): number {
    const row = this.db
      .prepare<[string], { cnt: number }>('SELECT COUNT(*) AS cnt FROM trageti_links WHERE namespace = ?')
      .get(namespace);
    return row?.cnt ?? 0;
  }
}

function isSqliteConstraint(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    typeof err.code === 'string' &&
    err.code.startsWith('SQLITE_CONSTRAINT')
  );
}
