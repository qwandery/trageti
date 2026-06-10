import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openTestDb } from '../helpers/openTestDb.js';
import { TragetiStore } from '../../src/store/TragetiStore.js';
import { loadScenario } from '../fixtures/scenario.js';

const NS = 'test-ns';
const DIM = 4;

describe('TragetiStore — getTemporalSnapshot', () => {
  let db: Database;
  let store: TragetiStore;

  beforeEach(async () => {
    db = openTestDb();
    store = new TragetiStore(db, { namespace: NS, embeddingDimension: DIM });
    await store.init();
    await loadScenario(store, NS);
  });

  it('returns only assertions valid at the requested position', async () => {
    const snap = await store.getTemporalSnapshot({ namespace: NS, atPosition: 1 });
    for (const a of snap) {
      expect(a.validFrom).toBeLessThanOrEqual(1);
    }
    expect(snap.map((a) => a.id)).not.toContain('a-3'); // validFrom=5
    expect(snap.map((a) => a.id)).not.toContain('a-5'); // validFrom=10
  });

  it('filters by entityTypes', async () => {
    const concepts = await store.getTemporalSnapshot({
      namespace: NS,
      atPosition: 10,
      entityTypes: ['concept'],
    });
    for (const a of concepts) {
      expect(a.entityType).toBe('concept');
    }
    // Scenario contains 'relationship' entityType (a-4) — must be filtered out
    expect(concepts.map((a) => a.id)).not.toContain('a-4');
  });

  it('filters by assertionTypes', async () => {
    const facts = await store.getTemporalSnapshot({
      namespace: NS,
      atPosition: 10,
      assertionTypes: ['fact'],
    });
    for (const a of facts) {
      expect(a.type).toBe('fact');
    }
    // Scenario contains 'update' (a-3, a-7) and 'pattern' (a-4) types — must be filtered out
    expect(facts.map((a) => a.id)).not.toContain('a-3');
    expect(facts.map((a) => a.id)).not.toContain('a-4');
  });

  it('combines entityTypes and assertionTypes filters', async () => {
    const filtered = await store.getTemporalSnapshot({
      namespace: NS,
      atPosition: 10,
      entityTypes: ['concept'],
      assertionTypes: ['fact'],
    });
    for (const a of filtered) {
      expect(a.entityType).toBe('concept');
      expect(a.type).toBe('fact');
    }
  });

  it('respects supersession at the snapshot position', async () => {
    // a-6 was superseded at position 5 — should be visible at pos 4, gone at pos 6
    const before = await store.getTemporalSnapshot({ namespace: NS, atPosition: 4 });
    expect(before.map((a) => a.id)).toContain('a-6');

    const after = await store.getTemporalSnapshot({ namespace: NS, atPosition: 6 });
    expect(after.map((a) => a.id)).not.toContain('a-6');
  });
});
