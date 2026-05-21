import type { Database } from 'better-sqlite3'
import type { NamespaceRepository } from '../db/repositories/NamespaceRepository.js'
import type { EmbeddingRepository } from '../db/repositories/EmbeddingRepository.js'
import type {
  EmbeddingProvider,
  IndexBatchSkipped,
  ReindexOptions,
  ReindexResult,
} from '../domain/types.js'
import { namespaceToEmbeddingTable } from '../internal/hash.js'
import { ErrorCode, ReindexError, errorCodeOf } from '../errors/index.js'

const DEFAULT_BATCH_SIZE = 64

interface AssertionRow {
  id: string
  content: string
}

/**
 * Rebuild a namespace's vector index. Honors the full v0.3 `ReindexOptions`
 * contract (spec §1156-1183, §2044-2085):
 *
 * - `strategy: 'staging-swap'` (default) builds embeddings into a fresh staging
 *   vec0 table and atomically repoints `embedding_table` only on success. A
 *   provider failure under `'fail-fast'` discards the staging table and leaves
 *   the previous live index fully intact.
 * - `strategy: 'in-place'` writes directly into the live vec0 table — no
 *   staging, no atomic swap, `swappedAt` absent. A `'fail-fast'` failure leaves
 *   the namespace partially indexed (the documented `'in-place'` trade-off).
 * - `onProviderError: 'skip'` iterates per item and accumulates sanitized
 *   failures in `ReindexResult.skipped`.
 * - `allowPartialSwap` gates a staging swap when `'skip'` produced failures —
 *   without it, a partial build is rejected so a complete live index is never
 *   silently replaced by one missing the skipped rows.
 * - `signal` is propagated into every `provider.embed()` call.
 */
