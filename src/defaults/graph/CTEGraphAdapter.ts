import type { Database } from 'better-sqlite3'
import type {
  GraphQueryAdapter,
  AssertionLink,
  TraversalOptions,
  PathOptions,
} from '../../domain/types.js'

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

/**
 * Default graph adapter using recursive CTEs.
 *
 * Performance note: CTE-based BFS may be slow on dense graphs or large namespaces.
 * For production use with large graphs, implement a custom GraphQueryAdapter backed
 * by a graph-native query engine.
 */
export class CTEGraphAdapter implements GraphQueryAdapter {
  findConnected(
    db: Database,
    namespace: string,
    fromIds: string[],
    options: TraversalOptions,
  ): AssertionLink[] {
    if (fromIds.length === 0) return []

    const { temporalAnchor, maxDepth, linkTypes } = options

    // Build the link type filter snippet
    const linkTypeFilter =
      linkTypes && linkTypes.length > 0
        ? `AND l.link_type IN (${linkTypes.map(() => '?').join(',')})`
        : ''

    const linkTypeParams = linkTypes ?? []

    // Recursive CTE BFS up to maxDepth hops
    const sql = `
      WITH RECURSIVE traversal(id, namespace, from_id, to_id, link_type,
                                valid_from, valid_until, source_episode_id, created_at,
                                depth) AS (
        SELECT l.id, l.namespace, l.from_id, l.to_id, l.link_type,
               l.valid_from, l.valid_until, l.source_episode_id, l.created_at,
               1 AS depth
        FROM trl_links l
        WHERE l.namespace = ?
          AND l.from_id IN (SELECT value FROM json_each(?))
          AND l.valid_from <= ?
          AND (l.valid_until IS NULL OR l.valid_until > ?)
          ${linkTypeFilter}

        UNION ALL

        SELECT l.id, l.namespace, l.from_id, l.to_id, l.link_type,
               l.valid_from, l.valid_until, l.source_episode_id, l.created_at,
               t.depth + 1
        FROM trl_links l
        JOIN traversal t ON l.from_id = t.to_id
        WHERE l.namespace = ?
          AND l.valid_from <= ?
          AND (l.valid_until IS NULL OR l.valid_until > ?)
          ${linkTypeFilter}
          AND t.depth < ?
      )
      SELECT DISTINCT id, namespace, from_id, to_id, link_type,
                      valid_from, valid_until, source_episode_id, created_at
      FROM traversal
    `

    const fromJson = JSON.stringify(fromIds)
    const params: unknown[] = [
      namespace,
      fromJson,
      temporalAnchor,
      temporalAnchor,
      ...linkTypeParams,
      namespace,
      temporalAnchor,
      temporalAnchor,
      ...linkTypeParams,
      maxDepth,
    ]

    const rows = db.prepare<unknown[], LinkRow>(sql).all(...params)
    return rows.map(rowToLink)
  }

  findPath(
    db: Database,
    namespace: string,
    fromId: string,
    toId: string,
    options: PathOptions,
  ): AssertionLink[] | null {
    const { temporalAnchor, maxDepth } = options

    // BFS via recursive CTE tracking the path
    const sql = `
      WITH RECURSIVE path_search(id, namespace, from_id, to_id, link_type,
                                  valid_from, valid_until, source_episode_id, created_at,
                                  depth, path_ids) AS (
        SELECT l.id, l.namespace, l.from_id, l.to_id, l.link_type,
               l.valid_from, l.valid_until, l.source_episode_id, l.created_at,
               1, json_array(l.id)
        FROM trl_links l
        WHERE l.namespace = ?
          AND l.from_id = ?
          AND l.valid_from <= ?
          AND (l.valid_until IS NULL OR l.valid_until > ?)

        UNION ALL

        SELECT l.id, l.namespace, l.from_id, l.to_id, l.link_type,
               l.valid_from, l.valid_until, l.source_episode_id, l.created_at,
               p.depth + 1, json_insert(p.path_ids, '$[#]', l.id)
        FROM trl_links l
        JOIN path_search p ON l.from_id = p.to_id
        WHERE l.namespace = ?
          AND l.valid_from <= ?
          AND (l.valid_until IS NULL OR l.valid_until > ?)
          AND p.depth < ?
          AND json_each.value IS NULL  -- cycle guard placeholder
      )
      SELECT id, namespace, from_id, to_id, link_type,
             valid_from, valid_until, source_episode_id, created_at, path_ids
      FROM path_search
      WHERE to_id = ?
      ORDER BY depth ASC
      LIMIT 1
    `

    // Simpler two-query approach: find the link IDs on the shortest path
    const simpleSql = `
      WITH RECURSIVE path_search(to_id, depth, link_id) AS (
        SELECT l.to_id, 1, l.id
        FROM trl_links l
        WHERE l.namespace = ?
          AND l.from_id = ?
          AND l.valid_from <= ?
          AND (l.valid_until IS NULL OR l.valid_until > ?)

        UNION ALL

        SELECT l.to_id, p.depth + 1, l.id
        FROM trl_links l
        JOIN path_search p ON l.from_id = p.to_id
        WHERE l.namespace IS NOT NULL
          AND (SELECT namespace FROM trl_links WHERE id = l.id LIMIT 1) = ?
          AND l.valid_from <= ?
          AND (l.valid_until IS NULL OR l.valid_until > ?)
          AND p.depth < ?
      )
      SELECT link_id FROM path_search WHERE to_id = ? ORDER BY depth ASC LIMIT 1
    `

    void sql // unused complex version

    // Straightforward iterative approach using the CTE's anchor row only
    const found = db
      .prepare<unknown[], { link_id: string }>(simpleSql)
      .get(namespace, fromId, temporalAnchor, temporalAnchor, namespace, temporalAnchor, temporalAnchor, maxDepth, toId)

    if (!found) return null

    const link = db
      .prepare<[string], LinkRow>('SELECT * FROM trl_links WHERE id = ?')
      .get(found.link_id)
    return link ? [rowToLink(link)] : null
  }
}
