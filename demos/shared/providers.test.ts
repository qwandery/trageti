import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TemporalStore, Episode, NewAssertionInput, AssertionLink } from 'trageti';
import { ingest } from './ingest.js';
import { buildExtractionPrompt } from './prompt.js';
import {
  createOpenAICompatibleExtractionProvider,
  createOpenAICompatibleEmbeddingProvider,
  createFixtureExtractionProvider,
  createOllamaNativeEmbeddingProvider,
  resolveDemoProviders,
  type ExtractionProvider,
} from './providers.js';

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
      citations: [
        { id: 'c-1', episodeId: 'wrong-episode', sourceRef: 'src', excerpt: null, excerptStart: '0', excerptEnd: '3' },
      ],
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
});

describe('demo providers', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fixture extraction is keyed by episode id', async () => {
    const provider = createFixtureExtractionProvider({ a: 'A', b: 'B' });
    await expect(provider.extract('', { episodeId: 'b' })).resolves.toBe('B');
    await expect(provider.extract('', { episodeId: 'missing' })).rejects.toThrow('missing');
  });

  it('defaults to fixture extraction and embedding with no live env', () => {
    const providers = resolveDemoProviders({
      fixtures: { ep: fixture },
      assertionEmbeddings: { 'a-1': [0, 1] },
      queryEmbeddings: { q: [1, 0] },
      queryTexts: ['q'],
      embeddingDimension: 2,
      env: {},
    });
    expect(providers.isLive).toBe(false);
    expect(providers.extractor.provenance.kind).toBe('fixture');
    expect(providers.embedder.provenance.kind).toBe('fixture');
  });

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
    });
    expect(providers.extractor.provenance.kind).toBe('anthropic');
    expect(providers.embedder.provenance.kind).toBe('ollama-native');
  });

  it('passes embedding AbortSignal through to fetch', async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        captured = init;
        return Promise.resolve(new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), { status: 200 }));
      }),
    );
    const signal = new AbortController().signal;
    const embedder = createOpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      dimension: 2,
    });

    await embedder.provider.embed(['hello'], { signal });

    expect(captured?.signal).toBe(signal);
  });

  it('does not include raw upstream response bodies in HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('SECRET UPSTREAM BODY', { status: 500, statusText: 'Nope' }))),
    );
    const embedder = createOpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      dimension: 2,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    try {
      await embedder.provider.embed(['hello']);
      throw new Error('expected embed to fail');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('failed HTTP 500 Nope');
      expect(message).not.toContain('SECRET');
    }
  });

  it('traces embedding HTTP timing without raw vectors when enabled', async () => {
    const messages: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), { status: 200 }))),
    );
    const embedder = createOpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      dimension: 2,
      retry: {
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        rateLimitMs: 0,
        traceTimings: true,
        log: (message) => messages.push(message),
      },
    });

    await embedder.provider.embed(['hello']);

    const output = messages.join('\n');
    expect(output).toContain('embedding HTTP request -> https://example.invalid/v1/embeddings');
    expect(output).toContain('embedding HTTP response <- 200');
    expect(output).toContain('embedding JSON parsed');
    expect(output).toContain('embedding vectors decoded: 1 vector(s), 2 dimension(s)');
    expect(output).not.toContain('[1,2]');
    expect(output).not.toContain('sk-test');
  });

  it('traces extraction HTTP timing without prompt or API key contents', async () => {
    const messages: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: '{"assertions":[],"links":[]}' } }] }), {
            status: 200,
          }),
        ),
      ),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: {
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        rateLimitMs: 0,
        traceTimings: true,
        log: (message) => messages.push(message),
      },
    });

    await provider.extract('SECRET PROMPT');

    const output = messages.join('\n');
    expect(output).toContain('extraction HTTP request -> https://example.invalid/v1/chat/completions');
    expect(output).toContain('extraction HTTP response <- 200');
    expect(output).toContain('extraction JSON parsed');
    expect(output).toContain('extraction content decoded');
    expect(output).not.toContain('SECRET PROMPT');
    expect(output).not.toContain('sk-test');
  });

  it('traces Ollama native one-request-per-text embedding behavior', async () => {
    const messages: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ embedding: [1, 2] }), { status: 200 }))),
    );
    const embedder = createOllamaNativeEmbeddingProvider({
      host: 'http://127.0.0.1:11434',
      model: 'nomic-embed-text',
      dimension: 2,
      retry: {
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        rateLimitMs: 0,
        traceTimings: true,
        log: (message) => messages.push(message),
      },
    });

    await embedder.provider.embed(['first', 'second']);

    const output = messages.join('\n');
    expect(output).toContain('will call /api/embeddings once per text (2 request(s))');
    expect(output).toContain('embedding HTTP request 1/2 -> http://127.0.0.1:11434/api/embeddings');
    expect(output).toContain('embedding HTTP request 2/2 -> http://127.0.0.1:11434/api/embeddings');
    expect(output).toContain('embedding vector decoded 2/2: 2 dimension(s)');
  });

  it('retries retryable extraction HTTP failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"assertions":[],"links":[]}' } }] }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    await expect(provider.extract('prompt')).resolves.toContain('"assertions"');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors retry-after while logging retry waits', async () => {
    const messages: string[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0.001' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const embedder = createOpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      dimension: 2,
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1000,
        maxDelayMs: 1000,
        rateLimitMs: 0,
        log: (message) => messages.push(message),
      },
    });

    await embedder.provider.embed(['hello']);

    expect(messages.join('\n')).toContain('HTTP 429');
    expect(messages.join('\n')).toContain('waiting 1 ms');
  });

  it('rate-limits the first attempt of consecutive live provider requests', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10_000);
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"assertions":[],"links":[]}' } }] }), {
          status: 200,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 5000 },
    });

    await provider.extract('first');
    const second = provider.extract('second');
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not log a prior-request wait before the first rate-limited request', async () => {
    const messages: string[] = [];
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10_000);
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: '{"assertions":[],"links":[]}' } }] }), {
            status: 200,
          }),
        ),
      ),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: {
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        rateLimitMs: 5000,
        traceTimings: true,
        log: (message) => messages.push(message),
      },
    });

    await provider.extract('prompt');

    expect(messages.join('\n')).not.toContain('waiting for prior live provider request');
  });

  it('stops retrying after max attempts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 500, statusText: 'Broken' }))),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    await expect(provider.extract('prompt')).rejects.toThrow('failed HTTP 500 Broken');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable HTTP failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 400, statusText: 'Bad Request' }))),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 6, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    await expect(provider.extract('prompt')).rejects.toThrow('failed HTTP 400 Bad Request');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('renders markdown section citation spans with anchored source refs', () => {
    const source = [
      '## 2026-04-16 - Dinner',
      '',
      'Sam said the bread was a little sour for him. Jordan said the salad dressing was the best thing on the table.',
    ].join('\n');

    const prompt = buildExtractionPrompt('episode summary', [], makeEpisode(), 'correct', { 'source.md': source });

    expect(prompt).toContain('sourceRef=source.md#2026-04-16');
    expect(prompt).toContain('excerptStart=0');
    expect(prompt).not.toContain('sourceRef=source.md; excerptStart=');
  });
});

