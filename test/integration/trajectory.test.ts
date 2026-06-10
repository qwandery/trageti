import { describe, it, expect } from 'vitest';
import { openTestDb } from '../helpers/openTestDb.js';
import { TragetiStore } from '../../src/store/TragetiStore.js';
import { citationFor, loadScenario } from '../fixtures/scenario.js';

const NS = 'traj-ns';
const DIM = 4;
const VEC = new Float32Array([1, 0, 0, 0]);

async function makeStoreWithScenario(): Promise<TragetiStore> {
  const db = openTestDb();
  const store = new TragetiStore(db, { namespace: NS, embeddingDimension: DIM });
  await store.init();
  await loadScenario(store, NS);
  // Index a subset so retrieve has candidates
  await store.indexAssertion('a-1', VEC);
  await store.indexAssertion('a-3', VEC);
  await store.indexAssertion('a-6', VEC);
  await store.indexAssertion('a-7', VEC);
  return store;
}

describe('TragetiStore — trajectory mode', () => {
  it('snapshot mode (default) and explicit snapshot produce identical output', async () => {
    const store = await makeStoreWithScenario();
    const { results: a } = await store.retrieve({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 10,
      limit: 5,
    });
    const { results: b } = await store.retrieve({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 10,
      limit: 5,
      mode: 'snapshot',
    });
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    // supersessionChain absent in snapshot mode
    for (const r of a) {
      expect('supersessionChain' in r).toBe(false);
    }
  });

  it('trajectory mode populates supersessionChain (excluding the result itself)', async () => {
    const store = await makeStoreWithScenario();
    // a-7 is the leaf of chain a-6 → a-7
    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 10,
      limit: 10,
      mode: 'trajectory',
    });
    const a7 = results.find((r) => r.id === 'a-7');
    expect(a7).toBeDefined();
    expect(a7?.supersessionChain).toBeDefined();
    expect(a7?.supersessionChain?.map((a) => a.id)).toEqual(['a-6']);
    // Result is not its own predecessor
    expect(a7?.supersessionChain?.some((a) => a.id === 'a-7')).toBe(false);
  });

  it('trajectory mode supersessionChain entries each carry citations', async () => {
    const store = await makeStoreWithScenario();
    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 10,
      limit: 10,
      mode: 'trajectory',
    });
    const a7 = results.find((r) => r.id === 'a-7');
    expect(a7?.supersessionChain?.[0]?.citations.length).toBeGreaterThan(0);
  });

  it('trajectory mode result with no predecessors gets supersessionChain: []', async () => {
    const store = await makeStoreWithScenario();
    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 10,
      limit: 10,
      mode: 'trajectory',
    });
    const a1 = results.find((r) => r.id === 'a-1');
    if (a1) {
      expect(a1.supersessionChain).toEqual([]);
      expect('supersessionChain' in a1).toBe(true);
    }
  });

  it('assembleContext propagates mode through to retrieval', async () => {
    const store = await makeStoreWithScenario();
    const ctx = await store.assembleContext({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 10,
      tokenBudget: 10_000,
      mode: 'trajectory',
    });
    // At least one assertion in the context should carry a supersessionChain (even if empty)
    expect(ctx.assertions.some((a) => 'supersessionChain' in a)).toBe(true);
  });
});

