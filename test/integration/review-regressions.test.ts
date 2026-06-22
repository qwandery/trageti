import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider, Migration, RetrievalMiddleware } from '../../src/domain/types.js';
import { TragetiStore } from '../../src/store/TragetiStore.js';
import { RawVectorProvider } from '../../src/defaults/providers/RawVectorProvider.js';
import { MigrationRunner } from '../../src/db/migrations/runner.js';
import { namespaceToEmbeddingTable } from '../../src/internal/hash.js';
import { quoteIdent } from '../../src/internal/sql-ident.js';
import { assertVec0DimensionInvariant } from '../../src/internal/vector.js';
import {
  EmbeddingProviderError,
  ErrorCode,
  IndexingError,
  MigrationCompatibilityError,
  SchemaExtensionError,
  StoreClosedError,
  ValidationError,
} from '../../src/errors/index.js';
import { openTestDb } from '../helpers/openTestDb.js';
import { citationFor } from '../fixtures/scenario.js';

const DIM = 4;
const VEC = new Float32Array([1, 0, 0, 0]);

class DeferredProvider implements EmbeddingProvider {
  readonly name = 'deferred';
  readonly dimension = DIM;
  private resolveEmbed!: (vectors: Float32Array[]) => void;
  readonly started: Promise<void>;
  readonly done: Promise<Float32Array[]>;
  private markStarted!: () => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
    this.done = new Promise((resolve) => {
      this.resolveEmbed = resolve;
    });
  }

  resolve(vectors: Float32Array[]): void {
    this.resolveEmbed(vectors);
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.markStarted();
    const vectors = await this.done;
    return texts.map((_, index) => vectors[index] ?? VEC);
  }
}

class BadQueryProvider implements EmbeddingProvider {
  readonly name = 'bad-query';
  readonly dimension = DIM;

  async embed(): Promise<Float32Array[]> {
    return [new Float32Array([1, 0])];
  }
}

class BatchFallbackProvider implements EmbeddingProvider {
  readonly name = 'batch-fallback';
  readonly dimension = DIM;

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length > 1) throw new Error('batch failed');
    if (texts[0]?.includes('empty')) return [];
    return [new Float32Array([1, 0])];
  }
}

async function seedBasic(store: TragetiStore, namespace: string, ids = { episode: 'ep-1', assertion: 'a-1' }): Promise<void> {
  await store.writeEpisode({
    id: ids.episode,
    namespace,
    position: 1,
    occurredAt: '2024-01-01T00:00:00Z',
    type: 'document',
    content: `${namespace} episode`,
  });
  await store.writeAssertion({
    id: ids.assertion,
    namespace,
    type: 'fact',
    content: `${ids.assertion} searchable source`,
    validFrom: 1,
    validUntil: null,
    confidence: 1,
    sourceEpisodeId: ids.episode,
    supersedesId: null,
    entityId: ids.assertion,
    entityType: 'thing',
    citations: [citationFor(ids.assertion, ids.episode)],
  });
}

