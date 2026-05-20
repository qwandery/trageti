import type { Database } from 'better-sqlite3'
import type { NamespaceRepository } from '../db/repositories/NamespaceRepository.js'
import type { EmbeddingRepository } from '../db/repositories/EmbeddingRepository.js'
import type { EmbeddingProvider, ReindexOptions, ReindexResult } from '../domain/types.js'
import { namespaceToEmbeddingTable } from '../internal/hash.js'
import { ReindexError } from '../errors/index.js'

const DEFAULT_BATCH_SIZE = 200

/**
 * Rebuild a namespace's vector index using a **staging swap**: embeddings are
 * built into a fresh staging vec0 table, and only on success is the namespace
 * repointed at it (atomic `embedding_table` update) and the previous table
 * dropped. A provider failure discards the staging table and leaves the
 * previous index fully intact — reindex is non-destructive on the failure path.
 */
export async function reindexNamespace(
  db: Database,
  namespaceRepo: NamespaceRepository,
  embeddingRepo: EmbeddingRepository,
  namespace: string,
  options: ReindexOptions & { embeddingProvider: EmbeddingProvider },
): Promise<ReindexResult> {
  const started = Date.now()
  const current = namespaceRepo.get(namespace)
  const oldTable = namespaceRepo.getEmbeddingTable(namespace)
  const newDimension = options.newDimension ?? current?.embeddingDimension ?? null
  if (newDimension === null) {
    throw new ReindexError(
      namespace,
      0,
      'reindexNamespace requires a dimension (the namespace is vectorless)',
    )
  }
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const provider = options.embeddingProvider

  // Build into a fresh, collision-safe staging table. The deterministic base
  // name plus a unique suffix means repeated reindexes never collide.
  const stagingTable = `${namespaceToEmbeddingTable(namespace)}_staging_${String(Date.now())}`
  embeddingRepo.dropTable(stagingTable)
  embeddingRepo.ensureVec0Table(stagingTable, newDimension)

  let reindexed = 0
  try {
    let offset = 0
    for (;;) {
      if (options.signal?.aborted) {
        throw new Error('reindex aborted by signal')
      }
      const batch = db
        .prepare<
          [string, number, number],
          { id: string; content: string }
        >('SELECT id, content FROM trl_assertions WHERE namespace = ? LIMIT ? OFFSET ?')
        .all(namespace, batchSize, offset)
      if (batch.length === 0) break

      const vecs = await provider.embed(
        batch.map((b) => b.content),
        { purpose: 'reindex' },
      )
      const items: Array<{ assertionId: string; embedding: Float32Array }> = []
      for (let i = 0; i < batch.length; i++) {
        const vec = vecs[i]
        const row = batch[i]
        if (!vec || !row) {
          throw new Error(`embedding provider returned no vector for batch item ${String(i)}`)
        }
        items.push({ assertionId: row.id, embedding: vec })
      }
      embeddingRepo.insertBatch(stagingTable, items)
      reindexed += items.length
      offset += batch.length
      if (batch.length < batchSize) break
    }
  } catch (err) {
    // Discard the staging table; the previous index is untouched.
    embeddingRepo.dropTable(stagingTable)
    throw new ReindexError(namespace, reindexed, err)
  }

  // Atomic swap: repoint embedding_table at the staging table, then drop the
  // old table. The embedding_table column is the authoritative name.
  const swappedAt = new Date().toISOString()
  db.transaction(() => {
    namespaceRepo.updateEmbeddingDimension(namespace, newDimension, stagingTable)
  })()
  if (oldTable && oldTable !== stagingTable) {
    embeddingRepo.dropTable(oldTable)
  }

  return { reindexed, skipped: [], swappedAt, durationMs: Date.now() - started }
}
