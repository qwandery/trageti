import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from '../helpers/openTestDb.js'
import { TemporalStore } from '../../src/store/TemporalStore.js'
import { MockEmbeddingProvider } from '../../src/defaults/providers/MockEmbeddingProvider.js'
import type { EmbeddingProvider } from '../../src/domain/types.js'
import type { Logger, LogFields } from '../../src/internal/logger.js'
import {
  EmbeddingProviderError,
  IndexingError,
  NamespaceDimensionMismatchError,
  ReindexError,
  RetrievalInputError,
  SchemaExtensionError,
  TragetiError,
  ValidationError,
} from '../../src/errors/index.js'
import { citationFor } from '../fixtures/scenario.js'

const DIM = 4

class FailingProvider implements EmbeddingProvider {
  readonly name = 'failing'
  readonly dimension = DIM
  embed(): Promise<Float32Array[]> {
    return Promise.reject(new Error('provider down'))
  }
}

class EmptyProvider implements EmbeddingProvider {
  readonly name = 'empty'
  readonly dimension = DIM
  embed(): Promise<Float32Array[]> {
    return Promise.resolve([])
  }
}

class RecordingLogger implements Logger {
  readonly records: Array<{ level: string; code: string; fields: LogFields | undefined }> = []
  debug(code: string, fields?: LogFields): void {
    this.records.push({ level: 'debug', code, fields })
  }
  info(code: string, fields?: LogFields): void {
    this.records.push({ level: 'info', code, fields })
  }
  warn(code: string, fields?: LogFields): void {
    this.records.push({ level: 'warn', code, fields })
  }
  error(code: string, fields?: LogFields): void {
    this.records.push({ level: 'error', code, fields })
  }
}

const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (!dir) continue
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* temp dir — safe to leak */
    }
  }
})
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trageti-r7-'))
  tmpDirs.push(dir)
  return join(dir, 'store.db')
}

async function writeEpisode(store: TemporalStore, ns: string): Promise<void> {
  await store.writeEpisode({
    id: `ep-${ns}`,
    namespace: ns,
    position: 1,
    occurredAt: '2024-01-01T00:00:00Z',
    type: 'document',
    content: 'episode',
  })
}

async function writeAssertion(
  store: TemporalStore,
  ns: string,
  id: string,
  content: string,
  validFrom = 1,
): Promise<void> {
  await store.writeAssertion({
    id,
    namespace: ns,
    type: 'fact',
    content,
    validFrom,
    validUntil: null,
    confidence: 0.9,
    sourceEpisodeId: `ep-${ns}`,
    supersedesId: null,
    entityId: null,
    entityType: null,
    citations: [citationFor(id, `ep-${ns}`)],
  })
}

describe('Step-0 provider failures propagate as EmbeddingProviderError', () => {
  it('hybrid: a throwing provider rejects (no BM25 degrade)', async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      embeddingProvider: new FailingProvider(),
    })
    await store.init()
    await writeEpisode(store, 'ns')
    await writeAssertion(store, 'ns', 'a-1', 'content')
    await expect(
      store.retrieve({ namespace: 'ns', queryText: 'content', temporalAnchor: 5 }),
    ).rejects.toThrow(EmbeddingProviderError)
    await store.close()
  })

  it('hybrid: an empty-result provider rejects', async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      embeddingProvider: new EmptyProvider(),
    })
    await store.init()
    await writeEpisode(store, 'ns')
    await writeAssertion(store, 'ns', 'a-1', 'content')
    await expect(
      store.retrieve({ namespace: 'ns', queryText: 'content', temporalAnchor: 5 }),
    ).rejects.toThrow(EmbeddingProviderError)
    await store.close()
  })

  it("strategy 'vector' + queryText: a throwing provider rejects (no fallback path)", async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      embeddingProvider: new FailingProvider(),
    })
    await store.init()
    await writeEpisode(store, 'ns')
    await writeAssertion(store, 'ns', 'a-1', 'content')
    await expect(
      store.retrieve({
        namespace: 'ns',
        queryText: 'content',
        retrievalStrategy: 'vector',
        temporalAnchor: 5,
      }),
    ).rejects.toThrow(EmbeddingProviderError)
    await store.close()
  })

  it("strategy 'vector' + queryText: an empty-result provider rejects", async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      embeddingProvider: new EmptyProvider(),
    })
    await store.init()
    await writeEpisode(store, 'ns')
    await writeAssertion(store, 'ns', 'a-1', 'content')
    await expect(
      store.retrieve({
        namespace: 'ns',
        queryText: 'content',
        retrievalStrategy: 'vector',
        temporalAnchor: 5,
      }),
    ).rejects.toThrow(EmbeddingProviderError)
    await store.close()
  })
})