describe('v0.4.1 review regressions - lifecycle and errors', () => {
  it('close drains already-started provider indexing instead of rejecting it mid-flight', async () => {
    const db = openTestDb();
    const provider = new DeferredProvider();
    const store = new TragetiStore(db, { namespace: 'close-drain', embeddingDimension: DIM, embeddingProvider: provider });
    await store.init();
    await seedBasic(store, 'close-drain');

    const indexing = store.indexAssertion('a-1');
    await provider.started;
    const closing = store.close();
    provider.resolve([VEC]);

    await expect(indexing).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(namespaceToEmbeddingTable('close-drain'))}`).get(),
    ).toMatchObject({ c: 1 });
  });

  it('close marks the store closed even when cleanup hooks throw', async () => {
    const middleware: RetrievalMiddleware = {
      dispose: () => {
        throw Object.assign(new Error('dispose failed'), { code: 'DISPOSE_FAILED' });
      },
    };
    const store = await TragetiStore.create({
      database: ':memory:',
      namespace: 'close-error',
      middleware: [middleware],
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        flush: () => {
          throw Object.assign(new Error('flush failed'), { code: 'FLUSH_FAILED' });
        },
      },
    });

    await expect(store.close()).rejects.toMatchObject({ code: ErrorCode.STORE_CLOSED });
    await expect(store.getStats('close-error')).rejects.toThrow(StoreClosedError);
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('duplicate caller IDs surface typed ValidationError', async () => {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'dups' });
    await seedBasic(store, 'dups');

    await expect(
      store.writeEpisode({
        id: 'ep-1',
        namespace: 'dups',
        position: 2,
        occurredAt: '2024-01-02T00:00:00Z',
        type: 'document',
        content: 'duplicate episode',
      }),
    ).rejects.toThrow(ValidationError);

    await expect(
      store.writeAssertion({
        id: 'a-1',
        namespace: 'dups',
        type: 'fact',
        content: 'duplicate assertion',
        validFrom: 2,
        validUntil: null,
        confidence: 1,
        sourceEpisodeId: 'ep-1',
        supersedesId: null,
        entityId: null,
        entityType: null,
        citations: [citationFor('a-1', 'ep-1')],
      }),
    ).rejects.toThrow(ValidationError);

    await store.writeAssertion({
      id: 'a-2',
      namespace: 'dups',
      type: 'fact',
      content: 'second assertion',
      validFrom: 2,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-2', 'ep-1')],
    });
    await store.writeLink({
      id: 'l-1',
      namespace: 'dups',
      fromId: 'a-1',
      toId: 'a-2',
      linkType: 'related',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-1',
    });
    await expect(
      store.writeLink({
        id: 'l-1',
        namespace: 'dups',
        fromId: 'a-2',
        toId: 'a-1',
        linkType: 'related',
        validFrom: 1,
        validUntil: null,
        sourceEpisodeId: 'ep-1',
      }),
    ).rejects.toThrow(ValidationError);

    await store.writeCitation({
      id: 'c-1',
      assertionId: 'a-1',
      episodeId: 'ep-1',
      sourceRef: 'manual',
      excerpt: 'source',
    });
    await expect(
      store.writeCitation({
        id: 'c-1',
        assertionId: 'a-1',
        episodeId: 'ep-1',
        sourceRef: 'manual',
        excerpt: 'source',
      }),
    ).rejects.toThrow(ValidationError);
    await store.close();
  });
});

describe('v0.4.1 review regressions - temporal graph correctness', () => {
  async function graphStore(): Promise<TragetiStore> {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'graph' });
    await store.writeEpisode({
      id: 'ep-1',
      namespace: 'graph',
      position: 1,
      occurredAt: '',
      type: 'doc',
      content: 'graph',
    });
    for (const assertion of [
      { id: 'source', content: 'source searchable', validFrom: 1, validUntil: null },
      { id: 'valid', content: 'valid target', validFrom: 1, validUntil: null },
      { id: 'expired', content: 'expired target', validFrom: 1, validUntil: 3 },
      { id: 'future', content: 'future target', validFrom: 10, validUntil: null },
    ]) {
      await store.writeAssertion({
        namespace: 'graph',
        type: 'fact',
        confidence: 1,
        sourceEpisodeId: 'ep-1',
        supersedesId: null,
        entityId: assertion.id,
        entityType: 'node',
        citations: [citationFor(assertion.id, 'ep-1')],
        ...assertion,
      });
    }
    for (const toId of ['valid', 'expired', 'future']) {
      await store.writeLink({
        id: `l-${toId}`,
        namespace: 'graph',
        fromId: 'source',
        toId,
        linkType: 'related',
        validFrom: 1,
        validUntil: null,
        sourceEpisodeId: 'ep-1',
      });
    }
    return store;
  }

  it('getConnected excludes future and expired targets unless superseded history is requested', async () => {
    const store = await graphStore();
    const strict = await store.getConnected({
      namespace: 'graph',
      fromAssertionId: 'source',
      temporalAnchor: 5,
      maxDepth: 1,
    });
    expect(strict.map((a) => a.id)).toEqual(['valid']);

    const historical = await store.getConnected({
      namespace: 'graph',
      fromAssertionId: 'source',
      temporalAnchor: 5,
      maxDepth: 1,
      includeSuperseded: true,
    });
    expect(historical.map((a) => a.id).sort()).toEqual(['expired', 'valid']);
    await store.close();
  });

  it('retrieval graph expansion applies the same target validity rules', async () => {
    const store = await graphStore();
    const strict = await store.retrieve({
      namespace: 'graph',
      queryText: 'source',
      retrievalStrategy: 'bm25',
      temporalAnchor: 5,
      expandLinks: true,
    });
    expect(strict.results[0]?.linkedAssertions?.map((a) => a.id)).toEqual(['valid']);

    const historical = await store.retrieve({
      namespace: 'graph',
      queryText: 'source',
      retrievalStrategy: 'bm25',
      temporalAnchor: 5,
      expandLinks: true,
      includeSuperseded: true,
    });
    expect(historical.results[0]?.linkedAssertions?.map((a) => a.id).sort()).toEqual(['expired', 'valid']);
    await store.close();
  });

  it('findPath does not traverse invalid intermediate targets', async () => {
    const store = await graphStore();
    await store.writeAssertion({
      id: 'dest',
      namespace: 'graph',
      type: 'fact',
      content: 'destination target',
      validFrom: 1,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: 'dest',
      entityType: 'node',
      citations: [citationFor('dest', 'ep-1')],
    });
    await store.writeLink({
      id: 'l-future-dest',
      namespace: 'graph',
      fromId: 'future',
      toId: 'dest',
      linkType: 'related',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-1',
    });
    await expect(
      store.findPath({
        namespace: 'graph',
        fromAssertionId: 'source',
        toAssertionId: 'dest',
        temporalAnchor: 5,
        maxDepth: 2,
      }),
    ).resolves.toBeNull();
    await store.close();
  });
});

describe('v0.4.1 review regressions - migrations, locks, vectors, and extensions', () => {
  it('rejects future schema versions and unsupported FK-toggle migrations', () => {
    const db = openTestDb();
    const runner = new MigrationRunner();
    runner.applyMigrations(db);
    db.prepare('INSERT INTO trageti_schema_version (version, description) VALUES (?, ?)').run(99, 'future');
    expect(() => runner.applyMigrations(db)).toThrow(MigrationCompatibilityError);

    const db2 = openTestDb();
    const fkRunner = new MigrationRunner();
    const migrations = fkRunner.getMigrations();
    const testMigration: Migration = {
      version: migrations.length + 1,
      description: 'requires FK toggle',
      requiresForeignKeyToggle: true,
      up: () => {},
    };
    (fkRunner as unknown as { migrations: Migration[] }).migrations = [...migrations, testMigration];
    expect(() => fkRunner.applyMigrations(db2)).toThrow(MigrationCompatibilityError);
    db.close();
    db2.close();
  });

  it('clears locks by stale heartbeat, not stale acquisition time', async () => {
    const db = openTestDb();
    const store = new TragetiStore(db, { namespace: 'locks', embeddingDimension: DIM });
    await store.init();
    await seedBasic(store, 'locks');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    db.prepare(
      `INSERT INTO trageti_namespace_locks (namespace, operation, owner, acquired_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('locks', 'reindexNamespace', 'active-owner', old, fresh);

    await expect(
      store.writeEpisode({
        id: 'blocked',
        namespace: 'locks',
        position: 2,
        occurredAt: '',
        type: 'doc',
        content: 'blocked',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.NAMESPACE_OPERATION_LOCKED });

    db.prepare('UPDATE trageti_namespace_locks SET heartbeat_at = ? WHERE namespace = ?').run(old, 'locks');
    const result = await store.reindexNamespace('locks', {
      embeddingProvider: {
        name: 'static',
        dimension: DIM,
        embed: async (texts) => texts.map(() => VEC),
      },
    });
    expect(result.reindexed).toBe(1);
    await store.close();
  });

  it('rejects non-finite and provider-mismatched vectors before sqlite-vec use', async () => {
    const raw = new RawVectorProvider(DIM);
    expect(() => raw.set('bad', [Number.NaN, 0, 0, 0])).toThrow(EmbeddingProviderError);

    const store = await TragetiStore.create({ database: ':memory:', namespace: 'vectors', embeddingDimension: DIM });
    await seedBasic(store, 'vectors');
    await expect(store.indexAssertion('a-1', [Number.NaN, 0, 0, 0])).rejects.toThrow(IndexingError);
    await expect(
      store.retrieve({
        namespace: 'vectors',
        queryEmbedding: [Number.POSITIVE_INFINITY, 0, 0, 0],
        retrievalStrategy: 'vector',
        temporalAnchor: 1,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.RETRIEVAL_DIMENSION_MISMATCH });
    await store.close();

    const providerStore = await TragetiStore.create({
      database: ':memory:',
      namespace: 'provider',
      embeddingDimension: DIM,
      embeddingProvider: new BadQueryProvider(),
    });
    await seedBasic(providerStore, 'provider');
    await providerStore.indexAssertion('a-1', VEC);
    await expect(
      providerStore.retrieve({
        namespace: 'provider',
        queryText: 'source',
        retrievalStrategy: 'vector',
        temporalAnchor: 1,
      }),
    ).rejects.toThrow(EmbeddingProviderError);
    await providerStore.close();
  });

  it('rejects vector retrieval against vectorless namespaces before vector SQL', async () => {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'vectorless-retrieve' });
    await seedBasic(store, 'vectorless-retrieve');

    await expect(
      store.retrieve({
        namespace: 'vectorless-retrieve',
        queryEmbedding: VEC,
        retrievalStrategy: 'vector',
        temporalAnchor: 1,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.RETRIEVAL_NAMESPACE_VECTORLESS });
    await store.close();
  });

  it('records invalid batch provider vectors and reindex fallback skips without leaking to sqlite-vec', async () => {
    const provider: EmbeddingProvider = {
      name: 'bad-batch',
      dimension: DIM,
      embed: async () => [new Float32Array([1, 0])],
    };
    const store = await TragetiStore.create({
      database: ':memory:',
      namespace: 'batch-vectors',
      embeddingDimension: DIM,
      embeddingProvider: provider,
    });
    await seedBasic(store, 'batch-vectors');

    const supplied = await store.indexBatch([{ assertionId: 'a-1', embedding: [Number.NaN, 0, 0, 0] }], {
      onProviderError: 'skip',
    });
    expect(supplied.skipped).toEqual([
      expect.objectContaining({ assertionId: 'a-1', errorCode: 'EMBEDDING_INVALID' }),
    ]);

    const derived = await store.indexBatch([{ assertionId: 'a-1' }], { onProviderError: 'skip' });
    expect(derived.skipped).toEqual([
      expect.objectContaining({ assertionId: 'a-1', errorCode: 'EMBEDDING_DIMENSION_MISMATCH' }),
    ]);
    await store.close();

    const reindexStore = await TragetiStore.create({
      database: ':memory:',
      namespace: 'reindex-fallback',
      embeddingDimension: DIM,
    });
    await seedBasic(reindexStore, 'reindex-fallback', { episode: 'ep-1', assertion: 'a-empty' });
    await reindexStore.writeAssertion({
      id: 'a-invalid',
      namespace: 'reindex-fallback',
      type: 'fact',
      content: 'invalid vector row',
      validFrom: 2,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: 'a-invalid',
      entityType: 'thing',
      citations: [citationFor('a-invalid', 'ep-1')],
    });

    const result = await reindexStore.reindexNamespace('reindex-fallback', {
      embeddingProvider: new BatchFallbackProvider(),
      onProviderError: 'skip',
      allowPartialSwap: true,
      batchSize: 2,
    });
    expect(result.reindexed).toBe(0);
    expect(result.skipped.map((skip) => skip.errorCode).sort()).toEqual([
      'EMBEDDING_DIMENSION_MISMATCH',
      'EMBEDDING_PROVIDER_EMPTY',
    ]);
    await reindexStore.close();
  });

  it('guards vec0 dimension interpolation before DDL generation', () => {
    expect(() => assertVec0DimensionInvariant(0)).toThrow();
    expect(() => assertVec0DimensionInvariant(1.5)).toThrow();
    expect(() => assertVec0DimensionInvariant(DIM)).not.toThrow();
  });

  it('uses full-history position range and explicit active-only indexing scope', async () => {
    const provider: EmbeddingProvider = {
      name: 'static',
      dimension: DIM,
      embed: async (texts) => texts.map(() => VEC),
    };
    const store = await TragetiStore.create({
      database: ':memory:',
      namespace: 'indexing',
      embeddingDimension: DIM,
      embeddingProvider: provider,
    });
    await store.writeEpisode({
      id: 'ep-1',
      namespace: 'indexing',
      position: 1,
      occurredAt: '',
      type: 'doc',
      content: 'indexing',
    });
    await store.writeAssertion({
      id: 'old',
      namespace: 'indexing',
      type: 'fact',
      content: 'old',
      validFrom: 1,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: 'e',
      entityType: 'thing',
      citations: [citationFor('old', 'ep-1')],
    });
    await store.writeAssertion({
      id: 'new',
      namespace: 'indexing',
      type: 'fact',
      content: 'new',
      validFrom: 10,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-1',
      supersedesId: 'old',
      entityId: 'e',
      entityType: 'thing',
      citations: [citationFor('new', 'ep-1')],
    });

    expect((await store.getStats('indexing')).positionRange).toEqual({ min: 1, max: 10 });
    expect((await store.getPendingIndexing('indexing')).map((row) => row.id)).toEqual(['new']);
    expect((await store.getPendingIndexing('indexing', { includeSuperseded: true })).map((row) => row.id).sort()).toEqual([
      'new',
      'old',
    ]);
    expect((await store.getMissingIndexing('indexing', ['old', 'new'])).map((row) => row.id)).toEqual(['new']);
    expect(
      (await store.getMissingIndexing('indexing', ['old', 'new'], { includeSuperseded: true }))
        .map((row) => row.id)
        .sort(),
    ).toEqual([
      'new',
      'old',
    ]);

    expect((await store.reindexNamespace('indexing')).reindexed).toBe(2);
    expect((await store.getStats('indexing')).indexedCount).toBe(2);
    expect((await store.reindexNamespace('indexing', { includeSuperseded: false })).reindexed).toBe(1);
    expect((await store.getStats('indexing')).indexedCount).toBe(1);
    expect(
      (await store.getMissingIndexing('indexing', ['old', 'new'], { includeSuperseded: true })).map((row) => row.id),
    ).toEqual(['old']);
    await store.close();
  });

  it('returns [] for vectorless getMissingIndexing and updates namespace config explicitly', async () => {
    const store = await TragetiStore.create({ database: ':memory:', namespace: 'vectorless' });
    await seedBasic(store, 'vectorless');
    expect(await store.getMissingIndexing('vectorless', ['a-1'])).toEqual([]);
    await store.initNamespace('vectorless', { config: { owner: 'updated' } });
    expect((await store.initNamespace('vectorless')).config).toEqual({ owner: 'updated' });
    await store.close();
  });

  it('preserves mixed-case extension columns and rejects unsafe createSQL', async () => {
    const store = await TragetiStore.create({
      database: ':memory:',
      namespace: 'ext',
      schemaExtensions: {
        columns: [{ table: 'trageti_assertions', column: 'ReviewState', definition: "TEXT DEFAULT 'open'" }],
      },
    });
    await seedBasic(store, 'ext');
    expect((await store.getAssertions('ext'))[0]?.extensions['ReviewState']).toBe('open');
    await store.close();

    await expect(
      TragetiStore.create({
        database: ':memory:',
        namespace: 'bad-ext',
        schemaExtensions: {
          tables: [
            {
              tableName: 'app_notes',
              createSQL: 'CREATE TABLE IF NOT EXISTS app_notes (id TEXT); DROP TABLE trageti_assertions',
              referencesNamespace: false,
            },
          ],
        },
      }),
    ).rejects.toThrow(SchemaExtensionError);
  });

  it('keeps supersession chains namespace-bound even if data is tampered directly', async () => {
    const db = openTestDb();
    const store = new TragetiStore(db, { namespace: 'chain-a' });
    await store.init();
    await store.initNamespace('chain-b');
    await seedBasic(store, 'chain-a', { episode: 'ep-a', assertion: 'a-new' });
    await seedBasic(store, 'chain-b', { episode: 'ep-b', assertion: 'b-old' });
    db.prepare('UPDATE trageti_assertions SET supersedes_id = ? WHERE id = ?').run('b-old', 'a-new');

    const { results } = await store.retrieve({
      namespace: 'chain-a',
      queryText: 'searchable',
      retrievalStrategy: 'bm25',
      temporalAnchor: 1,
      mode: 'trajectory',
    });
    expect(results[0]?.id).toBe('a-new');
    expect(results[0]?.supersessionChain).toEqual([]);
    await store.close();
  });
});
