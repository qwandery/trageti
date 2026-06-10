import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TragetiStore } from '../../src/store/TragetiStore.js';
import { MockEmbeddingProvider } from '../../src/defaults/providers/MockEmbeddingProvider.js';
import {
  StoreClosedError,
  NamespaceNotInitializedError,
  NamespaceDimensionMismatchError,
} from '../../src/errors/index.js';
import { citationFor } from '../fixtures/scenario.js';

const tmpDirs: string[] = [];

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trageti-'));
  tmpDirs.push(dir);
  return join(dir, 'store.db');
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (!dir) continue;
    // A test that fails before close() leaves the SQLite file locked on
    // Windows; a leaked temp dir is harmless, so tolerate EBUSY.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp dir — safe to leak */
    }
  }
});

async function seedEpisodeAndAssertion(store: TragetiStore, ns: string): Promise<void> {
  await store.writeEpisode({
    id: 'ep-1',
    namespace: ns,
    position: 1,
    occurredAt: '2024-01-01T00:00:00Z',
    type: 'document',
    content: 'the quick brown fox',
  });
  await store.writeAssertion({
    id: 'a-1',
    namespace: ns,
    type: 'fact',
    content: 'the quick brown fox jumps',
    validFrom: 1,
    validUntil: null,
    confidence: 0.9,
    sourceEpisodeId: 'ep-1',
    supersedesId: null,
    entityId: 'fox',
    entityType: 'animal',
    citations: [citationFor('a-1', 'ep-1')],
  });
}

describe('TragetiStore.create() lifecycle', () => {
  it('create() on an in-memory database initialises a usable store', async () => {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'mem' });
    expect(await store.getCurrentSchemaVersion()).toBe(1);
    await store.close();
  });

  it('file-backed lifecycle: create → write → close → reopen → retrieve', async () => {
    const path = tmpDbPath();

    const writer = await TragetiStore.create({ database: path, namespace: 'fb' });
    await seedEpisodeAndAssertion(writer, 'fb');
    await writer.close();

    const reader = await TragetiStore.create({ database: path, namespace: 'fb' });
    const { results } = await reader.retrieve({
      namespace: 'fb',
      queryText: 'fox',
      retrievalStrategy: 'bm25',
      temporalAnchor: 1,
    });
    expect(results.map((r) => r.id)).toContain('a-1');
    await reader.close();
  });

  it('close() is idempotent and every subsequent call throws StoreClosedError', async () => {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'closed' });
    await store.close();
    await store.close(); // no-op, no throw
    await expect(store.getStats('closed')).rejects.toThrow(StoreClosedError);
    await expect(store.getCurrentSchemaVersion()).rejects.toThrow(StoreClosedError);
  });
});

describe('TragetiStore migration introspection', () => {
  it('getMigrations() reports the v0.3 baseline descriptor', async () => {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'mig' });
    const migrations = await store.getMigrations();
    expect(migrations.map((m) => m.version)).toEqual([1]);
    expect(migrations.every((m) => typeof m.description === 'string')).toBe(true);
    expect(migrations[0]?.name).toBe('v001_baseline');
    expect(migrations[0]?.requiresForeignKeyToggle).toBe(false);
    expect(migrations[0]?.appliedAt).toEqual(expect.any(String));
    await store.close();
  });

  it('applyMigrations() is idempotent on an already-current database', async () => {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'mig' });
    await store.applyMigrations();
    expect(await store.getCurrentSchemaVersion()).toBe(1);
    await store.close();
  });
});

