import { describe, it, expect } from 'vitest'
import { openTestDb } from '../helpers/openTestDb.js'
import { TemporalStore } from '../../src/store/TemporalStore.js'
import { ValidationError } from '../../src/errors/index.js'
import type {
  TraversalOptions,
  PathOptions,
  TemporalSnapshotOptions,
  GraphAdapterTraversalOptions,
  GraphQueryAdapter,
  RetrievalStep,
  RetrievalStepInfo,
  MigrationDescriptor,
} from '../../src/index.js'
import { citationFor } from '../fixtures/scenario.js'

const DIM = 4

async function seedEpisode(store: TemporalStore, ns: string, id = 'ep-1'): Promise<void> {
  await store.writeEpisode({
    id,
    namespace: ns,
    position: 1,
    occurredAt: '2024-01-01T00:00:00Z',
    type: 'document',
    content: 'episode',
  })
}

async function seedAssertion(store: TemporalStore, ns: string, id: string): Promise<void> {
  await store.writeAssertion({
    id,
    namespace: ns,
    type: 'fact',
    content: `searchterm assertion ${id}`,
    validFrom: 1,
    validUntil: null,
    confidence: 0.9,
    sourceEpisodeId: 'ep-1',
    supersedesId: null,
    entityId: null,
    entityType: null,
    citations: [citationFor(id, 'ep-1')],
  })
}

describe('RetrievalMeta.queryTextMode is null when the call carries no queryText', () => {
  it('a vector-only retrieve reports queryTextMode: null', async () => {
    const store = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM })
    await store.init()
    await seedEpisode(store, 'ns')
    await seedAssertion(store, 'ns', 'a-1')
    const { meta } = await store.retrieve({
      namespace: 'ns',
      queryEmbedding: new Float32Array([1, 0, 0, 0]),
      retrievalStrategy: 'vector',
      temporalAnchor: 5,
    })
    expect(meta.queryTextMode).toBeNull()
    await store.close()
  })

  it('a text retrieve reports the effective queryTextMode', async () => {
    const store = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM })
    await store.init()
    await seedEpisode(store, 'ns')
    await seedAssertion(store, 'ns', 'a-1')

    const phrase = await store.retrieve({
      namespace: 'ns',
      queryText: 'searchterm',
      retrievalStrategy: 'bm25',
      temporalAnchor: 5,
    })
    expect(phrase.meta.queryTextMode).toBe('phrase')

    const fts5 = await store.retrieve({
      namespace: 'ns',
      queryText: 'searchterm',
      retrievalStrategy: 'bm25',
      queryTextMode: 'fts5',
      temporalAnchor: 5,
    })
    expect(fts5.meta.queryTextMode).toBe('fts5')
    await store.close()
  })
})

