import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openTestDb } from '../helpers/openTestDb.js';
import { TemporalStore } from '../../src/store/TemporalStore.js';
import type { RetrievalScorer, ScoredCandidate, ScoringContext } from '../../src/domain/types.js';
import { citationFor } from '../fixtures/scenario.js';

const NS = 'test-ns';
const DIM = 4;

// Orthogonal unit vectors for deterministic cosine distances
const VEC_A = new Float32Array([1, 0, 0, 0]);
const VEC_B = new Float32Array([0, 1, 0, 0]);
const VEC_C = new Float32Array([0, 0, 1, 0]);
const QUERY_NEAR_A = new Float32Array([0.99, 0.14, 0, 0]); // much closer to A than B or C

describe('TemporalStore — semantic retrieval', () => {
  let db: Database;
  let store: TemporalStore;

  beforeEach(async () => {
    db = openTestDb();
    store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM });
    await store.init();
    await store.writeEpisode({
      id: 'ep-1',
      namespace: NS,
      position: 1,
      occurredAt: '2024-01-01T00:00:00Z',
      type: 'doc',
      content: 'ep1',
    });
    await store.writeEpisode({
      id: 'ep-5',
      namespace: NS,
      position: 5,
      occurredAt: '2024-01-05T00:00:00Z',
      type: 'doc',
      content: 'ep5',
    });
    await store.writeEpisode({
      id: 'ep-10',
      namespace: NS,
      position: 10,
      occurredAt: '2024-01-10T00:00:00Z',
      type: 'doc',
      content: 'ep10',
    });

    await store.writeAssertion({
      id: 'a-early',
      namespace: NS,
      type: 'fact',
      content: 'Alpha is the first item.',
      validFrom: 1,
      validUntil: null,
      confidence: 0.9,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-early', 'ep-1')],
    });
    await store.writeAssertion({
      id: 'a-mid',
      namespace: NS,
      type: 'fact',
      content: 'Beta is the second item.',
      validFrom: 5,
      validUntil: null,
      confidence: 0.85,
      sourceEpisodeId: 'ep-5',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-mid', 'ep-5')],
    });
    await store.writeAssertion({
      id: 'a-future',
      namespace: NS,
      type: 'fact',
      content: 'Gamma is a future item.',
      validFrom: 10,
      validUntil: null,
      confidence: 0.8,
      sourceEpisodeId: 'ep-10',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-future', 'ep-10')],
    });

    await store.indexAssertion('a-early', VEC_A);
    await store.indexAssertion('a-mid', VEC_B);
    await store.indexAssertion('a-future', VEC_C);
  });

  it('returns most semantically similar assertions at anchor', async () => {
    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: QUERY_NEAR_A,
      temporalAnchor: 5,
      limit: 3,
    });
    expect(results.length).toBeGreaterThan(0);
    // a-early (VEC_A) should be ranked first — nearest to QUERY_NEAR_A
    expect(results[0]?.id).toBe('a-early');
  });

  it('excludes assertions with validFrom > temporalAnchor', async () => {
    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: QUERY_NEAR_A,
      temporalAnchor: 5,
      limit: 10,
    });
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain('a-future');
    expect(ids).toContain('a-early');
    expect(ids).toContain('a-mid');
  });

  it('scoreComponents are always populated', async () => {
    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: QUERY_NEAR_A,
      temporalAnchor: 5,
      limit: 5,
    });
    for (const r of results) {
      expect(r.scoreComponents).toBeDefined();
      expect(typeof r.scoreComponents.semanticDistance).toBe('number');
      expect(typeof r.scoreComponents.position).toBe('number');
      // bm25Score is null when queryText not provided
      expect(r.scoreComponents.bm25Score).toBeNull();
    }
  });

  it('FTS5 path: queryText populates bm25Score in scoreComponents', async () => {
    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: QUERY_NEAR_A,
      queryText: 'Alpha',
      temporalAnchor: 5,
      limit: 5,
    });
    const withBm25 = results.filter((r) => r.scoreComponents.bm25Score !== null);
    expect(withBm25.length).toBeGreaterThan(0);
    // a-early contains "Alpha" — should have a BM25 score
    const aEarly = results.find((r) => r.id === 'a-early');
    expect(aEarly?.scoreComponents.bm25Score).not.toBeNull();
  });

  it('custom scorer override is used for ranking', async () => {
    // Scorer that ranks purely by position descending — opposite of semantic similarity
    // Default scorer would rank a-early (VEC_A ≈ QUERY) first; this scorer ranks a-mid (validFrom=5) first
    const customScorer = {
      score(candidate: ScoredCandidate, _ctx: ScoringContext): number {
        return candidate.position;
      },
    };
    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: QUERY_NEAR_A,
      temporalAnchor: 5,
      limit: 5,
      scorer: customScorer,
    });
    // a-mid has validFrom=5, a-early has validFrom=1 — custom scorer should rank a-mid first
    expect(results[0]?.id).toBe('a-mid');
  });

  it('limit is respected', async () => {
    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: QUERY_NEAR_A,
      temporalAnchor: 10,
      limit: 1,
    });
    expect(results.length).toBe(1);
  });

  it('returns empty array when no indexed assertions exist at anchor', async () => {
    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: QUERY_NEAR_A,
      temporalAnchor: 0,
      limit: 5,
    });
    expect(results).toEqual([]);
  });

  it('graph expansion attaches linked assertions', async () => {
    await store.writeLink({
      id: 'l-1',
      namespace: NS,
      fromId: 'a-early',
      toId: 'a-mid',
      linkType: 'related',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-1',
    });
    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: QUERY_NEAR_A,
      temporalAnchor: 5,
      limit: 5,
      expandLinks: true,
      maxDepth: 1,
    });
    const aEarly = results.find((r) => r.id === 'a-early');
    expect(aEarly?.linkedAssertions?.map((a) => a.id)).toContain('a-mid');
  });
});

