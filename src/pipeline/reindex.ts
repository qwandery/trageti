import type { Database } from 'better-sqlite3'
import type { NamespaceRepository } from '../db/repositories/NamespaceRepository.js'
import type { EmbeddingRepository } from '../db/repositories/EmbeddingRepository.js'
import type { AssertionRepository } from '../db/repositories/AssertionRepository.js'
import { namespaceToEmbeddingTable } from '../internal/hash.js'

const BATCH_SIZE = 200

export async function reindexNamespace(
  db: Database,
  namespaceRepo: NamespaceRepository,
  embeddingRepo: EmbeddingRepository,
  assertionRepo: AssertionRepository,
  namespace: string,
  options: {
    newDimension: number
    embeddingProvider: (assertionId: string, content: string) => Promise<Float32Array>
  },
): Promise<void> {
  const newTable = namespaceToEmbeddingTable(namespace)

  // Drop and recreate the vec0 table with the new dimension (atomic)
  embeddingRepo.dropAndRecreate(newTable, options.newDimension)

  // Update dimension in registry
  namespaceRepo.updateEmbeddingDimension(namespace, options.newDimension, newTable)

  // Stream assertions in batches and re-embed
  let offset = 0
  for (;;) {
    const batch = db
      .prepare<[string, number, number], { id: string; content: string }>(
        'SELECT id, content FROM trl_assertions WHERE namespace = ? LIMIT ? OFFSET ?',
      )
      .all(namespace, BATCH_SIZE, offset)

    if (batch.length === 0) break

    const embeddings = await Promise.all(
      batch.map((item) => options.embeddingProvider(item.id, item.content)),
    )

    embeddingRepo.insertBatch(
      newTable,
      batch.map((item, i) => ({ assertionId: item.id, embedding: embeddings[i]! })),
    )

    offset += batch.length
    if (batch.length < BATCH_SIZE) break
  }
}
