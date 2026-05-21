import type { Database } from 'better-sqlite3'
import type { Assertion, AssertionCitation, NormalizedNewAssertion } from '../../domain/types.js'
import type { CitationRepository } from './CitationRepository.js'
import { buildCandidateJson } from '../candidates.js'

interface AssertionRow {
  id: string
  namespace: string
  type: string
  content: string
  valid_from: number
  valid_until: number | null
  confidence: number
  source_episode_id: string
  supersedes_id: string | null
  entity_id: string | null
  entity_type: string | null
  created_at: string
  [key: string]: unknown
}

export interface AssertionQueryOptions {
  entityId?: string
  entityType?: string
  type?: string
  validAt?: number
  includeSuperseded?: boolean
}

export class AssertionRepository {
  private readonly db: Database
  private readonly extensionColumns: readonly string[]
  private readonly citationRepo: CitationRepository

  constructor(
    db: Database,
    citationRepo: CitationRepository,
    extensionColumns: readonly string[] = [],
  ) {
    this.db = db
    this.citationRepo = citationRepo
    this.extensionColumns = extensionColumns
  }

  insert(assertion: Omit<NormalizedNewAssertion, 'citations'>): void {
    this.db
      .prepare(
        `INSERT INTO trageti_assertions
           (id, namespace, type, content, valid_from, valid_until, confidence,
            source_episode_id, supersedes_id, entity_id, entity_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        assertion.id,
        assertion.namespace,
        assertion.type,
        assertion.content,
        assertion.validFrom,
        assertion.validUntil ?? null,
        assertion.confidence,
        assertion.sourceEpisodeId,
        assertion.supersedesId ?? null,
        assertion.entityId ?? null,
        assertion.entityType ?? null,
        new Date().toISOString(),
      )
  }

  /**
   * Sets valid_until on the given assertion. Does NOT modify supersedes_id —
   * supersedes_id is strictly new -> old (decision §1) and is set on the new
   * assertion at writeAssertion() time, never written back from the predecessor.
   */
  supersedeAssertion(assertionId: string, validUntil: number): void {
    this.db
      .prepare('UPDATE trageti_assertions SET valid_until = ? WHERE id = ?')
      .run(validUntil, assertionId)
  }

  getById(id: string): Assertion | null {
    const row = this.db
      .prepare<[string], AssertionRow>('SELECT * FROM trageti_assertions WHERE id = ?')
      .get(id)
    if (!row) return null
    return this.rowToAssertion(row, this.citationRepo.getByAssertionId(id))
  }

  /** Hydrate a row that the caller has already supplied citations for (avoids re-fetch). */
  hydrateRow(row: AssertionRow, citations: AssertionCitation[]): Assertion {
    return this.rowToAssertion(row, citations)
  }

  getByIds(ids: readonly string[]): Assertion[] {
    if (ids.length === 0) return []
    const json = buildCandidateJson(ids)
    const rows = this.db
      .prepare<
        [string],
        AssertionRow
      >('SELECT * FROM trageti_assertions WHERE id IN (SELECT value FROM json_each(?))')
      .all(json)
    const citationsById = this.citationRepo.getByAssertionIds(rows.map((r) => r.id))
    return rows.map((r) => this.rowToAssertion(r, citationsById.get(r.id) ?? []))
  }

  query(namespace: string, options: AssertionQueryOptions = {}): Assertion[] {
    const conditions: string[] = ['namespace = ?']
    const params: unknown[] = [namespace]

    if (options.validAt !== undefined) {
      // `valid_from <= anchor` always applies. The upper bound selects exactly
      // the version valid AT the anchor; it is dropped for
      // `includeSuperseded: true`, which then also returns versions closed
      // before the anchor — mirroring the retrieval Step-1 temporal relaxation.
      conditions.push('valid_from <= ?')
      params.push(options.validAt)
      if (!options.includeSuperseded) {
        conditions.push('(valid_until IS NULL OR valid_until > ?)')
        params.push(options.validAt)
      }
    } else if (!options.includeSuperseded) {
      // Without a temporal anchor, default to only active (never-superseded) assertions
      conditions.push('valid_until IS NULL')
    }
    if (options.entityId !== undefined) {
      conditions.push('entity_id = ?')
      params.push(options.entityId)
    }
    if (options.entityType !== undefined) {
      conditions.push('entity_type = ?')
      params.push(options.entityType)
    }
    if (options.type !== undefined) {
      conditions.push('type = ?')
      params.push(options.type)
    }

    const sql = `SELECT * FROM trageti_assertions WHERE ${conditions.join(' AND ')}`
    const rows = this.db.prepare<unknown[], AssertionRow>(sql).all(...params)
    const citationsById = this.citationRepo.getByAssertionIds(rows.map((r) => r.id))
    return rows.map((r) => this.rowToAssertion(r, citationsById.get(r.id) ?? []))
  }

  getEntityHistory(namespace: string, entityId: string): Assertion[] {
    const rows = this.db
      .prepare<
        [string, string],
        AssertionRow
      >('SELECT * FROM trageti_assertions WHERE namespace = ? AND entity_id = ? ORDER BY valid_from ASC')
      .all(namespace, entityId)
    const citationsById = this.citationRepo.getByAssertionIds(rows.map((r) => r.id))
    return rows.map((r) => this.rowToAssertion(r, citationsById.get(r.id) ?? []))
  }

  /**
   * Returns the merged supersession-chain leaves for an entity. Decision §5:
   * - Leaves: same-namespace, same-entity rows whose id is not pointed at by any
   *   other same-namespace, same-entity row's supersedes_id.
   * - For each leaf, walk supersedes_id backward (constrained to same ns/entity).
   * - Merge by id (de-dupe), sort by valid_from ASC, created_at ASC, id ASC.
   *
   * For an entity with no supersession structure, returns each entity row as
   * its own one-element trajectory (indistinguishable from getEntityHistory()
   * for that case, by design — trajectory follows replacement structure only).
   */
  getEntityTrajectory(namespace: string, entityId: string): Assertion[] {
    // Recursive CTE: start at leaves (rows of this entity not referenced as a predecessor
    // by any sibling), walk backward through supersedes_id within the same ns/entity.
    const sql = `
      WITH RECURSIVE
        entity_rows(id) AS (
          SELECT id FROM trageti_assertions
          WHERE namespace = ? AND entity_id IS NOT NULL AND entity_id = ?
        ),
        leaves(id) AS (
          SELECT id FROM entity_rows
          WHERE id NOT IN (
            SELECT supersedes_id FROM trageti_assertions
            WHERE namespace = ? AND entity_id IS NOT NULL AND entity_id = ?
              AND supersedes_id IS NOT NULL
          )
        ),
        chain(id, depth) AS (
          SELECT id, 0 FROM leaves
          UNION
          SELECT a.supersedes_id, c.depth + 1
          FROM chain c
          JOIN trageti_assertions a ON a.id = c.id
          WHERE a.supersedes_id IS NOT NULL
            AND a.namespace = ?
            AND a.entity_id IS NOT NULL AND a.entity_id = ?
        )
      SELECT DISTINCT a.*
      FROM chain c
      JOIN trageti_assertions a ON a.id = c.id
      WHERE a.namespace = ? AND a.entity_id IS NOT NULL AND a.entity_id = ?
      ORDER BY a.valid_from ASC, a.created_at ASC, a.id ASC
    `
    const rows = this.db
      .prepare<unknown[], AssertionRow>(sql)
      .all(namespace, entityId, namespace, entityId, namespace, entityId, namespace, entityId)
    const citationsById = this.citationRepo.getByAssertionIds(rows.map((r) => r.id))
    return rows.map((r) => this.rowToAssertion(r, citationsById.get(r.id) ?? []))
  }

  /**
   * Returns the supersession chain ending at the given assertion, oldest-first,
   * INCLUDING the given assertion as the last element. Used by retrieval Step 7
   * (which slices off the last element to get "prior versions only" per spec wording).
   */
  getSupersessionChain(assertionId: string): Assertion[] {
    const sql = `
      WITH RECURSIVE chain(id, depth) AS (
        SELECT id, 0 FROM trageti_assertions WHERE id = ?
        UNION ALL
        SELECT a.supersedes_id, c.depth + 1
        FROM chain c
        JOIN trageti_assertions a ON a.id = c.id
        WHERE a.supersedes_id IS NOT NULL
      )
      SELECT a.*, c.depth AS _depth
      FROM chain c
      JOIN trageti_assertions a ON a.id = c.id
      ORDER BY c.depth DESC
    `
    const rows = this.db.prepare<[string], AssertionRow>(sql).all(assertionId)
    const citationsById = this.citationRepo.getByAssertionIds(rows.map((r) => r.id))
    return rows.map((r) => this.rowToAssertion(r, citationsById.get(r.id) ?? []))
  }

  getStats(namespace: string): {
    assertionCount: number
    activeAssertionCount: number
    supersededCount: number
  } {
    const row = this.db
      .prepare<[string], { total: number; active: number; superseded: number }>(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN valid_until IS NULL THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN valid_until IS NOT NULL THEN 1 ELSE 0 END) AS superseded
         FROM trageti_assertions WHERE namespace = ?`,
      )
      .get(namespace)
    return {
      assertionCount: row?.total ?? 0,
      activeAssertionCount: row?.active ?? 0,
      supersededCount: row?.superseded ?? 0,
    }
  }

  rowToAssertion(row: AssertionRow, citations: AssertionCitation[]): Assertion {
    const extensions: Record<string, unknown> = {}
    for (const col of this.extensionColumns) {
      extensions[col] = row[col] ?? null
    }
    return {
      id: row.id,
      namespace: row.namespace,
      type: row.type,
      content: row.content,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      confidence: row.confidence,
      sourceEpisodeId: row.source_episode_id,
      supersedesId: row.supersedes_id,
      entityId: row.entity_id,
      entityType: row.entity_type,
      citations,
      createdAt: row.created_at,
      extensions,
    }
  }
}
