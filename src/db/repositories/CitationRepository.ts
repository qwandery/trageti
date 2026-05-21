import type { Database } from 'better-sqlite3'
import type { AssertionCitation, NewAssertionCitation } from '../../domain/types.js'
import { buildCandidateJson } from '../candidates.js'
import { ErrorCode, TragetiError } from '../../errors/index.js'

interface CitationRow {
  id: string
  assertion_id: string
  episode_id: string
  source_ref: string
  excerpt: string | null
  excerpt_start: string | null
  excerpt_end: string | null
  metadata: string | null
  created_at: string
}

function rowToCitation(row: CitationRow): AssertionCitation {
  const cit: AssertionCitation = {
    id: row.id,
    assertionId: row.assertion_id,
    episodeId: row.episode_id,
    sourceRef: row.source_ref,
    excerpt: row.excerpt,
    createdAt: row.created_at,
  }
  if (row.excerpt_start !== null) cit.excerptStart = row.excerpt_start
  if (row.excerpt_end !== null) cit.excerptEnd = row.excerpt_end
  if (row.metadata !== null) {
    cit.metadata = JSON.parse(row.metadata) as Record<string, unknown>
  }
  return cit
}

/**
 * DAO for trageti_citations. Transaction-neutral — all writes execute against the shared
 * Database handle without opening inner transactions. Compound-write callers (e.g.,
 * TemporalStore.writeAssertion) own the transaction boundary.
 */
export class CitationRepository {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  insertMany(assertionId: string, citations: NewAssertionCitation[]): AssertionCitation[] {
    const stmt = this.db.prepare(
      `INSERT INTO trageti_citations
         (id, assertion_id, episode_id, source_ref, excerpt, excerpt_start, excerpt_end, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const cit of citations) {
      stmt.run(
        cit.id,
        assertionId,
        cit.episodeId,
        cit.sourceRef,
        cit.excerpt,
        cit.excerptStart ?? null,
        cit.excerptEnd ?? null,
        cit.metadata !== undefined ? JSON.stringify(cit.metadata) : null,
        new Date().toISOString(),
      )
    }
    return this.getByAssertionId(assertionId)
  }

  insertOne(citation: Omit<AssertionCitation, 'createdAt'>): AssertionCitation {
    this.db
      .prepare(
        `INSERT INTO trageti_citations
           (id, assertion_id, episode_id, source_ref, excerpt, excerpt_start, excerpt_end, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        citation.id,
        citation.assertionId,
        citation.episodeId,
        citation.sourceRef,
        citation.excerpt,
        citation.excerptStart ?? null,
        citation.excerptEnd ?? null,
        citation.metadata !== undefined ? JSON.stringify(citation.metadata) : null,
        new Date().toISOString(),
      )
    const row = this.db
      .prepare<[string], CitationRow>('SELECT * FROM trageti_citations WHERE id = ?')
      .get(citation.id)
    if (!row) {
      throw new TragetiError(
        ErrorCode.INTERNAL_INVARIANT,
        `Citation "${citation.id}" not found after insert`,
      )
    }
    return rowToCitation(row)
  }

  getByAssertionId(assertionId: string): AssertionCitation[] {
    const rows = this.db
      .prepare<
        [string],
        CitationRow
      >('SELECT * FROM trageti_citations WHERE assertion_id = ? ORDER BY created_at, id')
      .all(assertionId)
    return rows.map(rowToCitation)
  }

  getByAssertionIds(ids: readonly string[]): Map<string, AssertionCitation[]> {
    const result = new Map<string, AssertionCitation[]>()
    if (ids.length === 0) return result
    const json = buildCandidateJson(ids)
    const rows = this.db
      .prepare<[string], CitationRow>(
        `SELECT * FROM trageti_citations
         WHERE assertion_id IN (SELECT value FROM json_each(?))
         ORDER BY created_at, id`,
      )
      .all(json)
    for (const row of rows) {
      const list = result.get(row.assertion_id) ?? []
      list.push(rowToCitation(row))
      result.set(row.assertion_id, list)
    }
    return result
  }

  /**
   * Deletes all citations whose parent assertion belongs to the given namespace.
   * Used by deleteNamespace() to break the FK from trageti_citations.assertion_id
   * before assertions themselves are deleted.
   */
  deleteByAssertionNamespace(namespace: string): void {
    this.db
      .prepare(
        `DELETE FROM trageti_citations
         WHERE assertion_id IN (SELECT id FROM trageti_assertions WHERE namespace = ?)`,
      )
      .run(namespace)
  }

  getCountByNamespace(namespace: string): number {
    const row = this.db
      .prepare<[string], { cnt: number }>(
        `SELECT COUNT(*) AS cnt
         FROM trageti_citations c
         JOIN trageti_assertions a ON a.id = c.assertion_id
         WHERE a.namespace = ?`,
      )
      .get(namespace)
    return row?.cnt ?? 0
  }
}
