import type { Database } from 'better-sqlite3'
import type { NamespaceConfig } from '../../domain/types.js'
import { namespaceToEmbeddingTable } from '../../internal/hash.js'
import { NamespaceHashCollisionError } from '../../errors/index.js'

interface NamespaceRow {
  namespace: string
  embedding_dimension: number
  embedding_table: string
  created_at: string
  config: string
}

function rowToConfig(row: NamespaceRow): NamespaceConfig {
  return {
    namespace: row.namespace,
    embeddingDimension: row.embedding_dimension,
    createdAt: row.created_at,
    config: JSON.parse(row.config) as Record<string, unknown>,
  }
}

export class NamespaceRepository {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  get(namespace: string): NamespaceConfig | null {
    const row = this.db
      .prepare<[string], NamespaceRow>(
        'SELECT namespace, embedding_dimension, embedding_table, created_at, config FROM trl_namespaces WHERE namespace = ?',
      )
      .get(namespace)
    return row ? rowToConfig(row) : null
  }

  getEmbeddingTable(namespace: string): string | null {
    const row = this.db
      .prepare<[string], { embedding_table: string }>(
        'SELECT embedding_table FROM trl_namespaces WHERE namespace = ?',
      )
      .get(namespace)
    return row?.embedding_table ?? null
  }

  upsert(namespace: string, embeddingDimension: number, config: Record<string, unknown> = {}): void {
    const embeddingTable = namespaceToEmbeddingTable(namespace)

    // Guard against hash collision
    const collision = this.db
      .prepare<[string, string], { namespace: string }>(
        'SELECT namespace FROM trl_namespaces WHERE embedding_table = ? AND namespace != ?',
      )
      .get(embeddingTable, namespace)
    if (collision) {
      throw new NamespaceHashCollisionError(namespace, collision.namespace, embeddingTable)
    }

    this.db
      .prepare(
        `INSERT INTO trl_namespaces (namespace, embedding_dimension, embedding_table, config)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(namespace) DO NOTHING`,
      )
      .run(namespace, embeddingDimension, embeddingTable, JSON.stringify(config))
  }

  updateEmbeddingDimension(namespace: string, newDimension: number, newTable: string): void {
    this.db
      .prepare(
        'UPDATE trl_namespaces SET embedding_dimension = ?, embedding_table = ? WHERE namespace = ?',
      )
      .run(newDimension, newTable, namespace)
  }

  delete(namespace: string): void {
    this.db.prepare('DELETE FROM trl_namespaces WHERE namespace = ?').run(namespace)
  }

  getPositionRange(namespace: string): { min: number; max: number } {
    const row = this.db
      .prepare<[string], { min: number | null; max: number | null }>(
        'SELECT MIN(position) AS min, MAX(position) AS max FROM trl_episodes WHERE namespace = ?',
      )
      .get(namespace)
    return { min: row?.min ?? 0, max: row?.max ?? 0 }
  }
}
