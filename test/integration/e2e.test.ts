import { describe, it, expect } from 'vitest';
import { openTestDb } from '../helpers/openTestDb.js';
import { TemporalStore } from '../../src/store/TemporalStore.js';
import { loadScenario } from '../fixtures/scenario.js';
import { JsonFormatter } from '../../src/defaults/formatting/JsonFormatter.js';
import { citationFor } from '../fixtures/scenario.js';

const NS = 'e2e-ns';
const DIM = 4;

const VEC_A = new Float32Array([1, 0, 0, 0]);
const VEC_B = new Float32Array([0, 1, 0, 0]);

describe('e2e: init → write → index → retrieve → assemble → snapshot → graph', () => {
  it('full happy path', async () => {
    // ── 1. Setup ──────────────────────────────────────────────────────────────
    const db = openTestDb();
    const store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM });
    await store.init();

    // ── 2. Write episodes and assertions ─────────────────────────────────────
    await loadScenario(store, NS);

    // Verify writes
    const ep = await store.getEpisode('ep-1');
    expect(ep).not.toBeNull();
    expect(ep?.position).toBe(1);

    const assertions = await store.getAssertions(NS);
    expect(assertions.length).toBeGreaterThan(0);

    // ── 3. Index a subset ────────────────────────────────────────────────────
    await store.indexAssertion('a-1', VEC_A);
    await store.indexAssertion('a-2', VEC_B);
    await store.indexAssertion('a-3', VEC_A);
    await store.indexAssertion('a-4', VEC_B);
    await store.indexAssertion('a-5', VEC_A);

    expect((await store.getStats(NS)).indexedCount).toBe(5);

    // ── 4. Hybrid retrieve ───────────────────────────────────────────────────
    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: VEC_A,
      queryText: 'Alpha',
      temporalAnchor: 10,
      limit: 5,
    });
    expect(results.length).toBeGreaterThan(0);
    // All results should have scoreComponents
    for (const r of results) {
      expect(r.scoreComponents).toBeDefined();
      expect(typeof r.score).toBe('number');
    }

    // ── 5. Context assembly ──────────────────────────────────────────────────
    const ctx = await store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC_A,
      temporalAnchor: 10,
      tokenBudget: 10_000,
      formatter: new JsonFormatter(),
    });
    expect(ctx.text.length).toBeGreaterThan(0);
    expect(() => JSON.parse(ctx.text)).not.toThrow();
    expect(ctx.coverage.totalAssertions).toBeGreaterThan(0);
    expect(ctx.coverage.positionRange.from).toBeGreaterThanOrEqual(1);

    // ── 6. Temporal snapshot at past position ─────────────────────────────────
    const snapshot = await store.getTemporalSnapshot({
      namespace: NS,
      atPosition: 4,
    });
    // Only assertions with validFrom <= 4 should appear
    for (const a of snapshot) {
      expect(a.validFrom).toBeLessThanOrEqual(4);
    }
    // Assertions from episode 3 (validFrom=10) must not appear
    expect(snapshot.map((a) => a.id)).not.toContain('a-5');

    // ── 7. Graph expand ──────────────────────────────────────────────────────
    const connected = await store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-1',
      maxDepth: 2,
      temporalAnchor: 10,
    });
    expect(connected.map((a) => a.id)).toContain('a-2');

    // ── 8. findPath ───────────────────────────────────────────────────────────
    const path = await store.findPath({
      namespace: NS,
      fromAssertionId: 'a-1',
      toAssertionId: 'a-2',
      maxDepth: 2,
      temporalAnchor: 10,
    });
    expect(path).not.toBeNull();

    // ── 9. Supersede and verify history ──────────────────────────────────────
    await store.advanced.closeAssertion('a-1', { validUntil: 5 });
    const history = await store.getEntityHistory(NS, 'entity-alpha');
    const ids = history.map((a) => a.id);
    expect(ids).toContain('a-1');
    expect(ids).toContain('a-3');

    // ── 10. Stats ─────────────────────────────────────────────────────────────
    const stats = await store.getStats(NS);
    expect(stats.episodeCount).toBe(3);
    expect(stats.assertionCount).toBeGreaterThan(0);
    expect(stats.indexedCount).toBe(5);

    // ── 11. Delete namespace ──────────────────────────────────────────────────
    await store.deleteNamespace(NS);
    // Namespace is gone — assertions no longer accessible
    const nsAssertions = db
      .prepare<[string], { cnt: number }>('SELECT COUNT(*) AS cnt FROM trageti_assertions WHERE namespace = ?')
      .get(NS);
    expect(nsAssertions?.cnt).toBe(0);
  });

  it('multi-namespace isolation', async () => {
    const db = openTestDb();
    const ns1 = 'ns-one';
    const ns2 = 'ns-two';

    const store1 = new TemporalStore(db, { namespace: ns1, embeddingDimension: DIM });
    await store1.init();
    await store1.initNamespace(ns2);

    await store1.writeEpisode({
      id: 'ep-ns1',
      namespace: ns1,
      position: 1,
      occurredAt: '',
      type: 'doc',
      content: 'c',
    });
    await store1.writeEpisode({
      id: 'ep-ns2',
      namespace: ns2,
      position: 1,
      occurredAt: '',
      type: 'doc',
      content: 'c',
    });
    await store1.writeAssertion({
      id: 'a-ns1',
      namespace: ns1,
      type: 'fact',
      content: 'NS1 claim.',
      validFrom: 1,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-ns1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-ns1', 'ep-ns1')],
    });
    await store1.writeAssertion({
      id: 'a-ns2',
      namespace: ns2,
      type: 'fact',
      content: 'NS2 claim.',
      validFrom: 1,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-ns2',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-ns2', 'ep-ns2')],
    });

    const ns1Assertions = await store1.getAssertions(ns1);
    const ns2Assertions = await store1.getAssertions(ns2);

    expect(ns1Assertions.map((a) => a.id)).toContain('a-ns1');
    expect(ns1Assertions.map((a) => a.id)).not.toContain('a-ns2');
    expect(ns2Assertions.map((a) => a.id)).toContain('a-ns2');
    expect(ns2Assertions.map((a) => a.id)).not.toContain('a-ns1');
  });

  it('schema version is 1 after init (v0.3 baseline)', async () => {
    const db = openTestDb();
    const store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM });
    await store.init();
    expect(await store.getCurrentSchemaVersion()).toBe(1);
  });
});
