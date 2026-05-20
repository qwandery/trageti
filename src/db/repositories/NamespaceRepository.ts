import type { Database } from 'better-sqlite3'
import type { NamespaceConfig } from '../../domain/types.js'
import { namespaceToEmbeddingTable } from '../../internal/hash.js'
import { NamespaceDimensionMismatchError, NamespaceHashCollisionError } from '../../errors/index.js'

interface NamespaceRow {
  namespace: string
  embedding_dimension: number | null
  embedding_table: string | null
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
      .prepare<
        [string],
        NamespaceRow
      >('SELECT namespace, embedding_dimension, embedding_table, created_at, config FROM trl_namespaces WHERE namespace = ?')
      .get(namespace)
    return row ? rowToConfig(row) : null
  }

  getEmbeddingTable(namespace: string): string | null {
    const row = this.db
      .prepare<
        [string],
        { embedding_table: string | null }
      >('SELECT embedding_table FROM trl_namespaces WHERE namespace = ?')
      .get(namespace)
    return row?.embedding_table ?? null
  }

  /**
   * Register or no-op-on-existing a namespace.
   *
   * v0.3 semantics:
   *   - embeddingDimension === null OR 0/undefined → vectorless namespace
   *     (both embedding_dimension and embedding_table stored as NULL).
   *   - embeddingDimension > 0 → vector-configured namespace; embedding_table
   *     deterministically derived from the namespace name.
   *
   * The schema CHECK forbids the partial state where dimension is set but
   * table name is not, so both fields are written atomically.
   */
  upsert(
    namespace: string,
    embeddingDimension: number | null | undefined,
    config: Record<string, unknown> = {},
  ): void {
    const dim = embeddingDimension && embeddingDimension > 0 ? embeddingDimension : null
    const existing = this.get(namespace)
    if (existing) {
      if (dim !== null) {
        if (existing.embeddingDimension === null) {
          throw new NamespaceDimensionMismatchError(namespace, dim, 0)
        }
        if (existing.embeddingDimension !== dim) {
          throw new NamespaceDimensionMismatchError(namespace, existing.embeddingDimension, dim)
        }
      }
      return
    }

    const embeddingTable = dim !== null ? namespaceToEmbeddingTable(namespace) : null

    if (embeddingTable !== null) {
      const collision = this.db
        .prepare<
          [string, string],
          { namespace: string }
        >('SELECT namespace FROM trl_namespaces WHERE embedding_table = ? AND namespace != ?')
        .get(embeddingTable, namespace)
      if (collision) {
        throw new NamespaceHashCollisionError(namespace, collision.namespace, embeddingTable)
      }
    }

    this.db
      .prepare(
        `INSERT INTO trl_namespaces (namespace, embedding_dimension, embedding_table, config)
         VALUES (?, ?, ?, ?)`,
      )
      .run(namespace, dim, embeddingTable, JSON.stringify(config))
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
      .prepare<
        [string],
        { min: number | null; max: number | null }
      >('SELECT MIN(position) AS min, MAX(position) AS max FROM trl_episodes WHERE namespace = ?')
      .get(namespace)
    return { min: row?.min ?? 0, max: row?.max ?? 0 }
  }
}
