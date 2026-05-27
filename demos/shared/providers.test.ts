import { describe, expect, it } from 'vitest'
import type { TemporalStore, Episode, NewAssertionInput, AssertionLink } from 'trageti'
import { ingest } from './ingest.js'
import {
  createFixtureExtractionProvider,
  resolveDemoProviders,
  type ExtractionProvider,
} from './providers.js'

const fixture = JSON.stringify({
  assertions: [
    {
      id: 'a-1',
      namespace: 'wrong',
      type: 'fact',
      content: 'content',
      validFrom: 999,
      confidence: 0.9,
      sourceEpisodeId: 'wrong-episode',
      citations: [{ id: 'c-1', episodeId: 'wrong-episode', sourceRef: 'src', excerpt: null, excerptStart: '0', excerptEnd: '3' }],
    },
  ],
  links: [
    {
      id: 'l-1',
      namespace: 'wrong',
      fromId: 'a-1',
      toId: 'a-0',
      linkType: 'related',
      validFrom: 999,
      sourceEpisodeId: 'wrong-episode',
    },
  ],
})

describe('demo providers', () => {
  it('fixture extraction is keyed by episode id', async () => {
    const provider = createFixtureExtractionProvider({ a: 'A', b: 'B' })
    await expect(provider.extract('', { episodeId: 'b' })).resolves.toBe('B')
    await expect(provider.extract('', { episodeId: 'missing' })).rejects.toThrow('missing')
  })

  it('defaults to fixture extraction and embedding with no live env', () => {
    const providers = resolveDemoProviders({
      fixtures: { ep: fixture },
      assertionEmbeddings: { 'a-1': [0, 1] },
      queryEmbeddings: { q: [1, 0] },
      queryTexts: ['q'],
      embeddingDimension: 2,
      env: {},
    })
    expect(providers.isLive).toBe(false)
    expect(providers.extractor.provenance.kind).toBe('fixture')
    expect(providers.embedder.provenance.kind).toBe('fixture')
  })

  it('maps extraction and embedding providers independently', () => {
    const providers = resolveDemoProviders({
      fixtures: { ep: fixture },
      assertionEmbeddings: { 'a-1': [0, 1] },
      queryEmbeddings: { q: [1, 0] },
      queryTexts: ['q'],
      embeddingDimension: 2,
      env: {
        DEMO_EXTRACT_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'test-key',
        DEMO_EMBED_PROVIDER: 'ollama-native',
        OLLAMA_HOST: 'http://localhost:11434',
      },
    })
    expect(providers.extractor.provenance.kind).toBe('anthropic')
    expect(providers.embedder.provenance.kind).toBe('ollama-native')
  })
})

describe('ingest normalization', () => {
  it('normalizes caller-owned assertion, citation, and link fields', async () => {
    const store = new FakeStore()
    const extractor = providerReturning(fixture)
    const episode = makeEpisode()

    await ingest({
      store: store as unknown as TemporalStore,
      episode,
      document: 'doc',
      namespace: 'correct',
      existingAssertions: [
        {
          id: 'a-0',
          namespace: 'correct',
          type: 'fact',
          content: 'prior',
          validFrom: 1,
          validUntil: null,
          confidence: 1,
          sourceEpisodeId: 'ep-0',
          supersedesId: null,
          entityId: null,
          entityType: null,
          citations: [],
          createdAt: '',
          extensions: {},
        },
      ],
      extractor,
    })

    expect(store.assertions[0]?.namespace).toBe('correct')
    expect(store.assertions[0]?.sourceEpisodeId).toBe('ep-1')
    expect(store.assertions[0]?.validFrom).toBe(3)
    expect(store.assertions[0]?.citations[0]?.episodeId).toBe('ep-1')
    expect(store.assertions[0]?.citations[0]?.excerpt).toBe('doc')
    expect(store.assertions[0]?.citations[0]?.excerptStart).toBe('0')
    expect(store.assertions[0]?.citations[0]?.excerptEnd).toBe('3')
    expect(store.links[0]?.namespace).toBe('correct')
    expect(store.links[0]?.sourceEpisodeId).toBe('ep-1')
    expect(store.links[0]?.validFrom).toBe(3)
    expect(store.links[0]?.validUntil).toBeNull()
  })

  it('rejects malformed extraction before writing an episode', async () => {
    const store = new FakeStore()
    const extractor = providerReturning(JSON.stringify({ assertions: [{ id: 'a' }], links: [] }))
    await expect(
      ingest({
        store: store as unknown as TemporalStore,
        episode: makeEpisode(),
        document: 'doc',
        namespace: 'correct',
        extractor,
      }),
    ).rejects.toThrow('Extraction result failed validation')
    expect(store.episodes).toHaveLength(0)
  })

  it('rejects direct citation excerpt text before writing an episode', async () => {
    const store = new FakeStore()
    const extractor = providerReturning(JSON.stringify({
      assertions: [
        {
          id: 'a-1',
          namespace: 'wrong',
          type: 'fact',
          content: 'content',
          validFrom: 999,
          confidence: 0.9,
          sourceEpisodeId: 'wrong-episode',
          citations: [{ id: 'c-1', episodeId: 'wrong-episode', sourceRef: 'src', excerpt: 'made up' }],
        },
      ],
      links: [],
    }))

    await expect(
      ingest({
        store: store as unknown as TemporalStore,
        episode: makeEpisode(),
        document: 'doc',
        namespace: 'correct',
        extractor,
      }),
    ).rejects.toThrow('supplied excerpt text directly')
    expect(store.episodes).toHaveLength(0)
  })

  it('rejects assertion IDs that collide with prior assertions before writing an episode', async () => {
    const store = new FakeStore()
    const extractor = providerReturning(JSON.stringify({
      assertions: [
        {
          id: 'a-0',
          namespace: 'wrong',
          type: 'fact',
          content: 'duplicate id',
          validFrom: 999,
          confidence: 0.9,
          sourceEpisodeId: 'wrong-episode',
          citations: [{ id: 'c-dup', episodeId: 'wrong-episode', sourceRef: 'src', excerpt: null, excerptStart: '0', excerptEnd: '3' }],
        },
      ],
      links: [],
    }))

    await expect(
      ingest({
        store: store as unknown as TemporalStore,
        episode: makeEpisode(),
        document: 'doc',
        namespace: 'correct',
        existingAssertions: [
          {
            id: 'a-0',
            namespace: 'correct',
            type: 'fact',
            content: 'prior',
            validFrom: 1,
            validUntil: null,
            confidence: 1,
            sourceEpisodeId: 'ep-0',
            supersedesId: null,
            entityId: null,
            entityType: null,
            citations: [],
            createdAt: '',
            extensions: {},
          },
        ],
        extractor,
      }),
    ).rejects.toThrow('already exists')
    expect(store.episodes).toHaveLength(0)
  })
})

