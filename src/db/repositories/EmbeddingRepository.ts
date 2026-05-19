import type { Database } from 'better-sqlite3'
import { quoteIdent } from '../../internal/sql-ident.js'

export class EmbeddingRepository {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  ensureVec0Table(tableName: string, dimension: number): void {
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${quoteIdent(tableName)} USING vec0(assertion_id TEXT PRIMARY KEY, embedding FLOAT[${dimension}])`,
    )
  }

  tableExists(tableName: string): boolean {
    const row = this.db
      .prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE name = ? AND type = 'table'")
      .get(tableName)
    return row !== undefined
  }

  dropAndRecreate(tableName: string, dimension: number): void {
    this.db.transaction(() => {
      this.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`)
      this.db.exec(
        `CREATE VIRTUAL TABLE ${quoteIdent(tableName)} USING vec0(assertion_id TEXT PRIMARY KEY, embedding FLOAT[${dimension}])`,
      )
    })()
  }

  insert(tableName: string, assertionId: string, embedding: Float32Array | number[]): void {
    const vec = embedding instanceof Float32Array ? embedding : new Float32Array(embedding)
    this.db
      .prepare(`INSERT OR REPLACE INTO ${quoteIdent(tableName)} (assertion_id, embedding) VALUES (?, ?)`)
      .run(assertionId, vec)
  }

  insertBatch(
    tableName: string,
    items: Array<{ assertionId: string; embedding: Float32Array | number[] }>,
  ): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO ${quoteIdent(tableName)} (assertion_id, embedding) VALUES (?, ?)`,
    )
    const tx = this.db.transaction(() => {
      for (const item of items) {
        const vec = item.embedding instanceof Float32Array ? item.embedding : new Float32Array(item.embedding)
        stmt.run(item.assertionId, vec)
      }
    })
    tx()
  }

  getPendingIndexing(
    tableName: string,
    namespace: string,
  ): Array<{ id: string; content: string }> {
    // Pending = assertions in this namespace with no corresponding embedding row
    const sql = `
      SELECT a.id, a.content
      FROM trl_assertions a
      LEFT JOIN ${quoteIdent(tableName)} e ON a.id = e.assertion_id
      WHERE a.namespace = ?
        AND e.assertion_id IS NULL
    `
    return this.db.prepare<[string], { id: string; content: string }>(sql).all(namespace)
  }

  getIndexedCount(tableName: string, namespace: string): number {
    const sql = `
      SELECT COUNT(*) AS cnt
      FROM trl_assertions a
      JOIN ${quoteIdent(tableName)} e ON a.id = e.assertion_id
      WHERE a.namespace = ?
    `
    const row = this.db.prepare<[string], { cnt: number }>(sql).get(namespace)
    return row?.cnt ?? 0
  }
}
