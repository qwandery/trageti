import { describe, it, expect, vi } from 'vitest';
import { openTestDb } from '../helpers/openTestDb.js';
import { TragetiStore } from '../../src/store/TragetiStore.js';
import type { EmbeddingProvider, RetrievalMiddleware, RetrievalQuery, RetrievedAssertion } from '../../src/domain/types.js';
import { citationFor } from '../fixtures/scenario.js';

const NS = 'test-ns';
const DIM = 4;
const VEC_A = new Float32Array([1, 0, 0, 0]);

class RecordingProvider implements EmbeddingProvider {
  readonly name = 'recording-provider';
  readonly dimension = DIM;
  readonly texts: string[] = [];

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.texts.push(...texts);
    return texts.map((text) => (text === 'rewritten query' ? VEC_A : new Float32Array([0, 1, 0, 0])));
  }
}

async function makeStoreWithMiddleware(middleware: RetrievalMiddleware[]): Promise<TragetiStore> {
  const db = openTestDb();
  const store = new TragetiStore(db, { namespace: NS, embeddingDimension: DIM, middleware });
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
    content: 'Test assertion alpha.',
    validFrom: 1,
    validUntil: null,
    confidence: 1,
    sourceEpisodeId: 'ep-1',
    supersedesId: null,
    entityId: null,
    entityType: null,
    citations: [citationFor('a-1', 'ep-1')],
  });
  await store.indexAssertion('a-1', VEC_A);
  return store;
}

describe('TragetiStore — middleware', () => {
  it('global before middleware is called before retrieval', async () => {
    const log: string[] = [];
    const mw: RetrievalMiddleware = {
      before: (q) => {
        log.push('global-before');
        return q;
      },
    };
    const store = await makeStoreWithMiddleware([mw]);
    await store.retrieve({ namespace: NS, queryEmbedding: VEC_A, temporalAnchor: 1 });
    expect(log).toContain('global-before');
  });

  it('global after middleware is called after retrieval', async () => {
    const log: string[] = [];
    const mw: RetrievalMiddleware = {
      after: (results) => {
        log.push('global-after');
        return results;
      },
    };
    const store = await makeStoreWithMiddleware([mw]);
    await store.retrieve({ namespace: NS, queryEmbedding: VEC_A, temporalAnchor: 1 });
    expect(log).toContain('global-after');
  });

  it('global before runs before per-call before', async () => {
    const order: string[] = [];
    const globalMw: RetrievalMiddleware = {
      before: (q) => {
        order.push('global-before');
        return q;
      },
    };
    const callMw: RetrievalMiddleware = {
      before: (q) => {
        order.push('call-before');
        return q;
      },
    };
    const store = await makeStoreWithMiddleware([globalMw]);
    await store.retrieve({
      namespace: NS,
      queryEmbedding: VEC_A,
      temporalAnchor: 1,
      middleware: [callMw],
    });
    expect(order.indexOf('global-before')).toBeLessThan(order.indexOf('call-before'));
  });

  it('per-call after runs before global after', async () => {
    const order: string[] = [];
    const globalMw: RetrievalMiddleware = {
      after: (r) => {
        order.push('global-after');
        return r;
      },
    };
    const callMw: RetrievalMiddleware = {
      after: (r) => {
        order.push('call-after');
        return r;
      },
    };
    const store = await makeStoreWithMiddleware([globalMw]);
    await store.retrieve({
      namespace: NS,
      queryEmbedding: VEC_A,
      temporalAnchor: 1,
      middleware: [callMw],
    });
    expect(order.indexOf('call-after')).toBeLessThan(order.indexOf('global-after'));
  });

  it('before middleware can mutate the query', async () => {
    const mw: RetrievalMiddleware = {
      // v0.3: limit=0 is rejected by RETRIEVAL_INVALID_LIMIT validation.
      before: (q: RetrievalQuery) => ({ ...q, limit: 1 }),
    };
    const store = await makeStoreWithMiddleware([mw]);
    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: VEC_A,
      temporalAnchor: 1,
    });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('before middleware rewrites queryText before provider-derived query embedding', async () => {
    const provider = new RecordingProvider();
    const mw: RetrievalMiddleware = {
      before: (q) => ({ ...q, queryText: 'rewritten query' }),
    };
    const db = openTestDb();
    const store = new TragetiStore(db, {
      namespace: NS,
      embeddingDimension: DIM,
      embeddingProvider: provider,
      middleware: [mw],
    });
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
      content: 'Test assertion alpha.',
      validFrom: 1,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-1', 'ep-1')],
    });
    await store.indexAssertion('a-1', VEC_A);

    await store.retrieve({ namespace: NS, queryText: 'original query', temporalAnchor: 1 });

    expect(provider.texts).toContain('rewritten query');
    expect(provider.texts).not.toContain('original query');
  });

  it('after middleware can filter results', async () => {
    const mw: RetrievalMiddleware = {
      after: (_results: RetrievedAssertion[]) => [],
    };
    const store = await makeStoreWithMiddleware([mw]);
    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: VEC_A,
      temporalAnchor: 1,
    });
    expect(results).toEqual([]);
  });

  it('after middleware receives results from the core pipeline', async () => {
    const captured: RetrievedAssertion[][] = [];
    const mw: RetrievalMiddleware = {
      after: (results: RetrievedAssertion[]) => {
        captured.push(results);
        return results;
      },
    };
    const store = await makeStoreWithMiddleware([mw]);
    await store.retrieve({ namespace: NS, queryEmbedding: VEC_A, temporalAnchor: 1 });
    expect(captured.length).toBe(1);
    expect(captured[0]?.length).toBeGreaterThan(0);
    expect(captured[0]?.[0]?.id).toBe('a-1');
  });

  it('multiple global middlewares run in registration order (before)', async () => {
    const order: string[] = [];
    const mw1: RetrievalMiddleware = {
      before: (q) => {
        order.push('mw1');
        return q;
      },
    };
    const mw2: RetrievalMiddleware = {
      before: (q) => {
        order.push('mw2');
        return q;
      },
    };
    const mw3: RetrievalMiddleware = {
      before: (q) => {
        order.push('mw3');
        return q;
      },
    };
    const db = openTestDb();
    const store = new TragetiStore(db, {
      namespace: NS,
      embeddingDimension: DIM,
      middleware: [mw1, mw2, mw3],
    });
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
      citations: [citationFor('a-1', 'ep-1')],
    });
    await store.indexAssertion('a-1', VEC_A);
    await store.retrieve({ namespace: NS, queryEmbedding: VEC_A, temporalAnchor: 1 });
    expect(order).toEqual(['mw1', 'mw2', 'mw3']);
  });

  it('multiple global middlewares run in reverse order (after)', async () => {
    const order: string[] = [];
    const mw1: RetrievalMiddleware = {
      after: (r) => {
        order.push('mw1');
        return r;
      },
    };
    const mw2: RetrievalMiddleware = {
      after: (r) => {
        order.push('mw2');
        return r;
      },
    };
    const mw3: RetrievalMiddleware = {
      after: (r) => {
        order.push('mw3');
        return r;
      },
    };
    const db = openTestDb();
    const store = new TragetiStore(db, {
      namespace: NS,
      embeddingDimension: DIM,
      middleware: [mw1, mw2, mw3],
    });
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
      citations: [citationFor('a-1', 'ep-1')],
    });
    await store.indexAssertion('a-1', VEC_A);
    await store.retrieve({ namespace: NS, queryEmbedding: VEC_A, temporalAnchor: 1 });
    expect(order).toEqual(['mw3', 'mw2', 'mw1']);
  });
});

// Suppress unused import
void vi;