describe('per-namespace embedding providers drive indexing', () => {
  it('a namespace-bound provider indexes even when the store has none', async () => {
    const store = new TemporalStore(openTestDb(), { namespace: 'main', embeddingDimension: DIM })
    await store.init()
    await store.initNamespace('bound', {
      embeddingDimension: DIM,
      embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
    })
    await writeEpisode(store, 'bound')
    await writeAssertion(store, 'bound', 'b-1', 'bound content')
    // No embedding supplied — must use the namespace-bound provider.
    await store.indexAssertion('b-1')
    expect((await store.getStats('bound')).indexedCount).toBe(1)

    // 'main' has neither a supplied embedding nor any provider.
    await writeEpisode(store, 'main')
    await writeAssertion(store, 'main', 'm-1', 'main content')
    await expect(store.indexAssertion('m-1')).rejects.toThrow(IndexingError)
    await store.close()
  })

  it('indexBatch spanning namespaces uses each namespace its own provider', async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'A',
      embeddingDimension: DIM,
      embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
    })
    await store.init()
    await store.initNamespace('B', {
      embeddingDimension: DIM,
      embeddingProvider: new FailingProvider(),
    })
    await writeEpisode(store, 'A')
    await writeAssertion(store, 'A', 'a-1', 'alpha')
    await writeEpisode(store, 'B')
    await writeAssertion(store, 'B', 'b-1', 'beta')

    const result = await store.indexBatch([{ assertionId: 'a-1' }, { assertionId: 'b-1' }], {
      onProviderError: 'skip',
    })
    // A used its working provider; B used its own failing provider.
    expect(result.indexed).toBe(1)
    expect(result.skipped.map((s) => s.assertionId)).toEqual(['b-1'])
    await store.close()
  })
})

describe('hybrid retrieval — BM25 attaches to vector-selected candidates only', () => {
  it('a BM25-strong but vector-absent assertion is excluded from a hybrid result', async () => {
    const store = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM })
    await store.init()
    await writeEpisode(store, 'ns')
    await writeAssertion(store, 'ns', 'a-vec', 'alpha apple', 1)
    await writeAssertion(store, 'ns', 'a-text', 'beta keyword zebra', 2)
    // Only a-vec is indexed into the vector store.
    await store.indexAssertion('a-vec', new Float32Array([1, 0, 0, 0]))

    const hybrid = await store.retrieve({
      namespace: 'ns',
      queryEmbedding: new Float32Array([1, 0, 0, 0]),
      queryText: 'keyword',
      temporalAnchor: 5,
    })
    const hybridIds = hybrid.results.map((r) => r.id)
    expect(hybridIds).toContain('a-vec')
    // a-text matches the keyword but was never vector-selected.
    expect(hybridIds).not.toContain('a-text')

    // Under bm25 strategy Step 2 is skipped, so a-text is reachable.
    const bm25 = await store.retrieve({
      namespace: 'ns',
      queryText: 'keyword',
      retrievalStrategy: 'bm25',
      temporalAnchor: 5,
    })
    expect(bm25.results.map((r) => r.id)).toContain('a-text')
    await store.close()
  })
})

describe('explain() models Step-0 provider routing', () => {
  it('wouldApplyVector is true for queryText + bound provider + vector-ready namespace', async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
    })
    await store.init()
    await writeEpisode(store, 'ns')
    await writeAssertion(store, 'ns', 'a-1', 'content')
    const plan = await store.explain({ namespace: 'ns', queryText: 'content', temporalAnchor: 5 })
    expect(plan.wouldApplyVector).toBe(true)
    expect(plan.steps.some((s) => s.step === 'vector')).toBe(true)
    await store.close()
  })

  it('wouldApplyVector is false with a fallback note when no provider is configured', async () => {
    const store = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM })
    await store.init()
    await writeEpisode(store, 'ns')
    await writeAssertion(store, 'ns', 'a-1', 'content')
    const plan = await store.explain({ namespace: 'ns', queryText: 'content', temporalAnchor: 5 })
    expect(plan.wouldApplyVector).toBe(false)
    expect(plan.notes.some((n) => n.includes('NO_PROVIDER'))).toBe(true)
    await store.close()
  })

  it('wouldApplyVector is false with a vectorless note for a vectorless namespace', async () => {
    const store = new TemporalStore(openTestDb(), { namespace: 'ns' })
    await store.init()
    await writeEpisode(store, 'ns')
    await writeAssertion(store, 'ns', 'a-1', 'content')
    const plan = await store.explain({ namespace: 'ns', queryText: 'content', temporalAnchor: 5 })
    expect(plan.wouldApplyVector).toBe(false)
    expect(plan.notes.some((n) => n.includes('NAMESPACE_VECTORLESS'))).toBe(true)
    await store.close()
  })
})