describe('writeEpisode rejects malformed input with ValidationError before SQLite', () => {
  async function store(): Promise<TemporalStore> {
    const s = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM })
    await s.init()
    return s
  }
  const base = {
    namespace: 'ns',
    position: 1,
    occurredAt: '2024-01-01T00:00:00Z',
    type: 'document',
    content: 'episode body',
  }

  it('rejects a blank id', async () => {
    const s = await store()
    await expect(s.writeEpisode({ ...base, id: '   ' })).rejects.toThrow(ValidationError)
    await s.close()
  })

  it('rejects a non-finite position', async () => {
    const s = await store()
    await expect(s.writeEpisode({ ...base, id: 'ep-1', position: Number.NaN })).rejects.toThrow(
      ValidationError,
    )
    await expect(
      s.writeEpisode({ ...base, id: 'ep-1', position: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(ValidationError)
    await s.close()
  })

  it('accepts an empty occurredAt (opaque audit metadata)', async () => {
    const s = await store()
    const ep = await s.writeEpisode({ ...base, id: 'ep-ok', occurredAt: '' })
    expect(ep.id).toBe('ep-ok')
    await s.close()
  })
})

describe('writeLink rejects malformed input with ValidationError before SQLite', () => {
  async function linkStore(): Promise<TemporalStore> {
    const s = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM })
    await s.init()
    await seedEpisode(s, 'ns')
    await seedAssertion(s, 'ns', 'a-1')
    await seedAssertion(s, 'ns', 'a-2')
    return s
  }
  const base = {
    namespace: 'ns',
    fromId: 'a-1',
    toId: 'a-2',
    linkType: 'related',
    validFrom: 1,
    validUntil: null,
    sourceEpisodeId: 'ep-1',
  }

  it('rejects a blank id', async () => {
    const s = await linkStore()
    await expect(s.writeLink({ ...base, id: '' })).rejects.toThrow(ValidationError)
    await s.close()
  })

  it('rejects a blank fromId / toId / sourceEpisodeId reference', async () => {
    const s = await linkStore()
    await expect(s.writeLink({ ...base, id: 'l-1', fromId: '' })).rejects.toThrow(ValidationError)
    await expect(s.writeLink({ ...base, id: 'l-1', toId: '' })).rejects.toThrow(ValidationError)
    await expect(s.writeLink({ ...base, id: 'l-1', sourceEpisodeId: '' })).rejects.toThrow(
      ValidationError,
    )
    await s.close()
  })

  it('rejects a non-finite validFrom and a non-finite validUntil', async () => {
    const s = await linkStore()
    await expect(
      s.writeLink({ ...base, id: 'l-1', validFrom: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(ValidationError)
    await expect(s.writeLink({ ...base, id: 'l-1', validUntil: Number.NaN })).rejects.toThrow(
      ValidationError,
    )
    await s.close()
  })

  it('rejects a validUntil that is not greater than validFrom', async () => {
    const s = await linkStore()
    await expect(s.writeLink({ ...base, id: 'l-1', validUntil: 1 })).rejects.toThrow(
      ValidationError,
    )
    await s.close()
  })

  it('accepts a well-formed link', async () => {
    const s = await linkStore()
    const link = await s.writeLink({ ...base, id: 'l-ok' })
    expect(link.id).toBe('l-ok')
    await s.close()
  })
})

// ── Public type compile fixture ───────────────────────────────────────────────
// Exercises every R9-affected exported type against the actual store method and
// `GraphQueryAdapter` signatures. Any drift between the exported types and the
// implementation fails `tsc --noEmit` (test files are typechecked).
describe('public type compile fixture', () => {
  it('R9 option/result types match the store + adapter signatures', async () => {
    const store = new TemporalStore(openTestDb(), { namespace: 'g', embeddingDimension: DIM })
    await store.init()
    await seedEpisode(store, 'g')
    await seedAssertion(store, 'g', 'a-1')
    await seedAssertion(store, 'g', 'a-2')
    await store.writeLink({
      id: 'l-1',
      namespace: 'g',
      fromId: 'a-1',
      toId: 'a-2',
      linkType: 'related',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-1',
    })

    const traversal: TraversalOptions = {
      namespace: 'g',
      fromAssertionId: 'a-1',
      temporalAnchor: 10,
      maxDepth: 2,
      linkTypes: ['related'],
      includeSuperseded: false,
    }
    const connected = await store.getConnected(traversal)
    expect(connected.map((a) => a.id)).toContain('a-2')

    const path: PathOptions = {
      namespace: 'g',
      fromAssertionId: 'a-1',
      toAssertionId: 'a-2',
      temporalAnchor: 10,
      linkTypes: ['related'],
    }
    const found = await store.findPath(path)
    expect(found).not.toBeNull()

    const snapshot: TemporalSnapshotOptions = {
      namespace: 'g',
      atPosition: 10,
      entityTypes: ['concept'],
      assertionTypes: ['fact'],
      includeSuperseded: true,
    }
    expect(Array.isArray(await store.getTemporalSnapshot(snapshot))).toBe(true)

    // GraphAdapterTraversalOptions against the GraphQueryAdapter contract.
    const adapterOptions: GraphAdapterTraversalOptions = {
      temporalAnchor: 10,
      maxDepth: 3,
      linkTypes: ['related'],
      includeSuperseded: false,
    }
    const adapter: GraphQueryAdapter = {
      findConnected: (_db, _namespace, _fromIds, options: GraphAdapterTraversalOptions) => {
        void options
        return []
      },
      findPath: (_db, _namespace, _fromId, _toId, options: GraphAdapterTraversalOptions) => {
        void options
        return null
      },
    }
    expect(typeof adapter.findConnected).toBe('function')
    expect(typeof adapter.findPath).toBe('function')
    expect(adapterOptions.maxDepth).toBe(3)

    // RetrievalStep / RetrievalStepInfo against the debug.onStep hook.
    const seen: RetrievalStep[] = []
    const onStep = (step: RetrievalStep, info: RetrievalStepInfo): void => {
      seen.push(step)
      expect(info.step).toBe(step)
      void info.candidateCount
      void info.tookMs
      void info.applied
      void info.notes
    }
    await store.retrieve({
      namespace: 'g',
      queryText: 'searchterm',
      retrievalStrategy: 'bm25',
      temporalAnchor: 10,
      debug: { onStep },
    })
    expect(seen).toContain('keyword')
    expect(seen).toContain('validate')
    expect(seen).toContain('score')

    // RetrievalExplainStep.step is a RetrievalStep.
    const plan = await store.explain({
      namespace: 'g',
      queryText: 'searchterm',
      retrievalStrategy: 'bm25',
      temporalAnchor: 10,
      expandLinks: true,
      mode: 'trajectory',
    })
    const planSteps: RetrievalStep[] = plan.steps.map((s) => s.step)
    expect(planSteps).toEqual([
      'validate',
      'temporal-filter',
      'keyword',
      'score',
      'rank',
      'graph-expand',
      'trajectory-expand',
    ])

    // MigrationDescriptor carries appliedAt alongside the additive fields.
    const migrations: readonly MigrationDescriptor[] = await store.getMigrations()
    const first = migrations[0]
    expect(first).toBeDefined()
    if (first) {
      const appliedAt: string | null = first.appliedAt
      const name: string = first.name
      const requiresForeignKeyToggle: boolean = first.requiresForeignKeyToggle
      expect(typeof name).toBe('string')
      expect(typeof requiresForeignKeyToggle).toBe('boolean')
      expect(appliedAt).not.toBeNull()
    }

    await store.close()
  })
})
