import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestDb } from '../helpers/openTestDb.js';
import { TragetiStore } from '../../src/store/TragetiStore.js';
import { MockEmbeddingProvider } from '../../src/defaults/providers/MockEmbeddingProvider.js';
import { IndexingError, ReferencedExtensionTableError, RetrievalInputError } from '../../src/errors/index.js';

const NS = 'vectorless-ns';
const tmpDirs: string[] = [];

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trageti-vectorless-e2e-'));
  tmpDirs.push(dir);
  return join(dir, 'store.db');
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp dir - safe to leak on Windows handle races */
    }
  }
});

describe('TragetiStore vectorless namespace state', () => {
  it('registers vectorless namespaces without creating vec0 tables', async () => {
    const db = openTestDb();
    const store = new TragetiStore(db, { namespace: NS });
    await store.init();

    const ns = db
      .prepare('SELECT embedding_dimension, embedding_table FROM trageti_namespaces WHERE namespace = ?')
      .get(NS) as {
      embedding_dimension: number | null;
      embedding_table: string | null;
    };
    expect(ns).toEqual({ embedding_dimension: null, embedding_table: null });

    const stats = await store.getStats(NS);
    expect(stats.embeddingDimension).toBeNull();
    expect(stats.vectorReady).toBe(false);
    expect(stats.indexedCount).toBe(0);
  });

  it('rejects vector access until a namespace is upgraded, then creates vec0 lazily', async () => {
    const db = openTestDb();
    const store = new TragetiStore(db, { namespace: NS });
    await store.init();
    await store.writeEpisode({
      id: 'ep-1',
      namespace: NS,
      position: 1,
      occurredAt: '',
      type: 'doc',
      content: 'c',
    });
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
    });

    await expect(store.indexAssertion('a-1', new Float32Array([1, 0, 0, 0]))).rejects.toThrow(IndexingError);
    await expect(
      store.retrieve({
        namespace: NS,
        queryEmbedding: new Float32Array([1, 0, 0, 0]),
        temporalAnchor: 1,
      }),
    ).rejects.toThrow(RetrievalInputError);

    await store.upgradeNamespaceToVector(NS, { embeddingDimension: 4 });
    expect((await store.getStats(NS)).vectorReady).toBe(false);
    await store.indexAssertion('a-1', new Float32Array([1, 0, 0, 0]));
    expect((await store.getStats(NS)).vectorReady).toBe(true);
    expect((await store.getStats(NS)).indexedCount).toBe(1);
  });

  it('supports a file-backed vectorless-to-vector consumer journey across reopen and reindex', async () => {
    const database = tmpDbPath();
    const provider = new MockEmbeddingProvider({ dimension: 4 });
    const vectorless = await TragetiStore.create({ database, namespace: 'vl-e2e' });
    await vectorless.writeEpisode({
      id: 'ep-1',
      namespace: 'vl-e2e',
      position: 1,
      occurredAt: '2024-01-01T00:00:00Z',
      type: 'document',
      content: 'episode about searchable vectorless content',
    });
    await vectorless.writeAssertion({
      id: 'a-1',
      namespace: 'vl-e2e',
      type: 'fact',
      content: 'Vectorless content can be searched with BM25 first.',
      validFrom: 1,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: 'e-1',
      entityType: 'concept',
      citations: [{ id: 'a-1:c0', episodeId: 'ep-1', sourceRef: 'chunk:1', excerpt: 'Vectorless content' }],
    });

    expect(
      (
        await vectorless.retrieve({
          namespace: 'vl-e2e',
          queryText: 'BM25',
          retrievalStrategy: 'bm25',
          temporalAnchor: 1,
        })
      ).results.map((result) => result.id),
    ).toEqual(['a-1']);
    expect(await vectorless.getPendingIndexing('vl-e2e')).toEqual([]);

    await vectorless.upgradeNamespaceToVector('vl-e2e', { embeddingProvider: provider });
    expect((await vectorless.getStats('vl-e2e')).embeddingDimension).toBe(4);
    expect((await vectorless.getPendingIndexing('vl-e2e')).map((row) => row.id)).toEqual(['a-1']);

    const indexed = await vectorless.indexBatch([{ assertionId: 'a-1' }]);
    expect(indexed).toEqual({ indexed: 1, skipped: [] });
    expect(await vectorless.getPendingIndexing('vl-e2e')).toEqual([]);
    expect(
      (
        await vectorless.retrieve({
          namespace: 'vl-e2e',
          queryText: 'content',
          retrievalStrategy: 'hybrid',
          temporalAnchor: 1,
        })
      ).meta.vectorApplied,
    ).toBe(true);
    await vectorless.close();

    const reopened = await TragetiStore.create({
      database,
      namespace: 'vl-e2e',
      embeddingProvider: provider,
    });
    expect((await reopened.getStats('vl-e2e')).vectorReady).toBe(true);
    expect(await reopened.getPendingIndexing('vl-e2e')).toEqual([]);
    const reindexed = await reopened.reindexNamespace('vl-e2e');
    expect(reindexed.reindexed).toBe(1);
    expect((await reopened.getStats('vl-e2e')).indexedCount).toBe(1);
    await reopened.close();
  });

  it('getMissingIndexing does not require sqlite-vec when the vec0 table is absent', async () => {
    const store = await TragetiStore.create({
      database: ':memory:',
      namespace: 'missing-no-vec',
      embeddingDimension: 4,
      prepare: { loadSqliteVec: false },
    });
    await store.writeEpisode({
      id: 'ep-1',
      namespace: 'missing-no-vec',
      position: 1,
      occurredAt: '',
      type: 'doc',
      content: 'episode',
    });
    await store.writeAssertion({
      id: 'a-1',
      namespace: 'missing-no-vec',
      type: 'fact',
      content: 'not indexed yet',
      validFrom: 1,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [{ id: 'a-1:c0', episodeId: 'ep-1', sourceRef: 'self:a-1', excerpt: 'not indexed yet' }],
    });

    expect(await store.getMissingIndexing('missing-no-vec', ['a-1'])).toEqual([
      { id: 'a-1', content: 'not indexed yet' },
    ]);
    await store.close();
  });
});

describe('deleteNamespace extension cascade', () => {
  it('requires cascade for namespace-referencing extension tables and deletes only matching rows', async () => {
    const db = openTestDb();
    const store = new TragetiStore(db, {
      namespace: NS,
      embeddingDimension: 4,
      schemaExtensions: {
        tables: [
          {
            tableName: 'app_audit',
            createSQL: 'CREATE TABLE IF NOT EXISTS app_audit (id TEXT PRIMARY KEY, ns TEXT NOT NULL)',
            referencesNamespace: true,
            namespaceColumn: 'ns',
          },
        ],
      },
    });
    await store.init();
    db.prepare('INSERT INTO app_audit (id, ns) VALUES (?, ?), (?, ?)').run('same', NS, 'other', 'elsewhere');

    await expect(store.deleteNamespace(NS)).rejects.toThrow(ReferencedExtensionTableError);
    await store.deleteNamespace(NS, { cascade: true });

    const rows = db.prepare('SELECT id, ns FROM app_audit ORDER BY id').all() as Array<{
      id: string;
      ns: string;
    }>;
    expect(rows).toEqual([{ id: 'other', ns: 'elsewhere' }]);
  });
});