describe('rebuildFts() preserves the stored tokenizer', () => {
  it('a no-tokenizer rebuild keeps the tokenizer recorded in the database', async () => {
    const db = openTestDb()
    const store1 = new TemporalStore(db, { namespace: 'ns', embeddingDimension: DIM })
    await store1.init()
    await store1.rebuildFts({ tokenizer: { tokenizer: 'porter' } })

    // Reopen the store with default options (default tokenizer is unicode61).
    const store2 = new TemporalStore(db, { namespace: 'ns', embeddingDimension: DIM })
    await store2.init()
    const result = await store2.rebuildFts()
    // The repair rebuild must preserve 'porter', not reset to the store default.
    expect(result.newTokenizer.tokenizer).toBe('porter')
    await store2.close()
  })
})

describe('getStats() emits TRGT_STATS_VEC_NOT_INTROSPECTED', () => {
  it('logs the diagnostic when a vec0 table exists but sqlite-vec is not loaded', async () => {
    const path = tmpDbPath()

    // Phase 1: with sqlite-vec, create and populate the vec0 table.
    const writer = await TemporalStore.create({
      database: path,
      namespace: 'ns',
      embeddingDimension: DIM,
    })
    await writeEpisode(writer, 'ns')
    await writeAssertion(writer, 'ns', 'a-1', 'content')
    await writer.indexAssertion('a-1', new Float32Array([1, 0, 0, 0]))
    await writer.close()

    // Phase 2: reopen the same file WITHOUT loading sqlite-vec.
    const plainDb = new Database(path)
    plainDb.pragma('journal_mode = WAL')
    plainDb.pragma('foreign_keys = ON')
    const logger = new RecordingLogger()
    const reader = new TemporalStore(plainDb, {
      namespace: 'ns',
      embeddingDimension: DIM,
      logger,
    })
    await reader.init()
    const stats = await reader.getStats('ns')
    expect(stats.vectorReady).toBe(false)
    expect(stats.indexedCount).toBe(0)
    expect(logger.records.some((r) => r.code === 'TRGT_STATS_VEC_NOT_INTROSPECTED')).toBe(true)
    await reader.close()
  })
})

describe('debug hook failures log a stable code, never a raw message', () => {
  it('records the thrown error code, or UNKNOWN for a plain Error', async () => {
    const logger = new RecordingLogger()
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      logger,
    })
    await store.init()
    await writeEpisode(store, 'ns')
    await writeAssertion(store, 'ns', 'a-1', 'content')

    await store.retrieve({
      namespace: 'ns',
      queryText: 'content',
      retrievalStrategy: 'bm25',
      temporalAnchor: 5,
      debug: {
        onStep: () => {
          throw new TragetiError('SOME_STABLE_CODE', 'secret message with content')
        },
      },
    })
    const hookErrors = logger.records.filter((r) => r.code === 'TRGT_RETRIEVAL_DEBUG_HOOK_ERROR')
    expect(hookErrors.length).toBeGreaterThan(0)
    for (const rec of hookErrors) {
      expect(rec.fields?.['errorCode']).toBe('SOME_STABLE_CODE')
      expect(rec.fields?.['error']).toBeUndefined()
      expect(JSON.stringify(rec.fields)).not.toContain('secret message')
    }

    await store.retrieve({
      namespace: 'ns',
      queryText: 'content',
      retrievalStrategy: 'bm25',
      temporalAnchor: 5,
      debug: {
        onStep: () => {
          throw new Error('plain error')
        },
      },
    })
    const plainHookErrors = logger.records.filter(
      (r) => r.code === 'TRGT_RETRIEVAL_DEBUG_HOOK_ERROR' && r.fields?.['errorCode'] === 'UNKNOWN',
    )
    expect(plainHookErrors.length).toBeGreaterThan(0)
    await store.close()
  })
})

