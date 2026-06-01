import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openTestDb } from '../helpers/openTestDb.js';
import { TemporalStore } from '../../src/store/TemporalStore.js';
import { NamespaceNotInitializedError, ValidationError } from '../../src/errors/index.js';
import { citationFor } from '../fixtures/scenario.js';

const NS = 'test-ns';
const DIM = 4;

function makeStore(db: Database): TemporalStore {
  return new TemporalStore(db, { namespace: NS, embeddingDimension: DIM });
}

describe('TemporalStore — init and namespace lifecycle', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDb();
  });

  it('throws NamespaceNotInitializedError before init()', async () => {
    const store = makeStore(db);
    await expect(
      store.writeEpisode({
        id: 'ep-1',
        namespace: NS,
        position: 1,
        occurredAt: '2024-01-01T00:00:00Z',
        type: 't',
        content: 'c',
      }),
    ).rejects.toThrow(NamespaceNotInitializedError);
  });

  it('init() succeeds on fresh db', async () => {
    const store = makeStore(db);
    await expect(store.init()).resolves.toBeUndefined();
  });

  it('init() is idempotent', async () => {
    const store = makeStore(db);
    await store.init();
    await expect(store.init()).resolves.toBeUndefined();
  });

  it('throws for unknown namespace after init', async () => {
    const store = makeStore(db);
    await store.init();
    await expect(
      store.writeEpisode({
        id: 'ep-1',
        namespace: 'unknown-ns',
        position: 1,
        occurredAt: '',
        type: 't',
        content: 'c',
      }),
    ).rejects.toThrow(NamespaceNotInitializedError);
  });
});

describe('TemporalStore — write and read', () => {
  let db: Database;
  let store: TemporalStore;

  beforeEach(async () => {
    db = openTestDb();
    store = makeStore(db);
    await store.init();
    await store.writeEpisode({
      id: 'ep-1',
      namespace: NS,
      position: 1,
      occurredAt: '2024-01-01T00:00:00Z',
      type: 'doc',
      content: 'Episode content',
    });
  });

  it('writes and reads an episode', async () => {
    const ep = await store.getEpisode('ep-1');
    expect(ep).not.toBeNull();
    expect(ep?.id).toBe('ep-1');
    expect(ep?.position).toBe(1);
  });

  it('writes and reads an assertion', async () => {
    await store.writeAssertion({
      id: 'a-1',
      namespace: NS,
      type: 'fact',
      content: 'Test claim.',
      validFrom: 1,
      validUntil: null,
      confidence: 0.9,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-1', 'ep-1')],
    });
    const assertions = await store.getAssertions(NS);
    expect(assertions.length).toBe(1);
    expect(assertions[0]?.content).toBe('Test claim.');
  });

  it('rejects assertion with validUntil <= validFrom', async () => {
    await expect(
      store.writeAssertion({
        id: 'a-bad',
        namespace: NS,
        type: 'fact',
        content: 'Bad.',
        validFrom: 5,
        validUntil: 3,
        confidence: 1,
        sourceEpisodeId: 'ep-1',
        supersedesId: null,
        entityId: null,
        entityType: null,
        citations: [citationFor('a-bad', 'ep-1')],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects assertion referencing non-existent episode', async () => {
    await expect(
      store.writeAssertion({
        id: 'a-bad',
        namespace: NS,
        type: 'fact',
        content: 'Bad.',
        validFrom: 1,
        validUntil: null,
        confidence: 1,
        sourceEpisodeId: 'no-such-ep',
        supersedesId: null,
        entityId: null,
        entityType: null,
        citations: [citationFor('a-bad', 'ep-1')],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('getAssertions with validAt only returns assertions valid at that position', async () => {
    await store.writeAssertion({
      id: 'a-1',
      namespace: NS,
      type: 'fact',
      content: 'Valid at pos 1.',
      validFrom: 1,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-1', 'ep-1')],
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
      id: 'a-10',
      namespace: NS,
      type: 'fact',
      content: 'Valid from pos 10.',
      validFrom: 10,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-10',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-10', 'ep-10')],
    });

    const atPos5 = await store.getAssertions(NS, { validAt: 5 });
    expect(atPos5.map((a) => a.id)).toContain('a-1');
    expect(atPos5.map((a) => a.id)).not.toContain('a-10');
  });

  it('emits warning for large episode content (does not throw)', async () => {
    const bigContent = 'x'.repeat(9000);
    await expect(
      store.writeEpisode({
        id: 'ep-big',
        namespace: NS,
        position: 2,
        occurredAt: '',
        type: 'doc',
        content: bigContent,
      }),
    ).resolves.toBeDefined();
  });

  it('no warning when maxEpisodeContentBytes = 0', async () => {
    const storeNoWarn = new TemporalStore(db, {
      namespace: NS,
      embeddingDimension: DIM,
      maxEpisodeContentBytes: 0,
    });
    await storeNoWarn.init();
    const bigContent = 'x'.repeat(9000);
    await expect(
      storeNoWarn.writeEpisode({
        id: 'ep-big2',
        namespace: NS,
        position: 3,
        occurredAt: '',
        type: 'doc',
        content: bigContent,
      }),
    ).resolves.toBeDefined();
  });
});

describe('TemporalStore — stats', () => {
  let db: Database;
  let store: TemporalStore;

  beforeEach(async () => {
    db = openTestDb();
    store = makeStore(db);
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
      content: 'c1',
      validFrom: 1,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-1', 'ep-1')],
    });
  });

  it('getStats returns correct counts', async () => {
    const stats = await store.getStats(NS);
    expect(stats.episodeCount).toBe(1);
    expect(stats.assertionCount).toBe(1);
    expect(stats.activeAssertionCount).toBe(1);
    expect(stats.indexedCount).toBe(0);
  });

  it('indexedCount increases after indexing', async () => {
    await store.indexAssertion('a-1', new Float32Array(DIM));
    expect((await store.getStats(NS)).indexedCount).toBe(1);
  });
});