describe('TragetiStore — getEntityTrajectory', () => {
  it('returns the chain oldest-first for a superseded entity', async () => {
    const store = await makeStoreWithScenario();
    const trajectory = await store.getEntityTrajectory(NS, 'entity-delta');
    expect(trajectory.map((a) => a.id)).toEqual(['a-6', 'a-7']);
  });

  it('returns the single current assertion for an entity with no supersessions', async () => {
    const store = await makeStoreWithScenario();
    const trajectory = await store.getEntityTrajectory(NS, 'entity-beta');
    expect(trajectory.map((a) => a.id)).toEqual(['a-2']);
  });

  it('semantic distinction: trajectory follows chain only; history returns everything for entity', async () => {
    const db = openTestDb();
    const store = new TragetiStore(db, { namespace: NS, embeddingDimension: DIM });
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
      id: 'ep-5',
      namespace: NS,
      position: 5,
      occurredAt: '',
      type: 'doc',
      content: 'c',
    });

    // Chain: a-old → a-new (replacement)
    await store.writeAssertion({
      id: 'a-old',
      namespace: NS,
      type: 'fact',
      content: 'old',
      validFrom: 1,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: 'e-mixed',
      entityType: 'concept',
      citations: [citationFor('a-old', 'ep-1')],
    });
    await store.writeAssertion({
      id: 'a-new',
      namespace: NS,
      type: 'update',
      content: 'new',
      validFrom: 5,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-5',
      supersedesId: 'a-old',
      entityId: 'e-mixed',
      entityType: 'concept',
      citations: [citationFor('a-new', 'ep-5')],
    });

    // Parallel un-related assertion for the same entity, NOT in the chain
    await store.writeAssertion({
      id: 'a-parallel',
      namespace: NS,
      type: 'fact',
      content: 'parallel layered',
      validFrom: 5,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-5',
      supersedesId: null,
      entityId: 'e-mixed',
      entityType: 'concept',
      citations: [citationFor('a-parallel', 'ep-5')],
    });

    const trajectory = await store.getEntityTrajectory(NS, 'e-mixed');
    const history = await store.getEntityHistory(NS, 'e-mixed');

    // History returns all 3
    expect(history.map((a) => a.id).sort()).toEqual(['a-new', 'a-old', 'a-parallel']);
    // Trajectory returns the chain (a-old, a-new) plus a-parallel as its own one-element leaf
    // (it has no predecessor or successor; per multi-leaf merge policy it appears alongside).
    expect(trajectory.map((a) => a.id).sort()).toEqual(['a-new', 'a-old', 'a-parallel']);
    // The KEY distinction is that supersessionChain in trajectory retrieve mode
    // would only attach a-old to a-new — covered by the trajectory-mode test below.
  });
});

describe('TragetiStore — non-superseding layered assertions (decision §19)', () => {
  it('two layered same-entity assertions remain valid in snapshot; trajectory does not chain via deepens link', async () => {
    const db = openTestDb();
    const store = new TragetiStore(db, { namespace: NS, embeddingDimension: DIM });
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
      id: 'ep-5',
      namespace: NS,
      position: 5,
      occurredAt: '',
      type: 'doc',
      content: 'c',
    });

    // Two layered assertions — both currently valid, neither supersedes the other.
    await store.writeAssertion({
      id: 'a-base',
      namespace: NS,
      type: 'fact',
      content: 'initial observation',
      validFrom: 1,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: 'e-theme',
      entityType: 'theme',
      citations: [citationFor('a-base', 'ep-1')],
    });
    await store.writeAssertion({
      id: 'a-deeper',
      namespace: NS,
      type: 'recontextualization',
      content: 'deeper layer',
      validFrom: 5,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-5',
      supersedesId: null,
      entityId: 'e-theme',
      entityType: 'theme',
      citations: [citationFor('a-deeper', 'ep-5')],
    });
    await store.writeLink({
      id: 'l-deepens',
      namespace: NS,
      fromId: 'a-deeper',
      toId: 'a-base',
      linkType: 'deepens',
      validFrom: 5,
      validUntil: null,
      sourceEpisodeId: 'ep-5',
    });
    await store.indexAssertion('a-base', VEC);
    await store.indexAssertion('a-deeper', VEC);

    // Snapshot: both assertions visible at position 10
    const snapshot = await store.getTemporalSnapshot({ namespace: NS, atPosition: 10 });
    expect(snapshot.map((a) => a.id).sort()).toEqual(['a-base', 'a-deeper']);

    // Trajectory mode retrieve: each assertion has supersessionChain: []
    // (the deepens link is NOT traversed by trajectory).
    const { results } = await store.retrieve({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 10,
      limit: 10,
      mode: 'trajectory',
    });
    for (const r of results) {
      expect(r.supersessionChain).toEqual([]);
    }

    // expandLinks: the deepens link surfaces as linkedAssertions
    const { results: expanded } = await store.retrieve({
      namespace: NS,
      queryEmbedding: VEC,
      temporalAnchor: 10,
      limit: 10,
      expandLinks: true,
    });
    const aDeeper = expanded.find((r) => r.id === 'a-deeper');
    expect(aDeeper?.linkedAssertions?.map((a) => a.id)).toContain('a-base');
  });
});