export async function reindexNamespace(
  db: Database,
  namespaceRepo: NamespaceRepository,
  embeddingRepo: EmbeddingRepository,
  namespace: string,
  options: ReindexOptions & { embeddingProvider: EmbeddingProvider },
): Promise<ReindexResult> {
  const started = Date.now()
  const strategy = options.strategy ?? 'staging-swap'
  const mode = options.onProviderError ?? 'fail-fast'
  const allowPartialSwap = options.allowPartialSwap ?? false
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const provider = options.embeddingProvider

  const current = namespaceRepo.get(namespace)
  const oldTable = namespaceRepo.getEmbeddingTable(namespace)
  const currentDimension = current?.embeddingDimension ?? null
  if (currentDimension === null) {
    // reindex never converts a vectorless namespace — that is the exclusive
    // job of upgradeNamespaceToVector(). Supplying `newDimension` here would
    // otherwise silently bypass the only sanctioned upgrade path.
    throw new ReindexError(
      namespace,
      0,
      'reindexNamespace cannot convert a vectorless namespace; call upgradeNamespaceToVector() first',
    )
  }
  const newDimension = options.newDimension ?? currentDimension

  // Resolve the target vec0 table per strategy.
  let targetTable: string
  if (strategy === 'staging-swap') {
    // Deterministic base + unique suffix so repeated reindexes never collide.
    targetTable = `${namespaceToEmbeddingTable(namespace)}_staging_${String(Date.now())}`
    embeddingRepo.dropTable(targetTable)
    embeddingRepo.ensureVec0Table(targetTable, newDimension)
  } else {
    // in-place: write straight into the live table.
    targetTable = oldTable ?? namespaceToEmbeddingTable(namespace)
    if (newDimension !== currentDimension) {
      // A vec0 table's dimension is fixed at creation — a dimension change is
      // a destructive recreate. Update the namespace metadata up front so that
      // even a mid-run failure leaves metadata consistent with the physical
      // table (the documented in-place risk is a lost/partial index, not a
      // dimension/metadata mismatch).
      embeddingRepo.dropAndRecreate(targetTable, newDimension)
      db.transaction(() => {
        namespaceRepo.updateEmbeddingDimension(namespace, newDimension, targetTable)
      })()
    } else {
      embeddingRepo.ensureVec0Table(targetTable, newDimension)
    }
  }

  const skipped: IndexBatchSkipped[] = []
  let reindexed = 0

  const embedOpts = (): { purpose: 'reindex'; signal?: AbortSignal } => {
    const o: { purpose: 'reindex'; signal?: AbortSignal } = { purpose: 'reindex' }
    if (options.signal) o.signal = options.signal
    return o
  }

  try {
    let offset = 0
    for (;;) {
      const batch = db
        .prepare<
          [string, number, number],
          AssertionRow
        >('SELECT id, content FROM trageti_assertions WHERE namespace = ? LIMIT ? OFFSET ?')
        .all(namespace, batchSize, offset)
      if (batch.length === 0) break

      if (mode === 'fail-fast') {
        if (options.signal?.aborted) throw new Error('reindex aborted by signal')
        const vecs = await provider.embed(
          batch.map((b) => b.content),
          embedOpts(),
        )
        const items: Array<{ assertionId: string; embedding: Float32Array }> = []
        for (let i = 0; i < batch.length; i++) {
          const vec = vecs[i]
          const row = batch[i]
          if (!vec || !row) {
            throw new Error(`embedding provider returned no vector for batch item ${String(i)}`)
          }
          if (vec.length !== newDimension) {
            throw new Error(
              `embedding length ${String(vec.length)} does not match dimension ${String(newDimension)}`,
            )
          }
          items.push({ assertionId: row.id, embedding: vec })
        }
        embeddingRepo.insertBatch(targetTable, items)
        reindexed += items.length
      } else {
        // skip mode: per-item, accumulate sanitized failures.
        for (const row of batch) {
          if (options.signal?.aborted) {
            skipped.push({ assertionId: row.id, reason: 'ABORTED', errorCode: 'ABORTED' })
            continue
          }
          try {
            const [vec] = await provider.embed([row.content], embedOpts())
            if (!vec) {
              skipped.push({
                assertionId: row.id,
                reason: 'EMBEDDING_PROVIDER_ERROR',
                errorCode: 'EMBEDDING_PROVIDER_EMPTY',
              })
              continue
            }
            if (vec.length !== newDimension) {
              skipped.push({
                assertionId: row.id,
                reason: 'EMBEDDING_DIMENSION_MISMATCH',
                errorCode: 'EMBEDDING_DIMENSION_MISMATCH',
              })
              continue
            }
            embeddingRepo.insert(targetTable, row.id, vec)
            reindexed++
          } catch (err) {
            skipped.push({
              assertionId: row.id,
              reason: 'EMBEDDING_PROVIDER_ERROR',
              errorCode: errorCodeOf(err),
            })
          }
        }
      }

      offset += batch.length
      if (batch.length < batchSize) break
    }
  } catch (err) {
    // fail-fast failure. Staging-swap discards the staging table and preserves
    // the previous live index; in-place leaves the namespace partially indexed.
    if (strategy === 'staging-swap') {
      embeddingRepo.dropTable(targetTable)
    }
    throw new ReindexError(namespace, reindexed, err)
  }

  if (strategy === 'staging-swap') {
    if (skipped.length > 0 && !allowPartialSwap) {
      // A complete live index is never silently replaced by a partial one.
      embeddingRepo.dropTable(targetTable)
      throw new ReindexError(
        namespace,
        reindexed,
        `partial staging build rejected: ${String(skipped.length)} assertion(s) skipped`,
        {
          code: ErrorCode.REINDEX_PARTIAL_REJECTED,
          skipped,
          advice:
            "pass allowPartialSwap: true to accept the partial result, or rerun with onProviderError: 'fail-fast' to surface the cause",
        },
      )
    }
    const swappedAt = new Date().toISOString()
    db.transaction(() => {
      namespaceRepo.updateEmbeddingDimension(namespace, newDimension, targetTable)
    })()
    if (oldTable && oldTable !== targetTable) {
      embeddingRepo.dropTable(oldTable)
    }
    return { reindexed, skipped, swappedAt, durationMs: Date.now() - started }
  }

  // in-place: no atomic swap, so no swappedAt.
  return { reindexed, skipped, durationMs: Date.now() - started }
}
