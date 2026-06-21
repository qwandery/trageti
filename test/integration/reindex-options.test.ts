import { describe, it, expect } from 'vitest';
import { openTestDb } from '../helpers/openTestDb.js';
import { TragetiStore } from '../../src/store/TragetiStore.js';
import { MockEmbeddingProvider } from '../../src/defaults/providers/MockEmbeddingProvider.js';
import type { EmbeddingProvider } from '../../src/domain/types.js';
import { ErrorCode, ReindexError } from '../../src/errors/index.js';
import { citationFor } from '../fixtures/scenario.js';

const DIM = 4;

/** Rejects for any text containing 'POISON'; deterministic vector otherwise. */
class FlakyProvider implements EmbeddingProvider {
  readonly name = 'flaky';
  readonly dimension = DIM;
  embed(texts: readonly string[]): Promise<Float32Array[]> {
    return Promise.resolve().then(() =>
      texts.map((t) => {
        if (t.includes('POISON')) throw new Error('cannot embed');
        return new Float32Array([1, 0, 0, 0]);
      }),
    );
  }
}

class DeferredProvider implements EmbeddingProvider {
  readonly name = 'deferred';
  readonly dimension = DIM;
  private release!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.release();
    await new Promise((resolve) => setTimeout(resolve, 25));
    return texts.map(() => new Float32Array([1, 0, 0, 0]));
  }
}

class PartialBatchProvider implements EmbeddingProvider {
  readonly name = 'partial-batch';
  readonly dimension = DIM;

  embed(): Promise<Float32Array[]> {
    return Promise.resolve([
      new Float32Array([1, 0, 0, 0]),
      undefined as unknown as Float32Array,
      new Float32Array([1, 0]),
    ]);
  }
}

async function vectorStore(ns: string): Promise<TragetiStore> {
  const store = new TragetiStore(openTestDb(), { namespace: ns, embeddingDimension: DIM });
  await store.init();
  return store;
}

