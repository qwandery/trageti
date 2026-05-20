import type { Database } from 'better-sqlite3'
import type { Episode } from '../../domain/types.js'
import { ValidationError } from '../../errors/index.js'

interface EpisodeRow {
  id: string
  namespace: string
  position: number
  occurred_at: string
  type: string
  content: string
  created_at: string
  [key: string]: unknown
}

export class EpisodeRepository {
  private readonly db: Database
  private readonly extensionColumns: readonly string[]

  constructor(db: Database, extensionColumns: readonly string[] = []) {
    this.db = db
    this.extensionColumns = extensionColumns
  }

  insert(episode: Omit<Episode, 'createdAt'>): Episode {
    return this.db.transaction(() => {
      const max = this.db
        .prepare<
          [string],
          { max_pos: number | null }
        >('SELECT MAX(position) AS max_pos FROM trl_episodes WHERE namespace = ?')
        .get(episode.namespace)
      const maxPos = max?.max_pos ?? null
      if (maxPos !== null && episode.position <= maxPos) {
        throw new ValidationError([
          `Episode position ${String(episode.position)} for namespace "${episode.namespace}" must be strictly greater than the existing max position ${String(maxPos)} (positions must increase monotonically within a namespace per spec v0.2).`,
        ])
      }
      this.db
        .prepare(
          `INSERT INTO trl_episodes (id, namespace, position, occurred_at, type, content)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          episode.id,
          episode.namespace,
          episode.position,
          episode.occurredAt,
          episode.type,
          episode.content,
        )
      const row = this.db
        .prepare<[string], EpisodeRow>('SELECT * FROM trl_episodes WHERE id = ?')
        .get(episode.id)
      if (!row) throw new Error(`Episode "${episode.id}" not found after insert`)
      return this.rowToEpisode(row)
    })()
  }

  getById(id: string): Episode | null {
    const row = this.db
      .prepare<[string], EpisodeRow>('SELECT * FROM trl_episodes WHERE id = ?')
      .get(id)
    return row ? this.rowToEpisode(row) : null
  }

  private rowToEpisode(row: EpisodeRow): Episode {
    const extensions: Record<string, unknown> = {}
    for (const col of this.extensionColumns) {
      extensions[col] = row[col] ?? null
    }
    return {
      id: row.id,
      namespace: row.namespace,
      position: row.position,
      occurredAt: row.occurred_at,
      type: row.type,
      content: row.content,
      createdAt: row.created_at,
    }
  }
}
