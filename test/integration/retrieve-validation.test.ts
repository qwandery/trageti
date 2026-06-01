import { describe, it, expect, beforeEach } from 'vitest';
import { openTestDb } from '../helpers/openTestDb.js';
import { TemporalStore } from '../../src/store/TemporalStore.js';
import { RetrievalInputError } from '../../src/errors/index.js';
import type { RetrievalScorer } from '../../src/domain/types.js';
import { citationFor } from '../fixtures/scenario.js';

const NS = 'rv';
const DIM = 4;

let store: TemporalStore;

beforeEach(async () => {
  store = new TemporalStore(openTestDb(), { namespace: NS, embeddingDimension: DIM });
  await store.init();
  await store.writeEpisode({
    id: 'ep-1',
    namespace: NS,
    position: 1,
    occurredAt: '2024-01-01T00:00:00Z',
    type: 'document',
    content: 'episode',
  });
  const mk = async (id: string, opts: { type: string; entityType: string | null; conf: number }) => {
    await store.writeAssertion({
      id,
      namespace: NS,
      type: opts.type,
      content: `assertion ${id} mentions foxes and badgers`,
      validFrom: 1,
      validUntil: null,
      confidence: opts.conf,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: opts.entityType,
      citations: [citationFor(id, 'ep-1')],
    });
  };
  await mk('a-1', { type: 'fact', entityType: 'concept', conf: 0.9 });
  await mk('a-2', { type: 'pattern', entityType: 'relationship', conf: 0.3 });
});

describe('retrieve input validation — typed RetrievalInputError codes', () => {
  it('RETRIEVAL_INPUT_EMPTY when neither queryText nor queryEmbedding is given', async () => {
    await expect(store.retrieve({ namespace: NS, temporalAnchor: 5 })).rejects.toThrow(RetrievalInputError);
  });

  it('RETRIEVAL_REQUIRES_QUERY_TEXT for bm25 strategy with no queryText', async () => {
    await expect(store.retrieve({ namespace: NS, retrievalStrategy: 'bm25', temporalAnchor: 5 })).rejects.toThrow(
      RetrievalInputError,
    );
  });

  it('RETRIEVAL_REQUIRES_VECTOR_INPUT for vector strategy with no embedding/provider', async () => {
    await expect(store.retrieve({ namespace: NS, retrievalStrategy: 'vector', temporalAnchor: 5 })).rejects.toThrow(
      RetrievalInputError,
    );
  });

  it('RETRIEVAL_INVALID_LIMIT for a non-positive-integer limit', async () => {
    await expect(store.retrieve({ namespace: NS, queryText: 'foxes', limit: 0, temporalAnchor: 5 })).rejects.toThrow(
      RetrievalInputError,
    );
    await expect(store.retrieve({ namespace: NS, queryText: 'foxes', limit: 2.5, temporalAnchor: 5 })).rejects.toThrow(
      RetrievalInputError,
    );
  });

  it('RETRIEVAL_INVALID_MAX_DEPTH for a negative maxDepth', async () => {
    await expect(
      store.retrieve({ namespace: NS, queryText: 'foxes', maxDepth: -1, temporalAnchor: 5 }),
    ).rejects.toThrow(RetrievalInputError);
  });

  it('accepts maxDepth: 0 (valid — no graph expansion)', async () => {
    const { results } = await store.retrieve({
      namespace: NS,
      queryText: 'foxes',
      retrievalStrategy: 'bm25',
      maxDepth: 0,
      temporalAnchor: 5,
    });
    expect(results.length).toBeGreaterThan(0);
  });

  it('RETRIEVAL_DIMENSION_MISMATCH when queryEmbedding length ≠ namespace dimension', async () => {
    await expect(
      store.retrieve({
        namespace: NS,
        queryEmbedding: new Float32Array([1, 0, 0]),
        temporalAnchor: 5,
      }),
    ).rejects.toThrow(RetrievalInputError);
  });

  it('rejects a temporalWindow whose from exceeds to', async () => {
    await expect(
      store.retrieve({
        namespace: NS,
        queryText: 'foxes',
        temporalWindow: { from: 10, to: 1 },
        temporalAnchor: 5,
      }),
    ).rejects.toThrow(RetrievalInputError);
  });

  it('rejects a minConfidence outside [0, 1]', async () => {
    await expect(
      store.retrieve({ namespace: NS, queryText: 'foxes', minConfidence: 2, temporalAnchor: 5 }),
    ).rejects.toThrow(RetrievalInputError);
  });

  it('SCORER_INVALID_OUTPUT when a scorer returns a non-finite score', async () => {
    const nanScorer: RetrievalScorer = { score: () => Number.NaN };
    await expect(
      store.retrieve({
        namespace: NS,
        queryText: 'foxes',
        retrievalStrategy: 'bm25',
        scorer: nanScorer,
        temporalAnchor: 5,
      }),
    ).rejects.toThrow(RetrievalInputError);
  });

  it('fts5 mode surfaces a malformed FTS5 query as RetrievalInputError', async () => {
    await expect(
      store.retrieve({
        namespace: NS,
        queryText: 'foxes AND',
        retrievalStrategy: 'bm25',
        queryTextMode: 'fts5',
        temporalAnchor: 5,
      }),
    ).rejects.toThrow(RetrievalInputError);
  });
});

