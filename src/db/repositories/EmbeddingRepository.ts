import type { Database } from 'better-sqlite3';
import { quoteIdent } from '../../internal/sql-ident.js';
import { buildCandidateJson } from '../candidates.js';
import { assertVec0DimensionInvariant, toFloat32Array } from '../../internal/vector.js';

export class EmbeddingRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Create the namespace's vec0 virtual table if it does not already exist.
   *
   * Existence is checked via `sqlite_master` rather than relying on
   * `CREATE VIRTUAL TABLE IF NOT EXISTS` — sqlite-vec's support for the
   * `IF NOT EXISTS` clause on vec0 tables varies by version (spec §1544).
   */
  ensureVec0Table(tableName: string, dimension: number): void {
    if (this.tableExists(tableName)) return;
    assertVec0DimensionInvariant(dimension);
    this.db.exec(
      `CREATE VIRTUAL TABLE ${quoteIdent(tableName)} USING vec0(assertion_id TEXT PRIMARY KEY, embedding FLOAT[${dimension}])`,
    );
  }

  tableExists(tableName: string): boolean {
    const row = this.db
      .prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE name = ? AND type = 'table'")
      .get(tableName);
    return row !== undefined;
  }

  /** Drop a vec0 table if it exists. Used to discard reindex staging tables
   *  and to remove the previous index after a successful staging swap. */
  dropTable(tableName: string): void {
    this.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
  }

  dropAndRecreate(tableName: string, dimension: number): void {
    assertVec0DimensionInvariant(dimension);
    this.db.transaction(() => {
      this.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
      // Existence already cleared by the DROP above; create unconditionally.
      this.db.exec(
        `CREATE VIRTUAL TABLE ${quoteIdent(tableName)} USING vec0(assertion_id TEXT PRIMARY KEY, embedding FLOAT[${dimension}])`,
      );
    })();
  }

  insert(tableName: string, assertionId: string, embedding: Float32Array | number[]): void {
    const vec = toFloat32Array(embedding);
    this.db
      .prepare(`INSERT OR REPLACE INTO ${quoteIdent(tableName)} (assertion_id, embedding) VALUES (?, ?)`)
      .run(assertionId, vec);
  }

  insertBatch(tableName: string, items: Array<{ assertionId: string; embedding: Float32Array | number[] }>): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO ${quoteIdent(tableName)} (assertion_id, embedding) VALUES (?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const item of items) {
        const vec = toFloat32Array(item.embedding);
        stmt.run(item.assertionId, vec);
      }
    });
    tx();
  }

  /**
   * Active assertions in the namespace that have no corresponding embedding
   * row in the vec0 table. Only active assertions (validUntil IS NULL) are
   * considered pending.
   */
  getPendingIndexing(
    tableName: string,
    namespace: string,
    options: { includeSuperseded?: boolean } = {},
  ): Array<{ id: string; content: string }> {
    const activeOnly = options.includeSuperseded !== true ? 'AND a.valid_until IS NULL' : '';
    const sql = `
      SELECT a.id, a.content
      FROM trageti_assertions a
      LEFT JOIN ${quoteIdent(tableName)} e ON a.id = e.assertion_id
      WHERE a.namespace = ?
        ${activeOnly}
        AND e.assertion_id IS NULL
    `;
    return this.db.prepare<[string], { id: string; content: string }>(sql).all(namespace);
  }

  /**
   * All active assertions in the namespace, regardless of indexing state.
   * Used when the vec0 table does not exist yet — every active assertion is
   * pending by definition.
   */
  getAllContent(namespace: string, options: { includeSuperseded?: boolean } = {}): Array<{ id: string; content: string }> {
    const activeOnly = options.includeSuperseded !== true ? 'AND valid_until IS NULL' : '';
    return this.db
      .prepare<
        [string],
        { id: string; content: string }
      >(`SELECT id, content FROM trageti_assertions WHERE namespace = ? ${activeOnly}`)
      .all(namespace);
  }

  getIndexedCount(tableName: string, namespace: string): number {
    const sql = `
      SELECT COUNT(*) AS cnt
      FROM trageti_assertions a
      JOIN ${quoteIdent(tableName)} e ON a.id = e.assertion_id
      WHERE a.namespace = ?
    `;
    const row = this.db.prepare<[string], { cnt: number }>(sql).get(namespace);
    return row?.cnt ?? 0;
  }

  getMissingIndexingByIds(
    tableName: string,
    namespace: string,
    assertionIds: readonly string[],
    options: { includeSuperseded?: boolean } = {},
  ): string[] {
    if (assertionIds.length === 0) return [];
    const activeOnly = options.includeSuperseded !== true ? 'AND a.valid_until IS NULL' : '';
    const sql = `
      SELECT value AS id
      FROM json_each(?)
      JOIN trageti_assertions a ON a.id = value AND a.namespace = ?
      LEFT JOIN ${quoteIdent(tableName)} e ON value = e.assertion_id
      WHERE e.assertion_id IS NULL
        ${activeOnly}
    `;
    return this.db
      .prepare<[string, string], { id: string }>(sql)
      .all(buildCandidateJson(assertionIds), namespace)
      .map((row) => row.id);
  }

  deleteSuperseded(tableName: string, namespace: string): void {
    const sql = `
      DELETE FROM ${quoteIdent(tableName)}
      WHERE assertion_id IN (
        SELECT id FROM trageti_assertions
        WHERE namespace = ? AND valid_until IS NOT NULL
      )
    `;
    this.db.prepare<[string]>(sql).run(namespace);
  }
}