async function seed(store: TragetiStore, ns: string, contents: Record<string, string>): Promise<void> {
  await store.writeEpisode({
    id: 'ep-1',
    namespace: ns,
    position: 1,
    occurredAt: '2024-01-01T00:00:00Z',
    type: 'document',
    content: 'episode',
  });
  let from = 1;
  for (const [id, content] of Object.entries(contents)) {
    await store.writeAssertion({
      id,
      namespace: ns,
      type: 'fact',
      content,
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

describe('reindexNamespace — staging-swap', () => {
  it('rejects batchSize: 0 before replacing the live index', async () => {
    const store = await vectorStore('rx');
    await seed(store, 'rx', { 'a-1': 'one', 'a-2': 'two' });
    await store.reindexNamespace('rx', {
      embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
    });
    const before = await store.getStats('rx');

    await expect(
      store.reindexNamespace('rx', {
        batchSize: 0,
        embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
      }),
    ).rejects.toThrow(ReindexError);

    expect((await store.getStats('rx')).indexedCount).toBe(before.indexedCount);
    await store.close();
  });

  it('rejects concurrent same-namespace reindex with a stable code', async () => {
    const store = await vectorStore('rx-lock');
    await seed(store, 'rx-lock', { 'a-1': 'one', 'a-2': 'two' });
    const provider = new DeferredProvider();
    const first = store.reindexNamespace('rx-lock', { embeddingProvider: provider });
    await provider.started;

    await expect(
      store.reindexNamespace('rx-lock', {
        embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.REINDEX_ALREADY_RUNNING });

    await first;
    await store.close();
  });

  it('persisted namespace locks block writes and fail-fast indexing, while skip-mode indexing records locked items', async () => {
    const db = openTestDb();
    const store = new TragetiStore(db, { namespace: 'rx-locked', embeddingDimension: DIM });
    await store.init();
    await seed(store, 'rx-locked', { 'a-1': 'one' });
    db.prepare(
      `INSERT INTO trageti_namespace_locks (namespace, operation, owner, acquired_at)
       VALUES (?, ?, ?, ?)`,
    ).run('rx-locked', 'reindexNamespace', 'owner-1', new Date().toISOString());

    await expect(
      store.writeEpisode({
        id: 'ep-locked',
        namespace: 'rx-locked',
        position: 2,
        occurredAt: '2024-01-02T00:00:00Z',
        type: 'document',
        content: 'locked',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.NAMESPACE_OPERATION_LOCKED });

    await expect(store.indexAssertion('a-1', new Float32Array([1, 0, 0, 0]))).rejects.toMatchObject({
      code: ErrorCode.NAMESPACE_OPERATION_LOCKED,
    });

    const skipped = await store.indexBatch([{ assertionId: 'a-1', embedding: new Float32Array([1, 0, 0, 0]) }], {
      onProviderError: 'skip',
    });
    expect(skipped.indexed).toBe(0);
    expect(skipped.skipped).toEqual([
      { assertionId: 'a-1', reason: ErrorCode.NAMESPACE_OPERATION_LOCKED, errorCode: ErrorCode.NAMESPACE_OPERATION_LOCKED },
    ]);

    await expect(store.deleteNamespace('rx-locked')).rejects.toMatchObject({
      code: ErrorCode.NAMESPACE_OPERATION_LOCKED,
    });
    await store.close();
  });

  it('cleans stale persisted namespace locks before acquiring a new lock', async () => {
    const db = openTestDb();
    const warnings: string[] = [];
    const store = new TragetiStore(db, {
      namespace: 'rx-stale',
      embeddingDimension: DIM,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (code) => warnings.push(code),
        error: () => {},
      },
    });
    await store.init();
    await seed(store, 'rx-stale', { 'a-1': 'one' });
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO trageti_namespace_locks (namespace, operation, owner, acquired_at)
       VALUES (?, ?, ?, ?)`,
    ).run('rx-stale', 'reindexNamespace', 'stale-owner', stale);

    const result = await store.reindexNamespace('rx-stale', {
      embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
    });

    expect(result.reindexed).toBe(1);
    expect(warnings).toContain('TRGT_NAMESPACE_LOCK_STALE_CLEARED');
    expect(db.prepare('SELECT COUNT(*) AS c FROM trageti_namespace_locks').get()).toMatchObject({ c: 0 });
    await store.close();
  });

  it('fail-fast success swaps and reports swappedAt', async () => {
    const store = await vectorStore('rx');
    await seed(store, 'rx', { 'a-1': 'one', 'a-2': 'two', 'a-3': 'three' });
    const result = await store.reindexNamespace('rx', {
      embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
    });
    expect(result.reindexed).toBe(3);
    expect(result.skipped).toHaveLength(0);
    expect(typeof result.swappedAt).toBe('string');
    expect((await store.getStats('rx')).indexedCount).toBe(3);
    await store.close();
  });

  it('skip mode with allowPartialSwap:false rejects the partial build', async () => {
    const store = await vectorStore('rx');
    await seed(store, 'rx', { 'a-1': 'ok', 'a-2': 'POISON', 'a-3': 'ok' });
    let thrown: unknown;
    try {
      await store.reindexNamespace('rx', {
        embeddingProvider: new FlakyProvider(),
        onProviderError: 'skip',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ReindexError);
    expect((thrown as ReindexError).code).toBe('REINDEX_PARTIAL_REJECTED');
    expect((thrown as ReindexError).skipped).toHaveLength(1);
    expect((thrown as ReindexError).advice).toBeDefined();
    // The live index was never created/swapped — the namespace is still unindexed.
    expect((await store.getStats('rx')).indexedCount).toBe(0);
    await store.close();
  });

  it('skip mode with allowPartialSwap:true swaps and returns skipped[]', async () => {
    const store = await vectorStore('rx');
    await seed(store, 'rx', { 'a-1': 'ok', 'a-2': 'POISON', 'a-3': 'ok' });
    const result = await store.reindexNamespace('rx', {
      embeddingProvider: new FlakyProvider(),
      onProviderError: 'skip',
      allowPartialSwap: true,
    });
    expect(result.reindexed).toBe(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.assertionId).toBe('a-2');
    expect(typeof result.swappedAt).toBe('string');
    expect((await store.getStats('rx')).indexedCount).toBe(2);
    await store.close();
  });

  it('skip mode records empty and wrong-dimension vectors returned in a successful batch', async () => {
    const store = await vectorStore('rx-partial-batch');
    await seed(store, 'rx-partial-batch', { 'a-1': 'ok', 'a-2': 'empty', 'a-3': 'wrong dimension' });

    const result = await store.reindexNamespace('rx-partial-batch', {
      embeddingProvider: new PartialBatchProvider(),
      onProviderError: 'skip',
      allowPartialSwap: true,
    });

    expect(result.reindexed).toBe(1);
    expect(result.skipped).toEqual([
      { assertionId: 'a-2', reason: 'EMBEDDING_PROVIDER_ERROR', errorCode: 'EMBEDDING_PROVIDER_EMPTY' },
      { assertionId: 'a-3', reason: 'EMBEDDING_DIMENSION_MISMATCH', errorCode: 'EMBEDDING_DIMENSION_MISMATCH' },
    ]);
    expect((await store.getStats('rx-partial-batch')).indexedCount).toBe(1);
    await store.close();
  });

  it('fail-fast aborts via a pre-aborted signal', async () => {
    const store = await vectorStore('rx');
    await seed(store, 'rx', { 'a-1': 'one' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      store.reindexNamespace('rx', {
        embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
        signal: controller.signal,
      }),
    ).rejects.toThrow(ReindexError);
    await store.close();
  });

  it('fail-fast surfaces a provider dimension mismatch as ReindexError', async () => {
    const store = await vectorStore('rx');
    await seed(store, 'rx', { 'a-1': 'one' });
    await expect(
      store.reindexNamespace('rx', {
        embeddingProvider: new MockEmbeddingProvider({ dimension: 2 }),
      }),
    ).rejects.toThrow(ReindexError);
    await store.close();
  });
});

describe('reindexNamespace — in-place', () => {
  it('writes directly into the live table with no swappedAt', async () => {
    const store = await vectorStore('rx');
    await seed(store, 'rx', { 'a-1': 'one', 'a-2': 'two' });
    const result = await store.reindexNamespace('rx', {
      strategy: 'in-place',
      embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
    });
    expect(result.reindexed).toBe(2);
    expect(result.swappedAt).toBeUndefined();
    expect((await store.getStats('rx')).indexedCount).toBe(2);
    await store.close();
  });

  it('with newDimension recreates the live table at the new dimension', async () => {
    const store = await vectorStore('rx');
    await seed(store, 'rx', { 'a-1': 'one', 'a-2': 'two' });
    const result = await store.reindexNamespace('rx', {
      strategy: 'in-place',
      newDimension: 8,
      embeddingProvider: new MockEmbeddingProvider({ dimension: 8 }),
    });
    expect(result.reindexed).toBe(2);
    expect(result.swappedAt).toBeUndefined();
    const stats = await store.getStats('rx');
    expect(stats.embeddingDimension).toBe(8);
    expect(stats.indexedCount).toBe(2);
    await store.close();
  });

  it('fail-fast leaves the namespace partially indexed on failure', async () => {
    const store = await vectorStore('rx');
    await seed(store, 'rx', { 'a-1': 'ok', 'a-2': 'POISON' });
    await expect(
      store.reindexNamespace('rx', {
        strategy: 'in-place',
        batchSize: 1,
        embeddingProvider: new FlakyProvider(),
      }),
    ).rejects.toThrow(ReindexError);
    // in-place does not roll back: the first assertion's embedding survives.
    expect((await store.getStats('rx')).indexedCount).toBe(1);
    await store.close();
  });
});