describe('retrieve — runStep1 optional filters', () => {
  it('applies minConfidence, entityTypes and assertionTypes filters', async () => {
    const byConfidence = await store.retrieve({
      namespace: NS,
      queryText: 'foxes',
      retrievalStrategy: 'bm25',
      minConfidence: 0.5,
      temporalAnchor: 5,
    });
    expect(byConfidence.results.map((r) => r.id)).toEqual(['a-1']);

    const byEntityType = await store.retrieve({
      namespace: NS,
      queryText: 'foxes',
      retrievalStrategy: 'bm25',
      entityTypes: ['relationship'],
      temporalAnchor: 5,
    });
    expect(byEntityType.results.map((r) => r.id)).toEqual(['a-2']);

    const byAssertionType = await store.retrieve({
      namespace: NS,
      queryText: 'foxes',
      retrievalStrategy: 'bm25',
      assertionTypes: ['fact'],
      temporalAnchor: 5,
    });
    expect(byAssertionType.results.map((r) => r.id)).toEqual(['a-1']);
  });

  it('applies a temporalWindow filter', async () => {
    const { results } = await store.retrieve({
      namespace: NS,
      queryText: 'foxes',
      retrievalStrategy: 'bm25',
      temporalWindow: { from: 1, to: 1 },
      temporalAnchor: 5,
    });
    expect(results.length).toBe(2);
  });

  it('returns an empty result set when no candidate matches the query text', async () => {
    const { results, meta } = await store.retrieve({
      namespace: NS,
      queryText: 'zzznevermatchanything',
      retrievalStrategy: 'bm25',
      temporalAnchor: 5,
    });
    expect(results).toHaveLength(0);
    expect(meta.candidateCount).toBe(0);
  });
});

describe('retrieve — RetrievalDebug onStep hook', () => {
  it('invokes onStep for each retrieval step', async () => {
    const steps: string[] = [];
    await store.retrieve({
      namespace: NS,
      queryText: 'foxes',
      retrievalStrategy: 'bm25',
      temporalAnchor: 5,
      debug: { onStep: (step) => steps.push(step) },
    });
    expect(steps).toContain('temporal-filter');
    expect(steps).toContain('keyword');
    expect(steps).toContain('rank');
  });

  it('a throwing onStep hook never breaks retrieval', async () => {
    const { results } = await store.retrieve({
      namespace: NS,
      queryText: 'foxes',
      retrievalStrategy: 'bm25',
      temporalAnchor: 5,
      debug: {
        onStep: () => {
          throw new Error('hook boom');
        },
      },
    });
    expect(results.length).toBeGreaterThan(0);
  });
});