describe('resolveDemoProviders — live-extract + fixture-embed guard', () => {
  const minOptions = {
    fixtures: { 'ep-1': '{"assertions":[],"links":[]}' },
    assertionEmbeddings: {},
    queryEmbeddings: {},
    queryTexts: [] as string[],
    embeddingDimension: 4,
  }

  it('throws when ANTHROPIC_API_KEY is set without an embedding provider', () => {
    expect(() =>
      resolveDemoProviders({ ...minOptions, env: { ANTHROPIC_API_KEY: 'sk-ant-test' } }),
    ).toThrow('Live extraction requires a live embedding provider')
  })

  it('throws when OPENROUTER_API_KEY is set without an embedding provider', () => {
    expect(() =>
      resolveDemoProviders({ ...minOptions, env: { OPENROUTER_API_KEY: 'sk-or-test' } }),
    ).toThrow('Live extraction requires a live embedding provider')
  })

  it('throws when DEMO_EXTRACT_PROVIDER=anthropic and DEMO_EMBED_PROVIDER=fixture', () => {
    expect(() =>
      resolveDemoProviders({
        ...minOptions,
        env: { DEMO_EXTRACT_PROVIDER: 'anthropic', DEMO_EMBED_PROVIDER: 'fixture', ANTHROPIC_API_KEY: 'sk-ant-test' },
      }),
    ).toThrow('Live extraction requires a live embedding provider')
  })

  it('throws when DEMO_EXTRACT_PROVIDER=openai-compatible and DEMO_EMBED_PROVIDER=fixture', () => {
    expect(() =>
      resolveDemoProviders({
        ...minOptions,
        env: {
          DEMO_EXTRACT_PROVIDER: 'openai-compatible',
          DEMO_EMBED_PROVIDER: 'fixture',
          DEMO_EXTRACT_BASE_URL: 'http://localhost:8080/v1',
          OPENAI_API_KEY: 'sk-test',
        },
      }),
    ).toThrow('Live extraction requires a live embedding provider')
  })

  it('does NOT throw when DEMO_EXTRACT_PROVIDER=fixture and DEMO_EMBED_PROVIDER=openai-compatible', () => {
    expect(() =>
      resolveDemoProviders({
        ...minOptions,
        env: {
          DEMO_EXTRACT_PROVIDER: 'fixture',
          DEMO_EMBED_PROVIDER: 'openai-compatible',
          DEMO_EMBED_BASE_URL: 'http://localhost:8080/v1',
          DEMO_EMBED_MODEL: 'text-embedding-3-small',
          OPENAI_API_KEY: 'sk-test',
        },
      }),
    ).not.toThrow()
  })
})

function providerReturning(raw: string): ExtractionProvider {
  return {
    name: 'test',
    label: 'test',
    provenance: { kind: 'fixture', configHash: 'test' },
    extract() {
      return Promise.resolve(raw)
    },
  }
}

function makeEpisode(): Omit<Episode, 'createdAt'> {
  return {
    id: 'ep-1',
    namespace: 'correct',
    position: 3,
    occurredAt: '2026-01-01T00:00:00Z',
    type: 'test',
    content: 'doc',
  }
}

class FakeStore {
  readonly episodes: Array<Omit<Episode, 'createdAt'>> = []
  readonly assertions: NewAssertionInput[] = []
  readonly links: Array<Omit<AssertionLink, 'createdAt'>> = []

  writeEpisode(episode: Omit<Episode, 'createdAt'>): Promise<Episode> {
    this.episodes.push(episode)
    return Promise.resolve({ ...episode, createdAt: '' })
  }

  writeAssertion(assertion: NewAssertionInput): Promise<never> {
    this.assertions.push(assertion)
    return Promise.resolve(undefined as never)
  }

  writeLink(link: Omit<AssertionLink, 'createdAt'>): Promise<never> {
    this.links.push(link)
    return Promise.resolve(undefined as never)
  }
}
