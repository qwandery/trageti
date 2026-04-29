import type { Database } from 'better-sqlite3'
import type { Assertion } from '../../domain/types.js'

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

  constructor(db: Database, extensionColumns: readonly string[] = []) {
    this.db = db
    this.extensionColumns = extensionColumns
  }

  insert(assertion: Omit<Assertion, 'createdAt' | 'extensions'>): Assertion {
    this.db
      .prepare(
        `INSERT INTO trl_assertions
           (id, namespace, type, content, valid_from, valid_until, confidence,
            source_episode_id, supersedes_id, entity_id, entity_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
    return this.getByIdOrThrow(assertion.id)
  }

  supersedeAssertion(
    assertionId: string,
    validUntil: number,
    replacedById: string | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE trl_assertions SET valid_until = ?, supersedes_id = COALESCE(?, supersedes_id) WHERE id = ?`,
      )
      .run(validUntil, replacedById, assertionId)
  }

  getById(id: string): Assertion | null {
    const row = this.db
      .prepare<[string], AssertionRow>('SELECT * FROM trl_assertions WHERE id = ?')
      .get(id)
    return row ? this.rowToAssertion(row) : null
  }

  query(namespace: string, options: AssertionQueryOptions = {}): Assertion[] {
    const conditions: string[] = ['namespace = ?']
    const params: unknown[] = [namespace]

    if (options.validAt !== undefined) {
      conditions.push('valid_from <= ?')
      conditions.push('(valid_until IS NULL OR valid_until > ?)')
      params.push(options.validAt, options.validAt)
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

    const sql = `SELECT * FROM trl_assertions WHERE ${conditions.join(' AND ')}`
    const rows = this.db.prepare<unknown[], AssertionRow>(sql).all(...params)
    return rows.map((r) => this.rowToAssertion(r))
  }

  getEntityHistory(namespace: string, entityId: string): Assertion[] {
    const rows = this.db
      .prepare<[string, string], AssertionRow>(
        'SELECT * FROM trl_assertions WHERE namespace = ? AND entity_id = ? ORDER BY valid_from ASC',
      )
      .all(namespace, entityId)
    return rows.map((r) => this.rowToAssertion(r))
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
         FROM trl_assertions WHERE namespace = ?`,
      )
      .get(namespace)
    return {
      assertionCount: row?.total ?? 0,
      activeAssertionCount: row?.active ?? 0,
      supersededCount: row?.superseded ?? 0,
    }
  }

  private getByIdOrThrow(id: string): Assertion {
    const row = this.db
      .prepare<[string], AssertionRow>('SELECT * FROM trl_assertions WHERE id = ?')
      .get(id)
    if (!row) throw new Error(`Assertion "${id}" not found after insert`)
    return this.rowToAssertion(row)
  }

  rowToAssertion(row: AssertionRow): Assertion {
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
      createdAt: row.created_at,
      extensions,
    }
  }
}
