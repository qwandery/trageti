import { describe, it, expect } from 'vitest'
import { openTestDb } from '../helpers/openTestDb.js'
import { TemporalStore } from '../../src/store/TemporalStore.js'
import {
  IndexingError,
  ReferencedExtensionTableError,
  RetrievalInputError,
} from '../../src/errors/index.js'

const NS = 'vectorless-ns'

describe('TemporalStore vectorless namespace state', () => {
  it('registers vectorless namespaces without creating vec0 tables', async () => {
    const db = openTestDb()
    const store = new TemporalStore(db, { namespace: NS })
    await store.init()

    const ns = db.prepare('SELECT embedding_dimension, embedding_table FROM trl_namespaces WHERE namespace = ?').get(NS) as {
      embedding_dimension: number | null
      embedding_table: string | null
    }
    expect(ns).toEqual({ embedding_dimension: null, embedding_table: null })

    const stats = await store.getStats(NS)
    expect(stats.embeddingDimension).toBeNull()
    expect(stats.vectorReady).toBe(false)
    expect(stats.indexedCount).toBe(0)
  })

  it('rejects vector access until a namespace is upgraded, then creates vec0 lazily', async () => {
    const db = openTestDb()
    const store = new TemporalStore(db, { namespace: NS })
    await store.init()
    await store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '', type: 'doc', content: 'c' })
    await store.writeAssertion({
      id: 'a-1',
      namespace: NS,
      type: 'fact',
      content: 'c',
      validFrom: 1,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [{ id: 'a-1:c0', episodeId: 'ep-1', sourceRef: 'chunk:1', excerpt: null }],
    })

    await expect(store.indexAssertion('a-1', new Float32Array([1, 0, 0, 0]))).rejects.toThrow(IndexingError)
    await expect(store.retrieve({ namespace: NS, queryEmbedding: new Float32Array([1, 0, 0, 0]), temporalAnchor: 1 })).rejects.toThrow(RetrievalInputError)

    await store.upgradeNamespaceToVector(NS, { embeddingDimension: 4 })
    expect((await store.getStats(NS)).vectorReady).toBe(false)
    await store.indexAssertion('a-1', new Float32Array([1, 0, 0, 0]))
    expect((await store.getStats(NS)).vectorReady).toBe(true)
    expect((await store.getStats(NS)).indexedCount).toBe(1)
  })
})

describe('deleteNamespace extension cascade', () => {
  it('requires cascade for namespace-referencing extension tables and deletes only matching rows', async () => {
    const db = openTestDb()
    const store = new TemporalStore(db, {
      namespace: NS,
      embeddingDimension: 4,
      schemaExtensions: {
        tables: [{
          tableName: 'app_audit',
          createSQL: 'CREATE TABLE IF NOT EXISTS app_audit (id TEXT PRIMARY KEY, ns TEXT NOT NULL)',
          referencesNamespace: true,
          namespaceColumn: 'ns',
        }],
      },
    })
    await store.init()
    db.prepare('INSERT INTO app_audit (id, ns) VALUES (?, ?), (?, ?)').run('same', NS, 'other', 'elsewhere')

    await expect(store.deleteNamespace(NS)).rejects.toThrow(ReferencedExtensionTableError)
    await store.deleteNamespace(NS, { cascade: true })

    const rows = db.prepare('SELECT id, ns FROM app_audit ORDER BY id').all() as Array<{ id: string; ns: string }>
    expect(rows).toEqual([{ id: 'other', ns: 'elsewhere' }])
  })
})