describe('assembleContext() validates tokenBudget', () => {
  it('rejects a negative or non-finite tokenBudget', async () => {
    const store = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM })
    await store.init()
    await writeEpisode(store, 'ns')
    await writeAssertion(store, 'ns', 'a-1', 'content')
    await expect(
      store.assembleContext({
        namespace: 'ns',
        temporalAnchor: 5,
        queryText: 'content',
        retrievalStrategy: 'bm25',
        tokenBudget: -10,
      }),
    ).rejects.toThrow(RetrievalInputError)
    await expect(
      store.assembleContext({
        namespace: 'ns',
        temporalAnchor: 5,
        queryText: 'content',
        retrievalStrategy: 'bm25',
        tokenBudget: Number.NaN,
      }),
    ).rejects.toThrow(RetrievalInputError)
    await store.close()
  })
})

describe('maxDepth: 0 means no graph traversal', () => {
  async function graphStore(): Promise<TemporalStore> {
    const store = new TemporalStore(openTestDb(), { namespace: 'g', embeddingDimension: DIM })
    await store.init()
    await writeEpisode(store, 'g')
    await writeAssertion(store, 'g', 'a-1', 'first', 1)
    await writeAssertion(store, 'g', 'a-2', 'second', 2)
    await store.writeLink({
      id: 'l-1',
      namespace: 'g',
      fromId: 'a-1',
      toId: 'a-2',
      linkType: 'related',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-g',
    })
    return store
  }

  it('getConnected with maxDepth: 0 returns no links', async () => {
    const store = await graphStore()
    expect(
      await store.getConnected({
        namespace: 'g',
        fromAssertionId: 'a-1',
        maxDepth: 0,
        temporalAnchor: 5,
      }),
    ).toEqual([])
    // Sanity: maxDepth 1 reaches a-2.
    const reached = await store.getConnected({
      namespace: 'g',
      fromAssertionId: 'a-1',
      maxDepth: 1,
      temporalAnchor: 5,
    })
    expect(reached.map((a) => a.id)).toEqual(['a-2'])
    await store.close()
  })

  it('findPath with maxDepth: 0 returns null for distinct endpoints', async () => {
    const store = await graphStore()
    expect(
      await store.findPath({
        namespace: 'g',
        fromAssertionId: 'a-1',
        toAssertionId: 'a-2',
        maxDepth: 0,
        temporalAnchor: 5,
      }),
    ).toBeNull()
    await store.close()
  })

  it('retrieve expandLinks with maxDepth: 0 attaches no linked assertions', async () => {
    const store = await graphStore()
    const { results } = await store.retrieve({
      namespace: 'g',
      queryText: 'first',
      retrievalStrategy: 'bm25',
      expandLinks: true,
      maxDepth: 0,
      temporalAnchor: 5,
    })
    for (const r of results) {
      expect(r.linkedAssertions).toBeUndefined()
    }
    await store.close()
  })
})

describe('indexBatch skip-mode errorCode derives from the thrown error', () => {
  class CodedFailProvider implements EmbeddingProvider {
    readonly name = 'coded-fail'
    readonly dimension = DIM
    embed(): Promise<Float32Array[]> {
      return Promise.reject(new TragetiError('CUSTOM_PROVIDER_CODE', 'provider down'))
    }
  }

  it('uses the thrown TragetiError code as the skipped[] errorCode', async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      embeddingProvider: new CodedFailProvider(),
    })
    await store.init()
    await writeEpisode(store, 'ns')
    await writeAssertion(store, 'ns', 'a-1', 'content')
    const result = await store.indexBatch([{ assertionId: 'a-1' }], { onProviderError: 'skip' })
    expect(result.skipped[0]?.errorCode).toBe('CUSTOM_PROVIDER_CODE')
    await store.close()
  })
})

describe('namespaceColumn identifier validation', () => {
  it('rejects a reserved-word namespaceColumn', async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      schemaExtensions: {
        tables: [
          {
            tableName: 'app_audit',
            createSQL: 'CREATE TABLE IF NOT EXISTS app_audit (id TEXT PRIMARY KEY, "select" TEXT)',
            referencesNamespace: true,
            namespaceColumn: 'select',
          },
        ],
      },
    })
    await expect(store.init()).rejects.toThrow(SchemaExtensionError)
  })

  it('rejects a trageti_-prefixed namespaceColumn', async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      schemaExtensions: {
        tables: [
          {
            tableName: 'app_audit',
            createSQL:
              'CREATE TABLE IF NOT EXISTS app_audit (id TEXT PRIMARY KEY, trageti_ns TEXT)',
            referencesNamespace: true,
            namespaceColumn: 'trageti_ns',
          },
        ],
      },
    })
    await expect(store.init()).rejects.toThrow(SchemaExtensionError)
  })
})