describe('ingest normalization', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('normalizes caller-owned assertion, citation, and link fields', async () => {
    const store = new FakeStore();
    const extractor = providerReturning(fixture);
    const episode = makeEpisode();

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
    });

    expect(store.assertions[0]?.namespace).toBe('correct');
    expect(store.assertions[0]?.sourceEpisodeId).toBe('ep-1');
    expect(store.assertions[0]?.validFrom).toBe(3);
    expect(store.assertions[0]?.citations[0]?.episodeId).toBe('ep-1');
    expect(store.assertions[0]?.citations[0]?.excerpt).toBe('doc');
    expect(store.assertions[0]?.citations[0]?.excerptStart).toBe('0');
    expect(store.assertions[0]?.citations[0]?.excerptEnd).toBe('3');
    expect(store.links[0]?.namespace).toBe('correct');
    expect(store.links[0]?.sourceEpisodeId).toBe('ep-1');
    expect(store.links[0]?.validFrom).toBe(3);
    expect(store.links[0]?.validUntil).toBeNull();
  });

  it('rejects malformed extraction before writing an episode', async () => {
    const store = new FakeStore();
    const extractor = providerReturning(JSON.stringify({ assertions: [{ id: 'a' }], links: [] }));
    await expect(
      ingest({
        store: store as unknown as TemporalStore,
        episode: makeEpisode(),
        document: 'doc',
        namespace: 'correct',
        extractor,
      }),
    ).rejects.toThrow('Extraction result failed validation');
    expect(store.episodes).toHaveLength(0);
  });

  it('rejects direct citation excerpt text before writing an episode', async () => {
    const store = new FakeStore();
    const extractor = providerReturning(
      JSON.stringify({
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
      }),
    );

    await expect(
      ingest({
        store: store as unknown as TemporalStore,
        episode: makeEpisode(),
        document: 'doc',
        namespace: 'correct',
        extractor,
      }),
    ).rejects.toThrow('supplied excerpt text directly');
    expect(store.episodes).toHaveLength(0);
  });

  it('resolves citation excerpts from a registered source document', async () => {
    const store = new FakeStore();
    const extractor = providerReturning(
      JSON.stringify({
        assertions: [
          {
            id: 'a-1',
            namespace: 'wrong',
            type: 'fact',
            content: 'content',
            validFrom: 999,
            confidence: 0.9,
            sourceEpisodeId: 'wrong-episode',
            citations: [
              {
                id: 'c-1',
                episodeId: 'wrong-episode',
                sourceRef: 'source.md',
                excerpt: null,
                excerptStart: '6',
                excerptEnd: '11',
              },
            ],
          },
        ],
        links: [],
      }),
    );

    await ingest({
      store: store as unknown as TemporalStore,
      episode: makeEpisode(),
      document: 'episode summary',
      namespace: 'correct',
      citationSources: { 'source.md': 'hello world' },
      extractor,
    });

    expect(store.assertions[0]?.citations[0]?.excerpt).toBe('world');
  });

  it('resolves anchored markdown citation offsets relative to the section body', async () => {
    const store = new FakeStore();
    const source = [
      '## 2026-04-15 - Earlier',
      '',
      'Earlier paragraph.',
      '',
      '## 2026-04-16 - Dinner',
      '',
      'Sam said the bread was a little sour for him. Priya explained browning.',
      'Jordan said the salad dressing was the best thing on the table.',
      '',
      '## 2026-04-17 - Later',
      '',
      'Later paragraph.',
    ].join('\n');
    const quote = 'Jordan said the salad dressing was the best thing on the table.';
    const sectionBody = [
      'Sam said the bread was a little sour for him. Priya explained browning.',
      'Jordan said the salad dressing was the best thing on the table.',
    ].join('\n');
    const start = sectionBody.indexOf(quote);
    const extractor = providerReturning(
      JSON.stringify({
        assertions: [
          {
            id: 'a-1',
            namespace: 'wrong',
            type: 'fact',
            content: 'content',
            validFrom: 999,
            confidence: 0.9,
            sourceEpisodeId: 'wrong-episode',
            citations: [
              {
                id: 'c-1',
                episodeId: 'wrong-episode',
                sourceRef: 'source.md#2026-04-16',
                excerpt: null,
                excerptStart: String(start),
                excerptEnd: String(start + quote.length),
              },
            ],
          },
        ],
        links: [],
      }),
    );

    await ingest({
      store: store as unknown as TemporalStore,
      episode: makeEpisode(),
      document: 'episode summary',
      namespace: 'correct',
      citationSources: { 'source.md': source },
      extractor,
    });

    expect(store.assertions[0]?.citations[0]?.excerpt).toBe(quote);
  });

  it('rejects an unknown citation source before writing an episode', async () => {
    const store = new FakeStore();
    const extractor = providerReturning(
      JSON.stringify({
        assertions: [
          {
            id: 'a-1',
            namespace: 'wrong',
            type: 'fact',
            content: 'content',
            validFrom: 999,
            confidence: 0.9,
            sourceEpisodeId: 'wrong-episode',
            citations: [
              {
                id: 'c-1',
                episodeId: 'wrong-episode',
                sourceRef: 'missing.md',
                excerpt: null,
                excerptStart: '0',
                excerptEnd: '4',
              },
            ],
          },
        ],
        links: [],
      }),
    );

    await expect(
      ingest({
        store: store as unknown as TemporalStore,
        episode: makeEpisode(),
        document: 'doc',
        namespace: 'correct',
        citationSources: { 'source.md': 'hello world' },
        extractor,
      }),
    ).rejects.toThrow('does not match a registered source document');
    expect(store.episodes).toHaveLength(0);
  });

  it('rejects invalid citation offsets before writing an episode', async () => {
    const store = new FakeStore();
    const extractor = providerReturning(
      JSON.stringify({
        assertions: [
          {
            id: 'a-1',
            namespace: 'wrong',
            type: 'fact',
            content: 'content',
            validFrom: 999,
            confidence: 0.9,
            sourceEpisodeId: 'wrong-episode',
            citations: [
              {
                id: 'c-1',
                episodeId: 'wrong-episode',
                sourceRef: 'source.md',
                excerpt: null,
                excerptStart: '7',
                excerptEnd: '3',
              },
            ],
          },
        ],
        links: [],
      }),
    );

    await expect(
      ingest({
        store: store as unknown as TemporalStore,
        episode: makeEpisode(),
        document: 'doc',
        namespace: 'correct',
        citationSources: { 'source.md': 'hello world' },
        extractor,
      }),
    ).rejects.toThrow('invalid excerptStart/excerptEnd offsets');
    expect(store.episodes).toHaveLength(0);
  });

  it('rejects assertion IDs that collide with prior assertions before writing an episode', async () => {
    const store = new FakeStore();
    const extractor = providerReturning(
      JSON.stringify({
        assertions: [
          {
            id: 'a-0',
            namespace: 'wrong',
            type: 'fact',
            content: 'duplicate id',
            validFrom: 999,
            confidence: 0.9,
            sourceEpisodeId: 'wrong-episode',
            citations: [
              {
                id: 'c-dup',
                episodeId: 'wrong-episode',
                sourceRef: 'src',
                excerpt: null,
                excerptStart: '0',
                excerptEnd: '3',
              },
            ],
          },
        ],
        links: [],
      }),
    );

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
    ).rejects.toThrow('already exists');
    expect(store.episodes).toHaveLength(0);
  });
});

