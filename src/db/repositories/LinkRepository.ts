import type { Database } from 'better-sqlite3'
import type { AssertionLink } from '../../domain/types.js'

interface LinkRow {
  id: string
  namespace: string
  from_id: string
  to_id: string
  link_type: string
  valid_from: number
  valid_until: number | null
  source_episode_id: string
  created_at: string
}

function rowToLink(row: LinkRow): AssertionLink {
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
  }
}

export class LinkRepository {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  insert(link: Omit<AssertionLink, 'createdAt'>): AssertionLink {
    this.db
      .prepare(
        `INSERT INTO trl_links (id, namespace, from_id, to_id, link_type, valid_from, valid_until, source_episode_id, created_at)
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
      )
    const row = this.db
      .prepare<[string], LinkRow>('SELECT * FROM trl_links WHERE id = ?')
      .get(link.id)
    if (!row) throw new Error(`Link "${link.id}" not found after insert`)
    return rowToLink(row)
  }

  getCount(namespace: string): number {
    const row = this.db
      .prepare<
        [string],
        { cnt: number }
      >('SELECT COUNT(*) AS cnt FROM trl_links WHERE namespace = ?')
      .get(namespace)
    return row?.cnt ?? 0
  }
}
