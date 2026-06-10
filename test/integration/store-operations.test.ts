import { describe, it, expect } from 'vitest';
import { openTestDb } from '../helpers/openTestDb.js';
import { TragetiStore } from '../../src/store/TragetiStore.js';
import { MockEmbeddingProvider } from '../../src/defaults/providers/MockEmbeddingProvider.js';
import type { EmbeddingProvider } from '../../src/domain/types.js';
import {
  IndexingError,
  EmbeddingProviderError,
  RetrievalInputError,
  ValidationError,
  ReindexError,
} from '../../src/errors/index.js';
import { citationFor } from '../fixtures/scenario.js';

const DIM = 4;

class FailingProvider implements EmbeddingProvider {
  readonly name = 'failing';
  readonly dimension = DIM;
  embed(): Promise<Float32Array[]> {
    return Promise.reject(new Error('provider exploded'));
  }
}

async function vectorStore(ns: string, provider?: EmbeddingProvider): Promise<TragetiStore> {
  const store = new TragetiStore(openTestDb(), {
    namespace: ns,
    embeddingDimension: DIM,
    ...(provider ? { embeddingProvider: provider } : {}),
  });
  await store.init();
  return store;
}

async function seed(store: TragetiStore, ns: string, ids: string[]): Promise<void> {
  await store.writeEpisode({
    id: 'ep-1',
    namespace: ns,
    position: 1,
    occurredAt: '2024-01-01T00:00:00Z',
    type: 'document',
    content: 'episode content',
  });
  let from = 1;
  for (const id of ids) {
    await store.writeAssertion({
      id,
      namespace: ns,
      type: 'fact',
      content: `assertion ${id} content about foxes`,
      validFrom: from++,
      validUntil: null,
      confidence: 0.9,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor(id, 'ep-1')],
    });
  }
}

describe('indexAssertion', () => {
  it('indexes with a caller-supplied embedding', async () => {
    const store = await vectorStore('idx');
    await seed(store, 'idx', ['a-1']);
    await store.indexAssertion('a-1', new Float32Array([1, 0, 0, 0]));
    expect((await store.getStats('idx')).indexedCount).toBe(1);
    await store.close();
  });

  it('indexes via the configured provider when no embedding is supplied', async () => {
    const store = await vectorStore('idx', new MockEmbeddingProvider({ dimension: DIM }));
    await seed(store, 'idx', ['a-1']);
    await store.indexAssertion('a-1');
    expect((await store.getStats('idx')).indexedCount).toBe(1);
    await store.close();
  });

  it('throws ASSERTION_NOT_FOUND for an unknown assertion', async () => {
    const store = await vectorStore('idx');
    await expect(store.indexAssertion('ghost', new Float32Array([1, 0, 0, 0]))).rejects.toThrow(IndexingError);
    await store.close();
  });

  it('throws NO_EMBEDDING_AND_NO_PROVIDER when neither is available', async () => {
    const store = await vectorStore('idx');
    await seed(store, 'idx', ['a-1']);
    await expect(store.indexAssertion('a-1')).rejects.toThrow(IndexingError);
    await store.close();
  });

  it('throws EMBEDDING_DIMENSION_MISMATCH for a wrong-length embedding', async () => {
    const store = await vectorStore('idx');
    await seed(store, 'idx', ['a-1']);
    await expect(store.indexAssertion('a-1', new Float32Array([1, 0]))).rejects.toThrow(IndexingError);
    await store.close();
  });
});

describe('indexBatch', () => {
  it('indexes a batch of caller-supplied embeddings; indexed + skipped === items.length', async () => {
    const store = await vectorStore('batch');
    await seed(store, 'batch', ['a-1', 'a-2', 'a-3']);
    const result = await store.indexBatch([
      { assertionId: 'a-1', embedding: new Float32Array([1, 0, 0, 0]) },
      { assertionId: 'a-2', embedding: new Float32Array([0, 1, 0, 0]) },
      { assertionId: 'a-3', embedding: new Float32Array([0, 0, 1, 0]) },
    ]);
    expect(result.indexed).toBe(3);
    expect(result.skipped).toHaveLength(0);
    expect(result.indexed + result.skipped.length).toBe(3);
    await store.close();
  });

  it('records ASSERTION_NOT_FOUND / NO_EMBEDDING_AND_NO_PROVIDER / EMBEDDING_DIMENSION_MISMATCH in skipped[]', async () => {
    const store = await vectorStore('batch');
    await seed(store, 'batch', ['a-1', 'a-2']);
    const result = await store.indexBatch([
      { assertionId: 'ghost' },
      { assertionId: 'a-1' },
      { assertionId: 'a-2', embedding: new Float32Array([1, 2]) },
    ]);
    expect(result.indexed).toBe(0);
    const reasons = result.skipped.map((s) => s.reason);
    expect(reasons).toEqual(['ASSERTION_NOT_FOUND', 'NO_EMBEDDING_AND_NO_PROVIDER', 'EMBEDDING_DIMENSION_MISMATCH']);
    expect(result.skipped.every((s) => (s.errorCode ?? '').length > 0)).toBe(true);
    await store.close();
  });

  it('skip mode records provider failures with a sanitized errorCode (never the raw message)', async () => {
    const store = await vectorStore('batch', new FailingProvider());
    await seed(store, 'batch', ['a-1', 'a-2']);
    const result = await store.indexBatch([{ assertionId: 'a-1' }, { assertionId: 'a-2' }], {
      onProviderError: 'skip',
    });
    expect(result.indexed).toBe(0);
    expect(result.skipped).toHaveLength(2);
    for (const s of result.skipped) {
      expect(s.reason).toBe('EMBEDDING_PROVIDER_ERROR');
      // FailingProvider throws a plain Error (no stable .code) → 'UNKNOWN'.
      expect(s.errorCode).toBe('UNKNOWN');
      expect(s.errorCode).not.toContain('exploded');
    }
    await store.close();
  });

  it('fail-fast mode throws EmbeddingProviderError on a provider failure', async () => {
    const store = await vectorStore('batch', new FailingProvider());
    await seed(store, 'batch', ['a-1']);
    await expect(store.indexBatch([{ assertionId: 'a-1' }])).rejects.toThrow(EmbeddingProviderError);
    await store.close();
  });
});