describe('reindexNamespace never converts a vectorless namespace', () => {
  it('rejects reindex of a vectorless namespace even with newDimension', async () => {
    const store = new TemporalStore(openTestDb(), { namespace: 'vl' })
    await store.init()
    await expect(
      store.reindexNamespace('vl', {
        newDimension: DIM,
        embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
      }),
    ).rejects.toThrow(ReindexError)
    // The namespace is still vectorless — the upgrade path was not bypassed.
    expect((await store.getStats('vl')).embeddingDimension).toBeNull()
    await store.close()
  })
})

describe('dimension / provider agreement is validated', () => {
  it('the constructor rejects a dimension that disagrees with the provider', async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: 4,
      embeddingProvider: new MockEmbeddingProvider({ dimension: 8 }),
    })
    await expect(store.init()).rejects.toThrow(NamespaceDimensionMismatchError)
  })

  it('initNamespace rejects a dimension that disagrees with the provider', async () => {
    const store = new TemporalStore(openTestDb(), { namespace: 'base' })
    await store.init()
    await expect(
      store.initNamespace('mismatch', {
        embeddingDimension: 4,
        embeddingProvider: new MockEmbeddingProvider({ dimension: 8 }),
      }),
    ).rejects.toThrow(NamespaceDimensionMismatchError)
    await store.close()
  })

  it('upgradeNamespaceToVector rejects a dimension that disagrees with the provider', async () => {
    const store = new TemporalStore(openTestDb(), { namespace: 'base' })
    await store.init()
    await store.initNamespace('vl')
    await expect(
      store.upgradeNamespaceToVector('vl', {
        embeddingDimension: 4,
        embeddingProvider: new MockEmbeddingProvider({ dimension: 8 }),
      }),
    ).rejects.toThrow(NamespaceDimensionMismatchError)
    await store.close()
  })

  it('upgradeNamespaceToVector accepts a provider-only upgrade and derives the dimension', async () => {
    const store = new TemporalStore(openTestDb(), { namespace: 'base' })
    await store.init()
    await store.initNamespace('vl')
    await store.upgradeNamespaceToVector('vl', {
      embeddingProvider: new MockEmbeddingProvider({ dimension: 8 }),
    })
    expect((await store.getStats('vl')).embeddingDimension).toBe(8)
    await store.close()
  })

  it('rejects an invalid (non-positive / non-integer) embedding dimension', async () => {
    for (const bad of [0, -4, 2.5]) {
      const store = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: bad })
      await expect(store.init()).rejects.toThrow(ValidationError)
    }
  })
})

describe('provider error messages do not leak the raw cause', () => {
  class SecretLeakProvider implements EmbeddingProvider {
    readonly name = 'secret-leak'
    readonly dimension = DIM
    embed(): Promise<Float32Array[]> {
      return Promise.reject(new Error('remote response: SECRET-PAYLOAD-xyz'))
    }
  }

  it('indexBatch fail-fast EmbeddingProviderError omits the raw provider message', async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      embeddingProvider: new SecretLeakProvider(),
    })
    await store.init()
    await writeEpisode(store, 'ns')
    await writeAssertion(store, 'ns', 'a-1', 'content')
    let thrown: unknown
    try {
      await store.indexBatch([{ assertionId: 'a-1' }])
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(EmbeddingProviderError)
    expect((thrown as EmbeddingProviderError).message).not.toContain('SECRET-PAYLOAD')
    await store.close()
  })

  it('Step-0 retrieve EmbeddingProviderError omits the raw provider message', async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      embeddingProvider: new SecretLeakProvider(),
    })
    await store.init()
    await writeEpisode(store, 'ns')
    await writeAssertion(store, 'ns', 'a-1', 'content')
    let thrown: unknown
    try {
      await store.retrieve({ namespace: 'ns', queryText: 'content', temporalAnchor: 5 })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(EmbeddingProviderError)
    expect((thrown as EmbeddingProviderError).message).not.toContain('SECRET-PAYLOAD')
    await store.close()
  })
})
