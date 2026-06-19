import { describe, it, expect } from 'vitest';
import { openTestDb } from '../helpers/openTestDb.js';
import { TragetiStore } from '../../src/store/TragetiStore.js';
import { ErrorCode, IndexingError, RetrievalInputError, ReindexError, ValidationError } from '../../src/errors/index.js';
import type { EmbeddingProvider } from '../../src/domain/types.js';
import { citationFor } from '../fixtures/scenario.js';

const DIM = 4;

function expectCode(err: unknown, code: string): void {
  expect(err).toBeInstanceOf(Error);
  expect((err as { code?: string }).code).toBe(code);
}

async function expectRejectsCode(
  promise: Promise<unknown>,
  code: string,
  ctor?: new (...args: never[]) => Error,
): Promise<unknown> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeDefined();
  if (ctor) expect(thrown).toBeInstanceOf(ctor);
  expectCode(thrown, code);
  return thrown;
}

async function seed(store: TragetiStore, namespace: string): Promise<void> {
  await store.writeEpisode({
    id: 'ep-1',
    namespace,
    position: 1,
    occurredAt: '2024-01-01T00:00:00Z',
    type: 'document',
    content: 'episode body',
  });
  await store.writeAssertion({
    id: 'a-1',
    namespace,
    type: 'fact',
    content: 'needle assertion one',
    validFrom: 1,
    validUntil: null,
    confidence: 0.9,
    sourceEpisodeId: 'ep-1',
    supersedesId: null,
    entityId: 'entity-1',
    entityType: 'concept',
    citations: [citationFor('a-1', 'ep-1')],
  });
  await store.writeAssertion({
    id: 'a-2',
    namespace,
    type: 'fact',
    content: 'needle assertion two',
    validFrom: 1,
    validUntil: null,
    confidence: 0.8,
    sourceEpisodeId: 'ep-1',
    supersedesId: null,
    entityId: 'entity-2',
    entityType: 'concept',
    citations: [citationFor('a-2', 'ep-1')],
  });
}