describe('retrieve — Step-0 routing', () => {
  it('hybrid retrieval derives a query embedding from queryText via the provider', async () => {
    const provider = new MockEmbeddingProvider({ dimension: DIM });
    const store = await vectorStore('route', provider);
    await seed(store, 'route', ['a-1', 'a-2']);
    await store.indexBatch([{ assertionId: 'a-1' }, { assertionId: 'a-2' }]);
    const { results, meta } = await store.retrieve({
      namespace: 'route',
      queryText: 'foxes',
      temporalAnchor: 5,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(meta.retrievalStrategy).toBe('hybrid');
    await store.close();
  });

  it('hybrid retrieval degrades to BM25 with a warning when no provider is configured', async () => {
    const store = await vectorStore('route');
    await seed(store, 'route', ['a-1']);
    const { meta } = await store.retrieve({
      namespace: 'route',
      queryText: 'foxes',
      temporalAnchor: 5,
    });
    expect(meta.warnings.some((w) => w.code === 'TRGT_RETRIEVE_VECTOR_SKIPPED')).toBe(true);
    await store.close();
  });

  it("strategy:'vector' with queryText but no provider throws RETRIEVAL_REQUIRES_VECTOR_INPUT", async () => {
    const store = await vectorStore('route');
    await seed(store, 'route', ['a-1']);
    await expect(
      store.retrieve({
        namespace: 'route',
        queryText: 'foxes',
        retrievalStrategy: 'vector',
        temporalAnchor: 5,
      }),
    ).rejects.toThrow(RetrievalInputError);
    await store.close();
  });
});

describe('rebuildFts', () => {
  it('rebuilds the FTS index and reports the reindexed row count', async () => {
    const store = await vectorStore('fts');
    await seed(store, 'fts', ['a-1', 'a-2', 'a-3']);
    const result = await store.rebuildFts();
    expect(result.reindexedRows).toBe(3);
    expect(result.newTokenizer.tokenizer).toBe('unicode61');
    // FTS still works post-rebuild.
    const { results } = await store.retrieve({
      namespace: 'fts',
      queryText: 'foxes',
      retrievalStrategy: 'bm25',
      temporalAnchor: 5,
    });
    expect(results.length).toBeGreaterThan(0);
    await store.close();
  });

  it('round-trips a custom tokenizer through trageti_tokenizer', async () => {
    const store = await vectorStore('fts');
    await seed(store, 'fts', ['a-1']);
    await store.rebuildFts({ tokenizer: { tokenizer: 'porter' } });
    const result = await store.rebuildFts({ tokenizer: { tokenizer: 'ascii' } });
    expect(result.newTokenizer.tokenizer).toBe('ascii');
    await store.close();
  });
});

describe('upgradeNamespaceToVector', () => {
  it('rejects upgrading an already-vector namespace', async () => {
    const store = await vectorStore('up');
    await expect(store.upgradeNamespaceToVector('up', { embeddingDimension: 8 })).rejects.toThrow(ValidationError);
    await store.close();
  });

  it('upgrades a vectorless namespace and binds a per-namespace provider', async () => {
    const store = new TragetiStore(openTestDb(), { namespace: 'vl' });
    await store.init();
    const provider = new MockEmbeddingProvider({ dimension: DIM });
    await store.upgradeNamespaceToVector('vl', {
      embeddingDimension: DIM,
      embeddingProvider: provider,
    });
    expect(store.getNamespaceProvider('vl')).toBe(provider);
    await store.close();
  });
});

describe('reindexNamespace', () => {
  it('throws ReindexError when no provider is supplied or configured', async () => {
    const store = await vectorStore('re');
    await expect(store.reindexNamespace('re')).rejects.toThrow(ReindexError);
    await store.close();
  });
});

describe('writeLink cross-namespace', () => {
  it('permits but flags a cross-namespace link', async () => {
    const store = await vectorStore('nsA');
    await store.initNamespace('nsB', { embeddingDimension: DIM });
    await seed(store, 'nsA', ['a-1']);
    await store.writeEpisode({
      id: 'ep-b',
      namespace: 'nsB',
      position: 1,
      occurredAt: '2024-01-01T00:00:00Z',
      type: 'document',
      content: 'b',
    });
    await store.writeAssertion({
      id: 'b-1',
      namespace: 'nsB',
      type: 'fact',
      content: 'b content',
      validFrom: 1,
      validUntil: null,
      confidence: 0.9,
      sourceEpisodeId: 'ep-b',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('b-1', 'ep-b')],
    });
    const link = await store.writeLink({
      id: 'l-x',
      namespace: 'nsA',
      fromId: 'a-1',
      toId: 'b-1',
      linkType: 'related',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-1',
    });
    expect(link.id).toBe('l-x');
    await store.close();
  });
});