describe('TragetiStore read helpers', () => {
  it('getEpisode / getAssertions / getEntityHistory return persisted rows', async () => {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'read' });
    await seedEpisodeAndAssertion(store, 'read');

    expect((await store.getEpisode('ep-1'))?.content).toBe('the quick brown fox');
    expect(await store.getEpisode('missing')).toBeNull();

    const all = await store.getAssertions('read');
    expect(all.map((a) => a.id)).toEqual(['a-1']);

    const byEntity = await store.getEntityHistory('read', 'fox');
    expect(byEntity.map((a) => a.id)).toEqual(['a-1']);
    await store.close();
  });

  it('getStats and getPendingIndexing throw NamespaceNotInitializedError for an unknown namespace', async () => {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'known' });
    await expect(store.getStats('ghost')).rejects.toThrow(NamespaceNotInitializedError);
    await expect(store.getPendingIndexing('ghost')).rejects.toThrow(NamespaceNotInitializedError);
    await store.close();
  });
});

describe('TragetiStore initNamespace reopen matrix', () => {
  it('re-registering a vectorless namespace with no dimension is a no-op', async () => {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'base' });
    const first = await store.initNamespace('extra');
    expect(first.embeddingDimension).toBeNull();
    const second = await store.initNamespace('extra');
    expect(second.embeddingDimension).toBeNull();
    await store.close();
  });

  it('re-registering a vector namespace with the same dimension is a no-op', async () => {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'base' });
    await store.initNamespace('vec', { embeddingDimension: 4 });
    const again = await store.initNamespace('vec', { embeddingDimension: 4 });
    expect(again.embeddingDimension).toBe(4);
    await store.close();
  });

  it('re-registering a vector namespace with a different dimension throws', async () => {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'base' });
    await store.initNamespace('vec', { embeddingDimension: 4 });
    await expect(store.initNamespace('vec', { embeddingDimension: 8 })).rejects.toThrow(
      NamespaceDimensionMismatchError,
    );
    await store.close();
  });

  it('re-registering a vectorless namespace with a dimension throws NamespaceDimensionMismatchError', async () => {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'base' });
    await store.initNamespace('later-vec');
    let thrown: unknown;
    try {
      await store.initNamespace('later-vec', { embeddingDimension: 4 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NamespaceDimensionMismatchError);
    // Actionable: the message points at the correct upgrade path.
    expect((thrown as NamespaceDimensionMismatchError).message).toContain('upgradeNamespaceToVector');
    expect((thrown as NamespaceDimensionMismatchError).expected).toBeNull();
    await store.close();
  });

  it('getNamespaceProvider resolves the per-namespace binding over the store default', async () => {
    const storeDefault = new MockEmbeddingProvider({ dimension: 4 });
    const perNamespace = new MockEmbeddingProvider({ dimension: 4 });
    const store = await TragetiStore.create({
      database: ':memory:',
      namespace: 'base',
      embeddingProvider: storeDefault,
    });
    await store.initNamespace('bound', { embeddingDimension: 4, embeddingProvider: perNamespace });
    expect(store.getNamespaceProvider('bound')).toBe(perNamespace);
    expect(store.getNamespaceProvider('base')).toBe(storeDefault);
    await store.close();
  });
});

describe('TragetiStore.explain()', () => {
  it('reports a non-executing plan with routing flags for a bm25 query', async () => {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'exp' });
    await seedEpisodeAndAssertion(store, 'exp');
    const plan = await store.explain({
      namespace: 'exp',
      queryText: 'fox',
      retrievalStrategy: 'bm25',
      temporalAnchor: 1,
    });
    expect(plan.retrievalStrategy).toBe('bm25');
    expect(plan.wouldApplyVector).toBe(false);
    expect(plan.wouldApplyBm25).toBe(true);
    expect(plan.steps.some((s) => s.step === 'keyword')).toBe(true);
    await store.close();
  });

  it('flags vectorless namespaces as not applying vector retrieval', async () => {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'exp' });
    await seedEpisodeAndAssertion(store, 'exp');
    const plan = await store.explain({
      namespace: 'exp',
      queryEmbedding: new Float32Array([1, 0, 0, 0]),
      temporalAnchor: 1,
    });
    expect(plan.wouldApplyVector).toBe(false);
    expect(plan.notes.some((n) => n.includes('vectorless'))).toBe(true);
    await store.close();
  });
});