describe('runtime public API boundary validation', () => {
  it('rejects invalid retrieval enums before Step 0 provider embedding', async () => {
    let providerCalls = 0;
    const provider: EmbeddingProvider = {
      name: 'spy-provider',
      dimension: DIM,
      embed: async () => {
        providerCalls++;
        throw new Error('provider should not be called');
      },
    };
    const store = new TragetiStore(openTestDb(), {
      namespace: 'rt',
      embeddingDimension: DIM,
      embeddingProvider: provider,
    });
    await store.init();
    await seed(store, 'rt');

    await expectRejectsCode(
      store.retrieve({
        namespace: 'rt',
        queryText: 'needle',
        retrievalStrategy: 'sideways' as unknown as 'hybrid',
        temporalAnchor: 1,
      }),
      ErrorCode.RETRIEVAL_INVALID_STRATEGY,
    );
    expect(providerCalls).toBe(0);
    await store.close();
  });

  it('rejects malformed retrieval mode, queryTextMode, anchors, and filter arrays with RetrievalInputError', async () => {
    const store = new TragetiStore(openTestDb(), { namespace: 'rt', embeddingDimension: DIM });
    await store.init();
    await seed(store, 'rt');

    const invalidQueries = [
      {
        query: { namespace: 'rt', queryText: 'needle', retrievalStrategy: 'bm25', mode: 'future', temporalAnchor: 1 },
        code: ErrorCode.RETRIEVAL_INVALID_MODE,
      },
      {
        query: {
          namespace: 'rt',
          queryText: 'needle',
          retrievalStrategy: 'bm25',
          queryTextMode: 'raw',
          temporalAnchor: 1,
        },
        code: ErrorCode.RETRIEVAL_INVALID_QUERY_TEXT_MODE,
      },
      {
        query: { namespace: 'rt', queryText: 'needle', retrievalStrategy: 'bm25', temporalAnchor: Number.NaN },
        code: ErrorCode.RETRIEVAL_INVALID_TEMPORAL_ANCHOR,
      },
      {
        query: {
          namespace: 'rt',
          queryText: 'needle',
          retrievalStrategy: 'bm25',
          temporalAnchor: 1,
          entityTypes: 'concept',
        },
        code: ErrorCode.RETRIEVAL_INVALID_FILTER,
      },
      {
        query: {
          namespace: 'rt',
          queryText: 'needle',
          retrievalStrategy: 'bm25',
          temporalAnchor: 1,
          assertionTypes: [1],
        },
        code: ErrorCode.RETRIEVAL_INVALID_FILTER,
      },
    ] as const;

    for (const { query, code } of invalidQueries) {
      await expectRejectsCode(
        store.retrieve(query as unknown as Parameters<TragetiStore['retrieve']>[0]),
        code,
        RetrievalInputError,
      );
    }
    await store.close();
  });

  it('shares retrieval validation with explain()', async () => {
    const store = new TragetiStore(openTestDb(), { namespace: 'rt', embeddingDimension: DIM });
    await store.init();
    await seed(store, 'rt');

    await expectRejectsCode(
      store.explain({
        namespace: 'rt',
        queryText: 'needle',
        retrievalStrategy: 'wrong' as unknown as 'hybrid',
        temporalAnchor: 1,
      }),
      ErrorCode.RETRIEVAL_INVALID_STRATEGY,
      RetrievalInputError,
    );
    await store.close();
  });

  it('validates snapshot, graph, and assertion-read runtime inputs', async () => {
    const store = new TragetiStore(openTestDb(), { namespace: 'rt', embeddingDimension: DIM });
    await store.init();
    await seed(store, 'rt');
    await store.writeLink({
      id: 'l-1',
      namespace: 'rt',
      fromId: 'a-1',
      toId: 'a-2',
      linkType: 'related',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-1',
    });

    await expectRejectsCode(
      store.getTemporalSnapshot({
        namespace: 'rt',
        atPosition: Number.POSITIVE_INFINITY,
      }),
      ErrorCode.RETRIEVAL_INVALID_TEMPORAL_ANCHOR,
    );
    await expectRejectsCode(
      store.getTemporalSnapshot({
        namespace: 'rt',
        atPosition: 1,
        entityTypes: 'concept',
      } as unknown as Parameters<TragetiStore['getTemporalSnapshot']>[0]),
      ErrorCode.RETRIEVAL_INVALID_FILTER,
    );
    await expectRejectsCode(
      store.getConnected({
        namespace: 'rt',
        fromAssertionId: 'a-1',
        temporalAnchor: 1,
        linkTypes: 'related',
      } as unknown as Parameters<TragetiStore['getConnected']>[0]),
      ErrorCode.RETRIEVAL_INVALID_FILTER,
    );
    await expectRejectsCode(
      store.getAssertions('rt', { validAt: Number.NaN }),
      ErrorCode.RETRIEVAL_INVALID_TEMPORAL_ANCHOR,
    );
    await store.close();
  });

  it('rejects invalid index/reindex modes with stable typed errors before provider work', async () => {
    const store = new TragetiStore(openTestDb(), { namespace: 'rt', embeddingDimension: DIM });
    await store.init();
    await seed(store, 'rt');

    await expectRejectsCode(
      store.indexBatch([{ assertionId: 'a-1' }], { onProviderError: 'continue' as unknown as 'skip' }),
      ErrorCode.INDEXING_INVALID_PROVIDER_ERROR_MODE,
      IndexingError,
    );
    await expectRejectsCode(
      store.reindexNamespace('rt', { strategy: 'copy' as unknown as 'in-place' }),
      ErrorCode.REINDEX_INVALID_STRATEGY,
      ReindexError,
    );
    await expectRejectsCode(
      store.reindexNamespace('rt', { onProviderError: 'continue' as unknown as 'skip' }),
      ErrorCode.REINDEX_INVALID_PROVIDER_ERROR_MODE,
      ReindexError,
    );
    await store.close();
  });

  it('wraps single index provider failures and validates missing link endpoints before SQLite', async () => {
    const provider: EmbeddingProvider = {
      name: 'throwing-provider',
      dimension: DIM,
      embed: async () => {
        const err = new Error('raw provider payload');
        (err as { code?: string }).code = 'REMOTE_SECRET';
        throw err;
      },
    };
    const store = new TragetiStore(openTestDb(), {
      namespace: 'rt',
      embeddingDimension: DIM,
      embeddingProvider: provider,
    });
    await store.init();
    await seed(store, 'rt');

    const indexErr = await expectRejectsCode(store.indexAssertion('a-1'), ErrorCode.EMBEDDING_PROVIDER_ERROR);
    expect((indexErr as Error).message).not.toContain('raw provider payload');
    await expect(
      store.writeLink({
        id: 'bad-link',
        namespace: 'rt',
        fromId: 'missing-from',
        toId: 'a-2',
        linkType: 'related',
        validFrom: 1,
        validUntil: null,
        sourceEpisodeId: 'ep-1',
      }),
    ).rejects.toThrow(ValidationError);
    await store.close();
  });
});