describe('TemporalStore — retrieve returns typed RetrievedAssertion', () => {
  it('returned objects have all Assertion fields plus score and scoreComponents', async () => {
    const db = openTestDb();
    const store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM });
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
      content: 'Test.',
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

    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: VEC_A,
      temporalAnchor: 1,
      limit: 1,
    });
    expect(results.length).toBe(1);
    const r = results[0]!;
    expect(typeof r.score).toBe('number');
    expect(r.id).toBe('a-1');
    expect(r.content).toBe('Test.');
    expect(r.scoreComponents).toBeDefined();
  });
});

describe('TemporalStore — scoreBatch contract', () => {
  it('throws when scoreBatch returns wrong-length array', async () => {
    const db = openTestDb();
    const store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM });
    await store.init();
    await store.writeEpisode({
      id: 'ep-1',
      namespace: NS,
      position: 1,
      occurredAt: '',
      type: 'doc',
      content: 'c',
    });
    await store.writeEpisode({
      id: 'ep-2',
      namespace: NS,
      position: 2,
      occurredAt: '',
      type: 'doc',
      content: 'c',
    });
    await store.writeAssertion({
      id: 'a-1',
      namespace: NS,
      type: 'fact',
      content: 'one',
      validFrom: 1,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-1', 'ep-1')],
    });
    await store.writeAssertion({
      id: 'a-2',
      namespace: NS,
      type: 'fact',
      content: 'two',
      validFrom: 2,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-2',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-2', 'ep-2')],
    });
    await store.indexAssertion('a-1', VEC_A);
    await store.indexAssertion('a-2', new Float32Array([0.9, 0.44, 0, 0]));

    const broken: RetrievalScorer = {
      score: () => 0,
      scoreBatch: (candidates) => candidates.slice(0, 1).map(() => 0.5), // wrong length
    };

    await expect(
      store.retrieve({
        namespace: NS,
        queryEmbedding: VEC_A,
        temporalAnchor: 5,
        limit: 5,
        scorer: broken,
      }),
    ).rejects.toThrow(/scoreBatch returned/);
  });
});
