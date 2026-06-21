import { describe, it, expect } from 'vitest';
import { openTestDb } from '../helpers/openTestDb.js';
import { TragetiStore } from '../../src/store/TragetiStore.js';
import { MockEmbeddingProvider } from '../../src/defaults/providers/MockEmbeddingProvider.js';
import type { EmbeddingProvider, RetrievalMiddleware } from '../../src/domain/types.js';
import type { Logger } from '../../src/internal/logger.js';
import { EmbeddingProviderError, ErrorCode, IndexingError, ReindexError, ValidationError } from '../../src/errors/index.js';
import { citationFor } from '../fixtures/scenario.js';

const DIM = 4;

class EmptyProvider implements EmbeddingProvider {
  readonly name = 'empty';
  readonly dimension = DIM;
  embed(): Promise<Float32Array[]> {
    return Promise.resolve([]);
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
    content: 'episode',
  });
  let from = 1;
  for (const id of ids) {
    await store.writeAssertion({
      id,
      namespace: ns,
      type: 'fact',
      content: `assertion ${id}`,
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

describe('writeCitation — late citation', () => {
  it('inserts a late citation and warns when the excerpt is null', async () => {
    const store = await vectorStore('lc');
    await seed(store, 'lc', ['a-1']);
    const citation = await store.writeCitation({
      id: 'late-1',
      assertionId: 'a-1',
      episodeId: 'ep-1',
      sourceRef: 'chunk:9',
      excerpt: null,
    });
    expect(citation.id).toBe('late-1');
    await store.close();
  });

  it('rejects a late citation with strict requireCitationExcerpt and a null excerpt', async () => {
    const store = new TragetiStore(openTestDb(), {
      namespace: 'lcs',
      embeddingDimension: DIM,
      validation: { requireCitationExcerpt: true },
    });
    await store.init();
    // Strict mode also enforces excerpts on writeAssertion, so seed with a
    // citation that carries one.
    await store.writeEpisode({
      id: 'ep-1',
      namespace: 'lcs',
      position: 1,
      occurredAt: '2024-01-01T00:00:00Z',
      type: 'document',
      content: 'episode',
    });
    await store.writeAssertion({
      id: 'a-1',
      namespace: 'lcs',
      type: 'fact',
      content: 'assertion a-1',
      validFrom: 1,
      validUntil: null,
      confidence: 0.9,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [{ id: 'a-1:c0', episodeId: 'ep-1', sourceRef: 'chunk:1', excerpt: 'a real excerpt' }],
    });
    await expect(
      store.writeCitation({
        id: 'late-strict',
        assertionId: 'a-1',
        episodeId: 'ep-1',
        sourceRef: 'chunk:9',
        excerpt: null,
      }),
    ).rejects.toThrow(ValidationError);
    await store.close();
  });
});

describe('writeAssertion — structural invariants', () => {
  it('rejects a citation with an empty episodeId', async () => {
    const store = await vectorStore('si');
    await store.writeEpisode({
      id: 'ep-1',
      namespace: 'si',
      position: 1,
      occurredAt: '2024-01-01T00:00:00Z',
      type: 'document',
      content: 'e',
    });
    await expect(
      store.writeAssertion({
        id: 'a-bad',
        namespace: 'si',
        type: 'fact',
        content: 'c',
        validFrom: 1,
        validUntil: null,
        confidence: 0.9,
        sourceEpisodeId: 'ep-1',
        supersedesId: null,
        entityId: null,
        entityType: null,
        citations: [{ id: 'c0', episodeId: '', sourceRef: 'r', excerpt: null }],
      }),
    ).rejects.toThrow(ValidationError);
    await store.close();
  });

  it('rejects supersession across namespaces', async () => {
    const store = await vectorStore('nsA');
    await store.initNamespace('nsB', { embeddingDimension: DIM });
    await seed(store, 'nsA', ['a-1']);
    await store.writeEpisode({
      id: 'ep-b',
      namespace: 'nsB',
      position: 1,
      occurredAt: '2024-01-01T00:00:00Z',
      type: 'document',
      content: 'e',
    });
    await expect(
      store.writeAssertion({
        id: 'b-1',
        namespace: 'nsB',
        type: 'fact',
        content: 'c',
        validFrom: 5,
        validUntil: null,
        confidence: 0.9,
        sourceEpisodeId: 'ep-b',
        supersedesId: 'a-1',
        entityId: null,
        entityType: null,
        citations: [citationFor('b-1', 'ep-b')],
      }),
    ).rejects.toThrow(ValidationError);
    await store.close();
  });

  it('rejects a successor whose validFrom does not exceed the predecessor', async () => {
    const store = await vectorStore('si2');
    await seed(store, 'si2', ['a-1']);
    await expect(
      store.writeAssertion({
        id: 'a-2',
        namespace: 'si2',
        type: 'fact',
        content: 'c',
        validFrom: 1,
        validUntil: null,
        confidence: 0.9,
        sourceEpisodeId: 'ep-1',
        supersedesId: 'a-1',
        entityId: null,
        entityType: null,
        citations: [citationFor('a-2', 'ep-1')],
      }),
    ).rejects.toThrow(ValidationError);
    await store.close();
  });
});

describe('writeLink and deleteNamespace integrity', () => {
  it('rejects a sourceEpisodeId from another namespace', async () => {
    const store = await vectorStore('link-a');
    await store.initNamespace('link-b', { embeddingDimension: DIM });
    await seed(store, 'link-a', ['a-1']);
    await store.writeEpisode({
      id: 'ep-b',
      namespace: 'link-b',
      position: 1,
      occurredAt: '2024-01-01T00:00:00Z',
      type: 'document',
      content: 'episode',
    });
    await expect(
      store.writeLink({
        id: 'l-bad',
        namespace: 'link-a',
        fromId: 'a-1',
        toId: 'a-1',
        linkType: 'related',
        validFrom: 1,
        validUntil: null,
        sourceEpisodeId: 'ep-b',
      }),
    ).rejects.toThrow(ValidationError);
    await store.close();
  });

  it('deletes inbound cross-namespace links before deleting namespace rows', async () => {
    const store = await vectorStore('del-a');
    await store.initNamespace('del-b', { embeddingDimension: DIM });
    await seed(store, 'del-a', ['a-1']);
    await store.writeEpisode({
      id: 'ep-b',
      namespace: 'del-b',
      position: 1,
      occurredAt: '2024-01-01T00:00:00Z',
      type: 'document',
      content: 'episode',
    });
    await store.writeAssertion({
      id: 'b-1',
      namespace: 'del-b',
      type: 'fact',
      content: 'assertion b-1',
      validFrom: 1,
      validUntil: null,
      confidence: 0.9,
      sourceEpisodeId: 'ep-b',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('b-1', 'ep-b')],
    });
    await store.writeLink({
      id: 'cross',
      namespace: 'del-b',
      fromId: 'b-1',
      toId: 'a-1',
      linkType: 'related',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-b',
    });

    await expect(store.deleteNamespace('del-a')).resolves.toBeUndefined();
    await store.close();
  });
});

describe('indexAssertion / indexBatch provider edge cases', () => {
  it('indexBatch rejects batchSize: 0 before provider work', async () => {
    const provider = new MockEmbeddingProvider({ dimension: DIM });
    const store = await vectorStore('ib-batch', provider);
    await seed(store, 'ib-batch', ['a-1']);

    await expect(store.indexBatch([{ assertionId: 'a-1' }], { batchSize: 0 })).rejects.toThrow(ValidationError);
    await store.close();
  });

  it('indexAssertion throws when the provider returns no embedding', async () => {
    const store = await vectorStore('pe', new EmptyProvider());
    await seed(store, 'pe', ['a-1']);
    await expect(store.indexAssertion('a-1')).rejects.toThrow(IndexingError);
    await store.close();
  });

  it('indexBatch fail-fast throws EmbeddingProviderError when the provider returns no vectors', async () => {
    const store = await vectorStore('pe', new EmptyProvider());
    await seed(store, 'pe', ['a-1']);
    await expect(store.indexBatch([{ assertionId: 'a-1' }])).rejects.toThrow(EmbeddingProviderError);
    await store.close();
  });

  it('indexBatch skip mode records an empty-provider result in skipped[]', async () => {
    const store = await vectorStore('pe', new EmptyProvider());
    await seed(store, 'pe', ['a-1']);
    const result = await store.indexBatch([{ assertionId: 'a-1' }], { onProviderError: 'skip' });
    expect(result.indexed).toBe(0);
    expect(result.skipped[0]?.reason).toBe('EMBEDDING_PROVIDER_ERROR');
    await store.close();
  });

  it('indexBatch fail-fast aborts when the signal is already aborted', async () => {
    const store = await vectorStore('ab', new MockEmbeddingProvider({ dimension: DIM }));
    await seed(store, 'ab', ['a-1']);
    const controller = new AbortController();
    controller.abort();
    await expect(store.indexBatch([{ assertionId: 'a-1' }], { signal: controller.signal })).rejects.toThrow(
      EmbeddingProviderError,
    );
    await store.close();
  });

  it('indexBatch skip mode records ABORTED when the signal is already aborted', async () => {
    const store = await vectorStore('ab2', new MockEmbeddingProvider({ dimension: DIM }));
    await seed(store, 'ab2', ['a-1']);
    const controller = new AbortController();
    controller.abort();
    const result = await store.indexBatch([{ assertionId: 'a-1' }], {
      onProviderError: 'skip',
      signal: controller.signal,
    });
    expect(result.skipped[0]?.reason).toBe('ABORTED');
    await store.close();
  });
});

describe('reindexNamespace — failure paths', () => {
  it('throws ReindexError when the provider returns no vectors', async () => {
    const store = await vectorStore('rx');
    await seed(store, 'rx', ['a-1']);
    await expect(store.reindexNamespace('rx', { embeddingProvider: new EmptyProvider() })).rejects.toThrow(
      ReindexError,
    );
    await store.close();
  });

  it('throws ReindexError when the cancellation signal is already aborted', async () => {
    const store = await vectorStore('rx2');
    await seed(store, 'rx2', ['a-1']);
    const controller = new AbortController();
    controller.abort();
    await expect(
      store.reindexNamespace('rx2', {
        embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
        signal: controller.signal,
      }),
    ).rejects.toThrow(ReindexError);
    await store.close();
  });
});

describe('explain — vector routing', () => {
  it('does not report a vector step before the vec0 table exists', async () => {
    const store = await vectorStore('exv');
    await seed(store, 'exv', ['a-1']);
    const plan = await store.explain({
      namespace: 'exv',
      queryEmbedding: new Float32Array([1, 0, 0, 0]),
      temporalAnchor: 5,
    });
    expect(plan.wouldApplyVector).toBe(false);
    expect(plan.steps.some((s) => s.step === 'semantic')).toBe(false);
    await store.close();
  });

  it('reports a vector step once the vec0 table exists', async () => {
    const store = await vectorStore('exv2');
    await seed(store, 'exv2', ['a-1']);
    await store.indexAssertion('a-1', new Float32Array([1, 0, 0, 0]));
    const plan = await store.explain({
      namespace: 'exv2',
      queryEmbedding: new Float32Array([1, 0, 0, 0]),
      temporalAnchor: 5,
    });
    expect(plan.wouldApplyVector).toBe(true);
    expect(plan.steps.some((s) => s.step === 'semantic')).toBe(true);
    await store.close();
  });
});

describe('retrieve — vector readiness', () => {
  it('throws a public not-ready error for vector-only retrieval before the vec0 table exists', async () => {
    const store = await vectorStore('vr-vector', new MockEmbeddingProvider({ dimension: DIM }));
    await seed(store, 'vr-vector', ['a-1']);

    await expect(
      store.retrieve({
        namespace: 'vr-vector',
        queryText: 'assertion',
        temporalAnchor: 1,
        retrievalStrategy: 'vector',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.RETRIEVAL_VECTOR_INDEX_NOT_READY });
    await store.close();
  });

  it('falls back to BM25 with a warning for hybrid retrieval before the vec0 table exists', async () => {
    const store = await vectorStore('vr-hybrid', new MockEmbeddingProvider({ dimension: DIM }));
    await seed(store, 'vr-hybrid', ['a-1']);

    const result = await store.retrieve({
      namespace: 'vr-hybrid',
      queryText: 'assertion',
      temporalAnchor: 1,
      retrievalStrategy: 'hybrid',
    });

    expect(result.results.map((r) => r.id)).toContain('a-1');
    expect(result.meta.warnings).toContainEqual(
      expect.objectContaining({
        code: 'TRGT_RETRIEVE_VECTOR_SKIPPED',
        message: expect.stringContaining('VECTOR_INDEX_NOT_READY'),
      }),
    );
    await store.close();
  });
});

describe('close — middleware disposal and logger flush', () => {
  it('disposes middleware and flushes the logger on close', async () => {
    let disposed = false;
    let flushed = false;
    const middleware: RetrievalMiddleware = {
      dispose: () => {
        disposed = true;
      },
    };
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      flush: () => {
        flushed = true;
      },
    };
    const store = new TragetiStore(openTestDb(), {
      namespace: 'cl',
      embeddingDimension: DIM,
      middleware: [middleware],
      logger,
    });
    await store.init();
    await store.close();
    expect(disposed).toBe(true);
    expect(flushed).toBe(true);
  });
});

describe('prepareDatabase — custom pragmas', () => {
  it('applies caller-supplied pragmas through create()', async () => {
    const store = await TragetiStore.create({
      database: ':memory:',
      namespace: 'pg',
      prepare: { pragmas: { cache_size: -2000 } },
    });
    expect(await store.getCurrentSchemaVersion()).toBe(2);
    await store.close();
  });

  it('rejects unsafe pragma keys and foreign_keys overrides', async () => {
    await expect(
      TragetiStore.create({
        database: ':memory:',
        namespace: 'pg-bad',
        prepare: { pragmas: { 'cache_size; DROP TABLE x': 1 } },
      }),
    ).rejects.toThrow();

    await expect(
      TragetiStore.create({
        database: ':memory:',
        namespace: 'pg-fk',
        prepare: { pragmas: { foreign_keys: 'OFF' } },
      }),
    ).rejects.toThrow();
  });
});

describe('getPendingIndexing — vectorless namespace', () => {
  it('returns an empty list for a vectorless namespace', async () => {
    const store = new TragetiStore(openTestDb(), { namespace: 'vl' });
    await store.init();
    expect(await store.getPendingIndexing('vl')).toEqual([]);
    await store.close();
  });
});

describe('rebuildFts validation', () => {
  it('rejects batchSize: 0 before rebuilding FTS', async () => {
    const store = await vectorStore('fts-batch');
    await seed(store, 'fts-batch', ['a-1']);

    await expect(store.rebuildFts({ batchSize: 0 })).rejects.toThrow(ValidationError);

    const { results } = await store.retrieve({
      namespace: 'fts-batch',
      queryText: 'assertion',
      retrievalStrategy: 'bm25',
      temporalAnchor: 1,
    });
    expect(results.map((result) => result.id)).toContain('a-1');
    await store.close();
  });
});