describe('resolveDemoProviders — live-extract + fixture-embed guard', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const minOptions = {
    fixtures: { 'ep-1': '{"assertions":[],"links":[]}' },
    assertionEmbeddings: {},
    queryEmbeddings: {},
    queryTexts: [] as string[],
    embeddingDimension: 4,
  };

  it('throws when ANTHROPIC_API_KEY is set without an embedding provider', () => {
    expect(() => resolveDemoProviders({ ...minOptions, env: { ANTHROPIC_API_KEY: 'sk-ant-test' } })).toThrow(
      'Live extraction requires a live embedding provider',
    );
  });

  it('throws when OPENROUTER_API_KEY is set without an embedding provider', () => {
    expect(() => resolveDemoProviders({ ...minOptions, env: { OPENROUTER_API_KEY: 'sk-or-test' } })).toThrow(
      'Live extraction requires a live embedding provider',
    );
  });

  it('throws when DEMO_EXTRACT_PROVIDER=anthropic and DEMO_EMBED_PROVIDER=fixture', () => {
    expect(() =>
      resolveDemoProviders({
        ...minOptions,
        env: { DEMO_EXTRACT_PROVIDER: 'anthropic', DEMO_EMBED_PROVIDER: 'fixture', ANTHROPIC_API_KEY: 'sk-ant-test' },
      }),
    ).toThrow('Live extraction requires a live embedding provider');
  });

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
    ).toThrow('Live extraction requires a live embedding provider');
  });

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
    ).not.toThrow();
  });
});

function providerReturning(raw: string): ExtractionProvider {
  return {
    name: 'test',
    label: 'test',
    provenance: { kind: 'fixture', configHash: 'test' },
    extract() {
      return Promise.resolve(raw);
    },
  };
}

function makeEpisode(): Omit<Episode, 'createdAt'> {
  return {
    id: 'ep-1',
    namespace: 'correct',
    position: 3,
    occurredAt: '2026-01-01T00:00:00Z',
    type: 'test',
    content: 'doc',
  };
}

class FakeStore {
  readonly episodes: Array<Omit<Episode, 'createdAt'>> = [];
  readonly assertions: NewAssertionInput[] = [];
  readonly links: Array<Omit<AssertionLink, 'createdAt'>> = [];

  writeEpisode(episode: Omit<Episode, 'createdAt'>): Promise<Episode> {
    this.episodes.push(episode);
    return Promise.resolve({ ...episode, createdAt: '' });
  }

  writeAssertion(assertion: NewAssertionInput): Promise<never> {
    this.assertions.push(assertion);
    return Promise.resolve(undefined as never);
  }

  writeLink(link: Omit<AssertionLink, 'createdAt'>): Promise<never> {
    this.links.push(link);
    return Promise.resolve(undefined as never);
  }
}
