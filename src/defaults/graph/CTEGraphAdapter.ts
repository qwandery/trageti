import type { Database } from 'better-sqlite3';
import type { GraphQueryAdapter, GraphAdapterLink, GraphAdapterTraversalOptions } from '../../domain/types.js';

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
}

function rowToLink(row: LinkRow): GraphAdapterLink {
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
  };
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
    options: GraphAdapterTraversalOptions,
  ): GraphAdapterLink[] {
    if (fromIds.length === 0) return [];

    const { temporalAnchor, maxDepth, linkTypes, includeSuperseded } = options;
    // maxDepth: 0 means no traversal — return zero links rather than the
    // one-hop base term of the recursive CTE (spec §2029).
    if (maxDepth <= 0) return [];

    const linkTypeFilter =
      linkTypes && linkTypes.length > 0 ? `AND l.link_type IN (${linkTypes.map(() => '?').join(',')})` : '';
    const linkTypeParams = linkTypes ?? [];

    // Link-validity predicate: omitted when includeSuperseded so traversal
    // crosses expired links too. Its `?` param is therefore conditional.
    const linkValidity = includeSuperseded ? '' : 'AND (l.valid_until IS NULL OR l.valid_until > ?)';
    const validityParams: number[] = includeSuperseded ? [] : [temporalAnchor];
    const targetValidity = includeSuperseded ? '' : 'AND (target.valid_until IS NULL OR target.valid_until > ?)';
    const targetValidityParams: number[] = includeSuperseded ? [] : [temporalAnchor];

    // Recursive CTE BFS up to maxDepth hops. `visited` carries the set of
    // node ids already on the path so the recursive step never re-enters a
    // node — cycle protection (spec §695).
    const sql = `
      WITH RECURSIVE traversal(id, namespace, from_id, to_id, link_type,
                                valid_from, valid_until, source_episode_id, created_at,
                                depth, visited) AS (
        SELECT l.id, l.namespace, l.from_id, l.to_id, l.link_type,
               l.valid_from, l.valid_until, l.source_episode_id, l.created_at,
               1 AS depth,
               json_array(l.from_id, l.to_id) AS visited
        FROM trageti_links l
        JOIN trageti_assertions target ON target.id = l.to_id
        WHERE l.namespace = ?
          AND l.from_id IN (SELECT value FROM json_each(?))
          AND l.valid_from <= ?
          ${linkValidity}
          AND target.valid_from <= ?
          ${targetValidity}
          ${linkTypeFilter}

        UNION ALL

        SELECT l.id, l.namespace, l.from_id, l.to_id, l.link_type,
               l.valid_from, l.valid_until, l.source_episode_id, l.created_at,
               t.depth + 1,
               json_insert(t.visited, '$[#]', l.to_id)
        FROM trageti_links l
        JOIN traversal t ON l.from_id = t.to_id
        JOIN trageti_assertions target ON target.id = l.to_id
        WHERE l.namespace = ?
          AND l.valid_from <= ?
          ${linkValidity}
          AND target.valid_from <= ?
          ${targetValidity}
          ${linkTypeFilter}
          AND t.depth < ?
          AND NOT EXISTS (
            SELECT 1 FROM json_each(t.visited) WHERE value = l.to_id
          )
      )
      -- One row per distinct link (GROUP BY the link's primary key collapses
      -- the same link reached at multiple depths). Deterministic ordering:
      -- shallowest traversal depth first, then link created_at, then id.
      SELECT id, namespace, from_id, to_id, link_type,
             valid_from, valid_until, source_episode_id, created_at
      FROM traversal
      GROUP BY id
      ORDER BY MIN(depth) ASC, created_at ASC, id ASC
    `;

    const fromJson = JSON.stringify(fromIds);
    const params: unknown[] = [
      namespace,
      fromJson,
      temporalAnchor,
      ...validityParams,
      temporalAnchor,
      ...targetValidityParams,
      ...linkTypeParams,
      namespace,
      temporalAnchor,
      ...validityParams,
      temporalAnchor,
      ...targetValidityParams,
      ...linkTypeParams,
      maxDepth,
    ];

    const rows = db.prepare<unknown[], LinkRow>(sql).all(...params);
    return rows.map(rowToLink);
  }

  findPath(
    db: Database,
    namespace: string,
    fromId: string,
    toId: string,
    options: GraphAdapterTraversalOptions,
  ): GraphAdapterLink[] | null {
    if (fromId === toId) return [];

    const { temporalAnchor, maxDepth, linkTypes, includeSuperseded } = options;
    // maxDepth: 0 permits only the zero-hop path (from === toId, handled
    // above); any from !== toId path needs at least one hop (spec §2029).
    if (maxDepth <= 0) return null;

    const linkTypeFilter =
      linkTypes && linkTypes.length > 0 ? `AND l.link_type IN (${linkTypes.map(() => '?').join(',')})` : '';
    const linkTypeParams = linkTypes ?? [];
    const linkValidity = includeSuperseded ? '' : 'AND (l.valid_until IS NULL OR l.valid_until > ?)';
    const validityParams: number[] = includeSuperseded ? [] : [temporalAnchor];
    const targetValidity = includeSuperseded ? '' : 'AND (target.valid_until IS NULL OR target.valid_until > ?)';
    const targetValidityParams: number[] = includeSuperseded ? [] : [temporalAnchor];

    const sql = `
      WITH RECURSIVE path_search(to_id, depth, path_ids, visited_to_ids, path_sort_key) AS (
        SELECT l.to_id,
               1,
               json_array(l.id),
               json_array(l.from_id, l.to_id),
               l.created_at || char(31) || l.id
        FROM trageti_links l
        JOIN trageti_assertions target ON target.id = l.to_id
        WHERE l.namespace = ?
          AND l.from_id = ?
          AND l.valid_from <= ?
          ${linkValidity}
          AND target.valid_from <= ?
          ${targetValidity}
          ${linkTypeFilter}

        UNION ALL

        SELECT l.to_id, p.depth + 1,
               json_insert(p.path_ids, '$[#]', l.id),
               json_insert(p.visited_to_ids, '$[#]', l.to_id),
               p.path_sort_key || char(30) || l.created_at || char(31) || l.id
        FROM trageti_links l
        JOIN path_search p ON l.from_id = p.to_id
        JOIN trageti_assertions target ON target.id = l.to_id
        WHERE l.namespace = ?
          AND l.valid_from <= ?
          ${linkValidity}
          AND target.valid_from <= ?
          ${targetValidity}
          ${linkTypeFilter}
          AND p.depth < ?
          AND NOT EXISTS (
            SELECT 1 FROM json_each(p.visited_to_ids) WHERE value = l.to_id
          )
      )
      SELECT path_ids, depth
      FROM path_search
      WHERE to_id = ?
      ORDER BY depth ASC, path_sort_key ASC
      LIMIT 1
    `;

    const params: unknown[] = [
      namespace,
      fromId,
      temporalAnchor,
      ...validityParams,
      temporalAnchor,
      ...targetValidityParams,
      ...linkTypeParams,
      namespace,
      temporalAnchor,
      ...validityParams,
      temporalAnchor,
      ...targetValidityParams,
      ...linkTypeParams,
      maxDepth,
      toId,
    ];

    const row = db.prepare<unknown[], { path_ids: string; depth: number }>(sql).get(...params);
    if (!row) return null;

    const pathIds = JSON.parse(row.path_ids) as string[];
    const allIds = [...new Set(pathIds)];
    const placeholders = allIds.map(() => '?').join(',');
    const linkRows = db
      .prepare<string[], LinkRow>(`SELECT * FROM trageti_links WHERE id IN (${placeholders})`)
      .all(...allIds);
    const byId = new Map<string, GraphAdapterLink>();
    for (const r of linkRows) byId.set(r.id, rowToLink(r));

    return pathIds.flatMap((id) => {
      const link = byId.get(id);
      return link ? [link] : [];
    });
  }
}
