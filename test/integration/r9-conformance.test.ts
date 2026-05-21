import { describe, it, expect } from 'vitest'
import { openTestDb } from '../helpers/openTestDb.js'
import { TemporalStore } from '../../src/store/TemporalStore.js'
import { MockEmbeddingProvider } from '../../src/defaults/providers/MockEmbeddingProvider.js'
import type {
  AssertionValidator,
  Logger,
  LogFields,
  NormalizedNewAssertion,
  ValidationResult,
} from '../../src/domain/types.js'
import { ValidationError } from '../../src/errors/index.js'
import { citationFor } from '../fixtures/scenario.js'

const DIM = 4

/** A custom validator that approves everything — used to prove store-level
 *  policy still applies when the default validator is replaced. */
class PassValidator implements AssertionValidator {
  validate(_assertion: NormalizedNewAssertion): ValidationResult {
    return { valid: true, errors: [] }
  }
}

class RecordingLogger implements Logger {
  readonly records: Array<{ level: string; code: string; fields?: LogFields }> = []
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

async function writeEpisode(store: TemporalStore, ns: string, id = 'ep-1'): Promise<void> {
  await store.writeEpisode({
    id,
    namespace: ns,
    position: 1,
    occurredAt: '2024-01-01T00:00:00Z',
    type: 'document',
    content: 'episode',
  })
}

describe('citation-excerpt policy cannot be bypassed by a custom validator', () => {
  it('writeAssertion rejects a null-excerpt citation under requireCitationExcerpt, even with a custom validator', async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      validators: [new PassValidator()],
      validation: { requireCitationExcerpt: true },
    })
    await store.init()
    await writeEpisode(store, 'ns')
    await expect(
      store.writeAssertion({
        id: 'a-1',
        namespace: 'ns',
        type: 'fact',
        content: 'content',
        validFrom: 1,
        validUntil: null,
        confidence: 0.9,
        sourceEpisodeId: 'ep-1',
        supersedesId: null,
        entityId: null,
        entityType: null,
        citations: [{ id: 'a-1:c0', episodeId: 'ep-1', sourceRef: 'chunk:1', excerpt: null }],
      }),
    ).rejects.toThrow(ValidationError)
    await store.close()
  })

  it('without the flag, a null-excerpt citation emits TRGT_CITATION_EXCERPT_MISSING exactly once', async () => {
    const logger = new RecordingLogger()
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      validators: [new PassValidator()],
      logger,
    })
    await store.init()
    await writeEpisode(store, 'ns')
    await store.writeAssertion({
      id: 'a-1',
      namespace: 'ns',
      type: 'fact',
      content: 'content',
      validFrom: 1,
      validUntil: null,
      confidence: 0.9,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-1', 'ep-1')],
    })
    const warnings = logger.records.filter((r) => r.code === 'TRGT_CITATION_EXCERPT_MISSING')
    expect(warnings).toHaveLength(1)
    await store.close()
  })
})

describe('retrieve() returns the assertion valid at the anchor (mid-chain)', () => {
  async function chainStore(): Promise<TemporalStore> {
    const store = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM })
    await store.init()
    await writeEpisode(store, 'ns')
    // A→B→C: A[1,5) → B[5,10) → C[10,∞). Shared token so BM25 matches all.
    const write = async (id: string, from: number, supersedesId: string | null) => {
      await store.writeAssertion({
        id,
        namespace: 'ns',
        type: 'fact',
        content: `sharedtoken version ${id}`,
        validFrom: from,
        validUntil: null,
        confidence: 0.9,
        sourceEpisodeId: 'ep-1',
        supersedesId,
        entityId: 'e-1',
        entityType: 'concept',
        citations: [citationFor(id, 'ep-1')],
      })
    }
    await write('A', 1, null)
    await write('B', 5, 'A')
    await write('C', 10, 'B')
    return store
  }

  it('an anchor inside the middle version returns that middle version', async () => {
    const store = await chainStore()
    const { results } = await store.retrieve({
      namespace: 'ns',
      queryText: 'sharedtoken',
      retrievalStrategy: 'bm25',
      temporalAnchor: 7,
    })
    const ids = results.map((r) => r.id)
    expect(ids).toContain('B')
    expect(ids).not.toContain('A')
    expect(ids).not.toContain('C')
    await store.close()
  })

  it('default includeSuperseded:false returns only the version valid at the anchor', async () => {
    const store = await chainStore()
    const { results } = await store.retrieve({
      namespace: 'ns',
      queryText: 'sharedtoken',
      retrievalStrategy: 'bm25',
      temporalAnchor: 12,
    })
    expect(results.map((r) => r.id)).toEqual(['C'])
    await store.close()
  })

  it('includeSuperseded:true surfaces closed/superseded versions too', async () => {
    const store = await chainStore()
    const { results } = await store.retrieve({
      namespace: 'ns',
      queryText: 'sharedtoken',
      retrievalStrategy: 'bm25',
      temporalAnchor: 12,
      includeSuperseded: true,
    })
    const ids = results.map((r) => r.id)
    expect(ids).toContain('A')
    expect(ids).toContain('B')
    expect(ids).toContain('C')
    await store.close()
  })
})

describe('reindexNamespace validates newDimension before vec0 DDL', () => {
  async function vectorStore(): Promise<TemporalStore> {
    const store = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM })
    await store.init()
    return store
  }

  it('rejects newDimension: 0 with ValidationError', async () => {
    const store = await vectorStore()
    await expect(
      store.reindexNamespace('ns', {
        newDimension: 0,
        embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
      }),
    ).rejects.toThrow(ValidationError)
    await store.close()
  })

  it('rejects a non-integer newDimension with ValidationError', async () => {
    const store = await vectorStore()
    await expect(
      store.reindexNamespace('ns', {
        newDimension: 2.5,
        embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
      }),
    ).rejects.toThrow(ValidationError)
    await store.close()
  })
})
