import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TragetiStore, Episode, NewAssertionInput, AssertionLink } from 'trageti';
import { ingest } from './ingest.js';
import { buildExtractionPrompt } from './prompt.js';
import {
  createOpenAICompatibleExtractionProvider,
  createOpenAICompatibleEmbeddingProvider,
  createAnthropicExtractionProvider,
  createFixtureExtractionProvider,
  createOllamaNativeEmbeddingProvider,
  resetDemoProviderRateLimitForTests,
  resolveDemoProviders,
  resolveLiveExtractionProvider,
  resolveLiveEmbeddingProvider,
  resolveVisionProvider,
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
    resetDemoProviderRateLimitForTests();
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
        DEMO_EXTRACT_API_KEY: 'test-key',
        DEMO_EMBED_PROVIDER: 'ollama-native',
        OLLAMA_HOST: 'http://localhost:11434',
      },
    });
    expect(providers.extractor.provenance.kind).toBe('anthropic');
    expect(providers.embedder.provenance.kind).toBe('ollama-native');
  });

  it('infers demo embedding dimension from vectors and lets env override live providers', () => {
    const providers = resolveDemoProviders({
      fixtures: { ep: fixture },
      assertionEmbeddings: { 'a-1': [0, 1, 2] },
      queryEmbeddings: { q: [1, 0, 1] },
      queryTexts: ['q'],
      env: {
        DEMO_EXTRACT_PROVIDER: 'fixture',
        DEMO_EMBED_PROVIDER: 'openai-compatible',
        DEMO_EMBED_BASE_URL: 'https://example.invalid/v1',
        DEMO_EMBED_MODEL: 'embed-model',
        DEMO_EMBED_API_KEY: 'sk-test',
        DEMO_EMBED_DIMENSION: '1024',
      },
    });

    expect(providers.embedder.provider.dimension).toBe(1024);
    expect(providers.provenance.embedding.dimension).toBe(1024);
  });

  it('does not guess a live embedding dimension without fixtures or env config', () => {
    expect(() =>
      resolveLiveEmbeddingProvider({
        env: {
          DEMO_EMBED_PROVIDER: 'openai-compatible',
          DEMO_EMBED_BASE_URL: 'https://example.invalid/v1',
          DEMO_EMBED_MODEL: 'embed-model',
          DEMO_EMBED_API_KEY: 'sk-test',
        },
      }),
    ).toThrow('DEMO_EMBED_DIMENSION');
  });

  it('includes extraction max-token configuration in live provider provenance', () => {
    const providers = resolveDemoProviders({
      fixtures: { ep: fixture },
      assertionEmbeddings: { 'a-1': [0, 1] },
      queryEmbeddings: { q: [1, 0] },
      queryTexts: ['q'],
      embeddingDimension: 2,
      env: {
        DEMO_EXTRACT_PROVIDER: 'openai-compatible',
        DEMO_EXTRACT_BASE_URL: 'http://localhost:11434/v1',
        DEMO_EXTRACT_MODEL: 'm',
        DEMO_EXTRACT_MAX_TOKENS: '333',
        DEMO_EMBED_PROVIDER: 'ollama-native',
        OLLAMA_HOST: 'http://localhost:11434',
      },
    });

    expect(providers.extractor.provenance.maxTokens).toBe(333);
  });

  it('honors explicit OpenAI-compatible vision base URL', () => {
    const provider = resolveVisionProvider({
      env: {
        DEMO_VISION_PROVIDER: 'openai-compatible',
        DEMO_VISION_BASE_URL: 'https://vision.example.invalid/v1',
        DEMO_EXTRACT_BASE_URL: 'https://extract.example.invalid/v1',
        DEMO_VISION_API_KEY: 'sk-test',
      },
    });

    expect(provider.provenance.baseUrl).toBe('https://vision.example.invalid/v1');
  });

  it('inherits OpenAI-compatible extraction endpoint and API key for vision when vision values are absent', async () => {
    let requestUrl: string | URL | Request | undefined;
    let requestInit: RequestInit | undefined;
    let requestBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('expected string request body');
        requestUrl = url;
        requestInit = init;
        requestBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(openAIStreamResponse(['vision text']));
      }),
    );
    const provider = resolveVisionProvider({
      env: {
        DEMO_VISION_PROVIDER: 'openai-compatible',
        DEMO_EXTRACT_BASE_URL: 'https://extract.example.invalid/v1',
        DEMO_EXTRACT_API_KEY: 'sk-extract',
        DEMO_EXTRACT_MODEL: 'extract-model',
        DEMO_EXTRACT_EXTRA_BODY_JSON: '{"seed":123}',
        DEMO_PROVIDER_MAX_ATTEMPTS: '1',
        DEMO_RATE_LIMIT: '0',
      },
    });

    await expect(provider.extract('describe', { responseFormat: 'text' })).resolves.toBe('vision text');

    expect(requestUrlString(requestUrl)).toBe('https://extract.example.invalid/v1/chat/completions');
    expect((requestInit?.headers as Record<string, string> | undefined)?.['Authorization']).toBe('Bearer sk-extract');
    expect(requestBody).toMatchObject({ model: 'gpt-4o-mini', seed: 123 });
  });

  it('lets OpenAI-compatible vision settings override inherited extraction settings', async () => {
    let requestUrl: string | URL | Request | undefined;
    let requestInit: RequestInit | undefined;
    let requestBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('expected string request body');
        requestUrl = url;
        requestInit = init;
        requestBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(openAIStreamResponse(['vision text']));
      }),
    );
    const provider = resolveVisionProvider({
      env: {
        DEMO_VISION_PROVIDER: 'openai-compatible',
        DEMO_VISION_BASE_URL: 'https://vision.example.invalid/v1',
        DEMO_VISION_API_KEY: 'sk-vision',
        DEMO_VISION_MODEL: 'vision-model',
        DEMO_VISION_EXTRA_BODY_JSON: '{"seed":456}',
        DEMO_EXTRACT_BASE_URL: 'https://extract.example.invalid/v1',
        DEMO_EXTRACT_API_KEY: 'sk-extract',
        DEMO_EXTRACT_EXTRA_BODY_JSON: '{"seed":123}',
        DEMO_PROVIDER_MAX_ATTEMPTS: '1',
        DEMO_RATE_LIMIT: '0',
      },
    });

    await expect(provider.extract('describe', { responseFormat: 'text' })).resolves.toBe('vision text');

    expect(requestUrlString(requestUrl)).toBe('https://vision.example.invalid/v1/chat/completions');
    expect((requestInit?.headers as Record<string, string> | undefined)?.['Authorization']).toBe('Bearer sk-vision');
    expect(requestBody).toMatchObject({ model: 'vision-model', seed: 456 });
  });

  it('keeps explicit OpenAI-compatible extraction resolution unchanged', () => {
    const provider = resolveLiveExtractionProvider({
      env: {
        DEMO_EXTRACT_PROVIDER: 'openai-compatible',
        DEMO_EXTRACT_BASE_URL: 'https://extract.example.invalid/v1',
        DEMO_EXTRACT_API_KEY: 'sk-extract',
        DEMO_EXTRACT_MODEL: 'extract-model',
      },
    });

    expect(provider.provenance).toMatchObject({
      kind: 'openai-compatible',
      baseUrl: 'https://extract.example.invalid/v1',
      model: 'extract-model',
    });
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

  it('can merge OpenAI-compatible embedding extra body JSON', async () => {
    let requestBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('expected string request body');
        requestBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), { status: 200 }));
      }),
    );
    const embedder = resolveLiveEmbeddingProvider({
      embeddingDimension: 2,
      env: {
        DEMO_EMBED_PROVIDER: 'openai-compatible',
        DEMO_EMBED_BASE_URL: 'https://example.invalid/v1',
        DEMO_EMBED_API_KEY: 'sk-test',
        DEMO_EMBED_MODEL: 'm',
        DEMO_EMBED_DIMENSION: '2',
        DEMO_EMBED_EXTRA_BODY_JSON: '{"response_format":{"type":"float"},"seed":123}',
        DEMO_PROVIDER_MAX_ATTEMPTS: '1',
        DEMO_RATE_LIMIT: '0',
      },
    });

    await embedder.provider.embed(['hello']);

    expect(requestBody).toMatchObject({
      model: 'm',
      input: ['hello'],
      dimensions: 2,
      response_format: { type: 'float' },
      seed: 123,
    });
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
    expect(output).toContain('embedding preparing HTTP POST -> https://example.invalid/v1/embeddings');
    expect(output).toContain('embedding request body serialized');
    expect(output).toContain('embedding fetch invoked -> https://example.invalid/v1/embeddings');
    expect(output).toContain('embedding HTTP response <- 200');
    expect(output).toContain('embedding JSON parsed');
    expect(output).toContain('embedding vectors decoded: 1 vector(s), 2 dimension(s)');
    expect(output).not.toContain('[1,2]');
    expect(output).not.toContain('sk-test');
  });

  it('traces extraction HTTP timing without prompt or API key contents', async () => {
    const messages: string[] = [];
    let requestBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('expected string request body');
        requestBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(openAIStreamResponse(['{"assertions":', '[],"links":[]}']));
      }),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      maxTokens: 321,
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
    expect(output).toContain('extraction preparing HTTP POST -> https://example.invalid/v1/chat/completions');
    expect(output).toContain('extraction request body serialized');
    expect(output).toContain('extraction fetch invoked -> https://example.invalid/v1/chat/completions');
    expect(output).toContain('extraction HTTP response <- 200');
    expect(output).toContain('extraction stream:');
    expect(output).toContain('extraction stream complete');
    expect(output).not.toContain('extraction stream delta');
    expect(output).not.toContain('SECRET PROMPT');
    expect(output).not.toContain('sk-test');
    expect(requestBody).toMatchObject({ max_tokens: 321, response_format: { type: 'json_object' }, stream: true });
  });

  it('uses non-streaming OpenAI-compatible requests by default for JSON extraction', async () => {
    let requestBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('expected string request body');
        requestBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: '{"assertions":[],"links":[]}' } }] }), {
            status: 200,
          }),
        );
      }),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    await expect(provider.extract('prompt', { responseFormat: 'json' })).resolves.toBe('{"assertions":[],"links":[]}');

    expect(requestBody).toMatchObject({ stream: false, response_format: { type: 'json_object' } });
  });

  it('retries JSON extraction without response_format when OpenAI-compatible servers reject it', async () => {
    const requestBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('expected string request body');
        requestBodies.push(JSON.parse(init.body) as unknown);
        if (requestBodies.length === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: { message: 'Provider returned error' } }), { status: 400 }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: '{"assertions":[],"links":[]}' } }] }), {
            status: 200,
          }),
        );
      }),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    await expect(provider.extract('prompt', { responseFormat: 'json' })).resolves.toBe('{"assertions":[],"links":[]}');

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toMatchObject({ stream: false, response_format: { type: 'json_object' } });
    expect(requestBodies[1]).toMatchObject({ stream: false });
    expect(requestBodies[1]).not.toHaveProperty('response_format');
  });

  it('logs raw non-streaming extraction response bodies in full trace mode', async () => {
    const messages: string[] = [];
    const body = { choices: [{ message: { content: '{"assertions":[],"links":[]}' } }] };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))),
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
        tracePayloads: true,
        log: (message) => messages.push(message),
      },
    });

    await expect(provider.extract('prompt', { responseFormat: 'json' })).resolves.toBe('{"assertions":[],"links":[]}');

    expect(messages.join('\n')).toContain('raw response body');
    expect(messages.join('\n')).toContain(JSON.stringify(body));
  });

  it('can opt JSON extraction back into OpenAI-compatible streaming', async () => {
    let requestBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('expected string request body');
        requestBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(openAIStreamResponse(['{"assertions":[],"links":[]}']));
      }),
    );
    const provider = resolveLiveExtractionProvider({
      env: {
        DEMO_EXTRACT_PROVIDER: 'openai-compatible',
        DEMO_EXTRACT_BASE_URL: 'https://example.invalid/v1',
        DEMO_EXTRACT_API_KEY: 'sk-test',
        DEMO_EXTRACT_MODEL: 'm',
        DEMO_EXTRACT_STREAM_JSON: 'true',
        DEMO_PROVIDER_MAX_ATTEMPTS: '1',
        DEMO_RATE_LIMIT: '0',
      },
    });

    await expect(provider.extract('prompt', { responseFormat: 'json' })).resolves.toBe('{"assertions":[],"links":[]}');

    expect(requestBody).toMatchObject({ stream: true });
  });

  it('can disable OpenAI-compatible extraction response_format for incompatible servers', async () => {
    let requestBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('expected string request body');
        requestBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(openAIStreamResponse(['{"assertions":[],"links":[]}']));
      }),
    );
    const provider = resolveLiveExtractionProvider({
      env: {
        DEMO_EXTRACT_PROVIDER: 'openai-compatible',
        DEMO_EXTRACT_BASE_URL: 'https://example.invalid/v1',
        DEMO_EXTRACT_API_KEY: 'sk-test',
        DEMO_EXTRACT_MODEL: 'm',
        DEMO_EXTRACT_RESPONSE_FORMAT: 'off',
        DEMO_PROVIDER_MAX_ATTEMPTS: '1',
        DEMO_RATE_LIMIT: '0',
      },
    });

    await provider.extract('prompt');

    expect(requestBody).toMatchObject({ stream: true });
    expect(requestBody).not.toHaveProperty('response_format');
  });

  it('can request OpenAI-compatible extraction with strict JSON schema response format', async () => {
    let requestBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('expected string request body');
        requestBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(openAIStreamResponse(['{"assertions":[],"links":[]}']));
      }),
    );
    const provider = resolveLiveExtractionProvider({
      env: {
        DEMO_EXTRACT_PROVIDER: 'openai-compatible',
        DEMO_EXTRACT_BASE_URL: 'https://example.invalid/v1',
        DEMO_EXTRACT_API_KEY: 'sk-test',
        DEMO_EXTRACT_MODEL: 'm',
        DEMO_EXTRACT_RESPONSE_FORMAT: 'json_schema',
        DEMO_PROVIDER_MAX_ATTEMPTS: '1',
        DEMO_RATE_LIMIT: '0',
      },
    });

    await provider.extract('prompt');

    expect(requestBody).toMatchObject({
      stream: true,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'trageti_extraction',
          strict: true,
          schema: {
            type: 'object',
            required: ['assertions', 'links'],
            additionalProperties: false,
          },
        },
      },
    });
  });

  it('can request OpenAI-compatible extraction with raw JSON response format', async () => {
    let requestBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('expected string request body');
        requestBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(openAIStreamResponse(['{"assertions":[],"links":[]}']));
      }),
    );
    const provider = resolveLiveExtractionProvider({
      env: {
        DEMO_EXTRACT_PROVIDER: 'openai-compatible',
        DEMO_EXTRACT_BASE_URL: 'https://example.invalid/v1',
        DEMO_EXTRACT_API_KEY: 'sk-test',
        DEMO_EXTRACT_MODEL: 'm',
        DEMO_EXTRACT_RESPONSE_FORMAT: '{"type":"json_object"}',
        DEMO_PROVIDER_MAX_ATTEMPTS: '1',
        DEMO_RATE_LIMIT: '0',
      },
    });

    await provider.extract('prompt');

    expect(requestBody).toMatchObject({
      response_format: { type: 'json_object' },
    });
  });

  it('can merge OpenAI-compatible extraction extra body JSON', async () => {
    let requestBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('expected string request body');
        requestBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(openAIStreamResponse(['{"assertions":[],"links":[]}']));
      }),
    );
    const provider = resolveLiveExtractionProvider({
      env: {
        DEMO_EXTRACT_PROVIDER: 'openai-compatible',
        DEMO_EXTRACT_BASE_URL: 'https://example.invalid/v1',
        DEMO_EXTRACT_API_KEY: 'sk-test',
        DEMO_EXTRACT_MODEL: 'm',
        DEMO_EXTRACT_EXTRA_BODY_JSON: '{"reasoning":{"exclude":true},"seed":123}',
        DEMO_PROVIDER_MAX_ATTEMPTS: '1',
        DEMO_RATE_LIMIT: '0',
      },
    });

    await provider.extract('prompt');

    expect(requestBody).toMatchObject({
      reasoning: { exclude: true },
      seed: 123,
      response_format: { type: 'json_object' },
    });
  });

  it('rejects response_format inside OpenAI-compatible extraction extra body JSON', () => {
    expect(() =>
      resolveLiveExtractionProvider({
        env: {
          DEMO_EXTRACT_PROVIDER: 'openai-compatible',
          DEMO_EXTRACT_BASE_URL: 'https://example.invalid/v1',
          DEMO_EXTRACT_API_KEY: 'sk-test',
          DEMO_EXTRACT_MODEL: 'm',
          DEMO_EXTRACT_EXTRA_BODY_JSON: '{"response_format":{"type":"json_object"}}',
        },
      }),
    ).toThrow('DEMO_EXTRACT_EXTRA_BODY_JSON must not include response_format');
  });

  it('uses text response format per call when requested', async () => {
    let requestBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('expected string request body');
        requestBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(openAIStreamResponse(['plain text summary']));
      }),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      responseFormat: { type: 'json_object' },
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    await expect(provider.extract('prompt', { responseFormat: 'text' })).resolves.toBe('plain text summary');

    expect(requestBody).toMatchObject({ stream: true });
    expect(requestBody).not.toHaveProperty('response_format');
  });

  it('sends OpenAI-compatible image content parts when images are supplied', async () => {
    let requestBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('expected string request body');
        requestBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(openAIStreamResponse(['image description']));
      }),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    await provider.extract('describe', {
      responseFormat: 'text',
      images: { 'screen.png': { path: 'demos/big-brother/data/synthetic-screen-1.svg', mimeType: 'image/svg+xml' } },
    });

    const content = dataValue(requestBody, ['messages', 0, 'content']);
    expect(Array.isArray(content)).toBe(true);
    expect(dataValue(content, [0, 'text'])).toBe('describe');
    expect(String(dataValue(content, [1, 'image_url', 'url']))).toContain('data:image/svg+xml;base64,');
  });

  it('sends Anthropic image content blocks when images are supplied', async () => {
    let requestBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('expected string request body');
        requestBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(
          new Response(JSON.stringify({ content: [{ text: 'image description' }] }), { status: 200 }),
        );
      }),
    );
    const provider = createAnthropicExtractionProvider('sk-test', 'm', {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      rateLimitMs: 0,
    });

    await provider.extract('describe', {
      responseFormat: 'text',
      images: { 'screen.png': { path: 'demos/big-brother/data/synthetic-screen-1.svg', mimeType: 'image/svg+xml' } },
    });

    const content = dataValue(requestBody, ['messages', 0, 'content']);
    expect(Array.isArray(content)).toBe(true);
    expect(dataValue(content, [0, 'text'])).toBe('describe');
    expect(dataValue(content, [1, 'source', 'media_type'])).toBe('image/svg+xml');
    expect(typeof dataValue(content, [1, 'source', 'data'])).toBe('string');
  });

  it('appends full-trace extraction stream frames without per-token log entries', async () => {
    const messages: string[] = [];
    const appended: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(openAIStreamResponse(['hello', ' ', 'world']))),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      streamJson: true,
      retry: {
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        rateLimitMs: 0,
        traceTimings: true,
        tracePayloads: true,
        log: (message) => messages.push(message),
        append: (message) => appended.push(message),
      },
    });

    await expect(provider.extract('prompt')).resolves.toBe('hello world');

    const output = messages.join('\n');
    expect(output).not.toContain('extraction stream text follows');
    expect(output).not.toContain('extraction stream delta');
    expect(appended.join('')).toContain('data: {"choices":[{"delta":{"content":"hello"}}]}');
    expect(appended.join('')).toContain('data: {"choices":[{"delta":{"content":" "}}]}');
    expect(appended.join('')).toContain('data: {"choices":[{"delta":{"content":"world"}}]}');
    expect(appended.join('')).toContain('data: [DONE]');
  });

  it('appends raw full-trace extraction stream payloads even when no content deltas are present', async () => {
    const appended: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          openAIStreamDataResponse([
            { choices: [{ delta: { reasoning: 'thinking only' } }] },
            { choices: [{ finish_reason: 'stop' }] },
          ]),
        ),
      ),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      streamJson: true,
      retry: {
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        rateLimitMs: 0,
        traceTimings: true,
        tracePayloads: true,
        append: (message) => appended.push(message),
      },
    });

    await expect(provider.extract('prompt', { responseFormat: 'text' })).rejects.toThrow('contentless stream');

    const output = appended.join('');
    expect(output).toContain('data: {"choices":[{"delta":{"reasoning":"thinking only"}}]}');
    expect(output).toContain('data: {"choices":[{"finish_reason":"stop"}]}');
    expect(output).toContain('data: [DONE]');
  });

  it('does not append raw extraction stream payloads in summary trace mode', async () => {
    const appended: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(openAIStreamDataResponse([{ choices: [{ delta: { reasoning: 'hidden' } }] }]))),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      streamJson: true,
      retry: {
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        rateLimitMs: 0,
        traceTimings: true,
        tracePayloads: false,
        append: (message) => appended.push(message),
      },
    });

    await expect(provider.extract('prompt', { responseFormat: 'text' })).rejects.toThrow('contentless stream');

    expect(appended).toEqual([]);
  });

  it('streams extraction in regular mode with concise completion metering', async () => {
    const messages: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(openAIStreamResponse(['hello', ' world']))),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      streamJson: true,
      retry: {
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        rateLimitMs: 0,
        log: (message) => messages.push(message),
      },
    });

    await expect(provider.extract('prompt')).resolves.toBe('hello world');

    const output = messages.join('\n');
    expect(output).toContain('extraction stream complete');
    expect(output).toContain('2 text delta(s)');
    expect(output).not.toContain('hello world');
  });

  it('retries contentless extraction streams', async () => {
    const messages: string[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openAIStreamDataResponse([{ choices: [{ delta: { reasoning: 'no final content' } }] }]))
      .mockResolvedValueOnce(openAIStreamResponse(['{"assertions":[],"links":[]}']));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      streamJson: true,
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        rateLimitMs: 0,
        log: (message) => messages.push(message),
      },
    });

    await expect(provider.extract('prompt', { responseFormat: 'json' })).resolves.toContain('"assertions"');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(messages.join('\n')).toContain('after contentless stream');
  });

  it('treats whitespace-only extraction streams as contentless and falls back early', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openAIStreamResponse([' '.repeat(32), '\n'.repeat(32)]))
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
      streamJson: true,
      retry: {
        maxAttempts: 1,
        contentlessMaxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        rateLimitMs: 0,
      },
    });

    await expect(provider.extract('prompt', { responseFormat: 'json' })).resolves.toBe('{"assertions":[],"links":[]}');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({ stream: false });
  });

  it('rejects short whitespace-only extraction streams as contentless', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(openAIStreamResponse([' ', '\n']))),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    await expect(provider.extract('prompt', { responseFormat: 'text' })).rejects.toThrow('contentless stream');
  });

  it('falls back to non-streaming JSON extraction after contentless stream attempts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openAIStreamDataResponse([{ choices: [{ delta: { reasoning: 'first' } }] }]))
      .mockResolvedValueOnce(openAIStreamDataResponse([{ choices: [{ delta: { reasoning: 'second' } }] }]))
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
      streamJson: true,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    await expect(provider.extract('prompt', { responseFormat: 'json' })).resolves.toBe('{"assertions":[],"links":[]}');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({ stream: true });
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({ stream: true });
    expect(JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string)).toMatchObject({ stream: false });
  });

  it('stops JSON extraction streams after the first complete extraction object', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      choices: [{ delta: { content: '{"assertions":[],"links":[]}' } }],
                    })}\n\n`,
                  ),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: 200 },
          ),
        ),
      ),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      streamJson: true,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    await expect(provider.extract('prompt', { responseFormat: 'json' })).resolves.toBe('{"assertions":[],"links":[]}');

    expect(cancelled).toBe(true);
  });

  it('does not stop text extraction streams at JSON-looking content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(openAIStreamResponse(['{"assertions":[],"links":[]}', ' still text']))),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    await expect(provider.extract('prompt', { responseFormat: 'text' })).resolves.toBe(
      '{"assertions":[],"links":[]} still text',
    );
  });

  it('decodes non-streaming fallback content arrays', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: [{ type: 'text', text: '{"assertions":[],' }, { text: '"links":[]}' }] } }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    await expect(provider.extract('prompt', { responseFormat: 'json' })).resolves.toBe('{"assertions":[],"links":[]}');
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
    expect(output).toContain('embedding preparing HTTP POST 1/2 -> http://127.0.0.1:11434/api/embeddings');
    expect(output).toContain('embedding request body serialized 1/2');
    expect(output).toContain('embedding fetch invoked 1/2 -> http://127.0.0.1:11434/api/embeddings');
    expect(output).toContain('embedding preparing HTTP POST 2/2 -> http://127.0.0.1:11434/api/embeddings');
    expect(output).toContain('embedding fetch invoked 2/2 -> http://127.0.0.1:11434/api/embeddings');
    expect(output).toContain('embedding vector decoded 2/2: 2 dimension(s)');
  });

  it('retries retryable extraction HTTP failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(openAIStreamResponse(['{"assertions":[],"links":[]}']));
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

  it('retries temporary extraction HTTP 503 failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503, statusText: 'Unavailable' }))
      .mockResolvedValueOnce(openAIStreamResponse(['{"assertions":[],"links":[]}']));
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
        traceTimings: true,
        log: (message) => messages.push(message),
      },
    });

    await embedder.provider.embed(['hello']);

    expect(messages.join('\n')).toContain('HTTP 429');
    expect(messages.join('\n')).toContain('waiting 1 ms');
    expect(messages.join('\n')).toContain('response body complete');
  });

  it('includes rate-limit headers and response error bodies in extraction HTTP failures', async () => {
    const responseBody = {
      error: {
        message: 'Rate limit reached for gpt-4o-mini on tokens per min.',
        type: 'tokens',
        code: 'rate_limit_exceeded',
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(responseBody), {
          status: 429,
          statusText: 'Too Many Requests',
          headers: {
            'x-ratelimit-remaining-tokens': '0',
            'x-ratelimit-reset-tokens': '6m0s',
          },
        }),
      ),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    await expect(provider.extract('prompt')).rejects.toThrow(
      /x-ratelimit-remaining-tokens=0.*x-ratelimit-reset-tokens=6m0s.*Rate limit reached.*code=rate_limit_exceeded/,
    );
  });

  it('includes rate-limit headers and response error bodies in embedding HTTP failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Too many requests', type: 'requests' } }), {
          status: 429,
          statusText: 'Too Many Requests',
          headers: {
            'retry-after': '2',
            'x-ratelimit-reset-requests': '2s',
          },
        }),
      ),
    );
    const embedder = createOpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      dimension: 2,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    await expect(embedder.provider.embed(['hello'])).rejects.toThrow(
      /x-ratelimit-reset-requests=2s.*retry-after=2.*Too many requests.*type=requests/,
    );
  });

  it('rate-limits consecutive live provider requests after completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10_000);
    const fetchMock = vi.fn(() => Promise.resolve(openAIStreamResponse(['{"assertions":[],"links":[]}'])));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 5000 },
    });

    await provider.extract('first');
    const second = provider.extract('second');
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits from completion rather than request start before the next live provider request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10_000);
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(openAIStreamResponse(['{"assertions":[],"links":[]}']));
            }, 2000);
          }),
      )
      .mockResolvedValueOnce(openAIStreamResponse(['{"assertions":[],"links":[]}']));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 5000 },
    });

    const first = provider.extract('first');
    await vi.advanceTimersByTimeAsync(0);
    const second = provider.extract('second');
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits at least the configured rate limit before retrying HTTP 429 without retry headers', async () => {
    const startedAt: number[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => {
        startedAt.push(performance.now());
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'Too many requests' } }), { status: 429 }),
        );
      })
      .mockImplementationOnce(() => {
        startedAt.push(performance.now());
        return Promise.resolve(openAIStreamResponse(['{"assertions":[],"links":[]}']));
      });
    vi.stubGlobal('fetch', fetchMock);
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 50 },
    });

    await expect(provider.extract('prompt')).resolves.toContain('"assertions"');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((startedAt[1] ?? 0) - (startedAt[0] ?? 0)).toBeGreaterThanOrEqual(45);
  });

  it('uses rate-limit reset headers before retrying HTTP 429', async () => {
    const startedAt: number[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => {
        startedAt.push(performance.now());
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
            status: 429,
            headers: { 'x-ratelimit-reset-requests': '80ms' },
          }),
        );
      })
      .mockImplementationOnce(() => {
        startedAt.push(performance.now());
        return Promise.resolve(openAIStreamResponse(['{"assertions":[],"links":[]}']));
      });
    vi.stubGlobal('fetch', fetchMock);
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 50 },
    });

    await expect(provider.extract('prompt')).resolves.toContain('"assertions"');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((startedAt[1] ?? 0) - (startedAt[0] ?? 0)).toBeGreaterThanOrEqual(75);
  });

  it('does not log a prior-request wait before the first rate-limited request', async () => {
    const messages: string[] = [];
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10_000);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(openAIStreamResponse(['{"assertions":[],"links":[]}']))),
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

  it('does not retry extraction HTTP 500 failures', async () => {
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
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries fetch transport timeouts and reports the transport code', async () => {
    const messages: string[] = [];
    const timeout = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(openAIStreamResponse(['{"assertions":[],"links":[]}']));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        rateLimitMs: 0,
        log: (message) => messages.push(message),
      },
    });

    await expect(provider.extract('prompt')).resolves.toContain('"assertions"');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(messages.join('\n')).toContain('after transport UND_ERR_HEADERS_TIMEOUT');
  });

  it('passes configured timeout signals to OpenAI-compatible extraction fetches', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return Promise.resolve(openAIStreamResponse(['{"assertions":[],"links":[]}']));
      }),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, timeoutMs: 1234, rateLimitMs: 0 },
    });

    await expect(provider.extract('prompt')).resolves.toContain('"assertions"');

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('retries abort timeouts as provider transport failures', async () => {
    const messages: string[] = [];
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(openAIStreamResponse(['{"assertions":[],"links":[]}']));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        timeoutMs: 1,
        rateLimitMs: 0,
        log: (message) => messages.push(message),
      },
    });

    await expect(provider.extract('prompt')).resolves.toContain('"assertions"');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(messages.join('\n')).toContain('after transport PROVIDER_TIMEOUT');
  });

  it('uses a dedicated contentless stream retry cap before JSON fallback', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openAIStreamDataResponse([{ choices: [{ delta: { reasoning: 'first' } }] }]))
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
      streamJson: true,
      retry: {
        maxAttempts: 6,
        contentlessMaxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        rateLimitMs: 0,
      },
    });

    await expect(provider.extract('prompt', { responseFormat: 'json' })).resolves.toBe('{"assertions":[],"links":[]}');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({ stream: true });
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({ stream: false });
  });

  it('sanitizes fetch transport timeout failures after retry exhaustion', async () => {
    const timeout = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(timeout)),
    );
    const provider = createOpenAICompatibleExtractionProvider({
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-test',
      model: 'm',
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, rateLimitMs: 0 },
    });

    await expect(provider.extract('prompt')).rejects.toThrow(
      'Provider transport failed (UND_ERR_HEADERS_TIMEOUT): Headers Timeout Error',
    );
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

  it('renders a valid JSON example rather than pseudo-schema placeholders', () => {
    const prompt = buildExtractionPrompt('episode summary', [], makeEpisode(), 'correct', {
      src: 'source paragraph text',
    });

    expect(prompt).toContain('"confidence": 0.82');
    expect(prompt).not.toContain('<0..1>');
    expect(prompt).not.toContain('null |');
  });

  it('does not include fake prior assertion ids in first-episode link examples', () => {
    const prompt = buildExtractionPrompt('episode summary', [], makeEpisode(), 'correct', {
      src: 'source paragraph text',
    });

    expect(prompt).toContain('"links": []');
    expect(prompt).not.toContain('a-prior-claim-id');
    expect(prompt).toContain('If there is no real target assertion, emit an empty links array.');
  });

  it('uses real prior assertion ids in link examples when prior assertions exist', () => {
    const prompt = buildExtractionPrompt(
      'episode summary',
      [
        {
          id: 'a-real-prior',
          namespace: 'correct',
          type: 'fact',
          content: 'prior claim',
          validFrom: 1,
          validUntil: null,
          confidence: 0.9,
          sourceEpisodeId: 'prior-ep',
          supersedesId: null,
          entityId: null,
          entityType: null,
          extensions: {},
          createdAt: '2026-01-01T00:00:00Z',
          citations: [],
        },
      ],
      makeEpisode(),
      'correct',
      { src: 'source paragraph text' },
    );

    expect(prompt).toContain('"toId": "a-real-prior"');
    expect(prompt).not.toContain('a-prior-claim-id');
  });

  it('requires extraction JSON in final visible assistant content', () => {
    const prompt = buildExtractionPrompt('episode summary', [], makeEpisode(), 'correct', {
      src: 'source paragraph text',
    });

    expect(prompt).toContain('final visible assistant message');
    expect(prompt).toContain('do not return an empty assertions array for a non-empty document');
    expect(prompt).toContain('Emit JSON only in the final answer content');
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
      store: store as unknown as TragetiStore,
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
        store: store as unknown as TragetiStore,
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
        store: store as unknown as TragetiStore,
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
      store: store as unknown as TragetiStore,
      episode: makeEpisode(),
      document: 'episode summary',
      namespace: 'correct',
      citationSources: { 'source.md': 'hello world' },
      extractor,
    });

    expect(store.assertions[0]?.citations[0]?.excerpt).toBe('world');
  });

  it('runs parsed sanitizer before citation resolution and result sanitizer afterward', async () => {
    const store = new FakeStore();
    const observed: string[] = [];
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
                excerptStart: '100',
                excerptEnd: '200',
              },
            ],
          },
        ],
        links: [],
      }),
    );

    await ingest({
      store: store as unknown as TragetiStore,
      episode: makeEpisode(),
      document: 'episode summary',
      namespace: 'correct',
      citationSources: { 'source.md': 'hello world' },
      extractor,
      sanitizeParsedExtractionResult(result) {
        observed.push(`parsed:${String(result.assertions[0]?.citations[0]?.excerpt ?? null)}`);
        return {
          assertions: result.assertions.map((assertion) => ({
            ...assertion,
            citations: assertion.citations.map((citation) => ({
              ...citation,
              excerptStart: '0',
              excerptEnd: '5',
            })),
          })),
          links: result.links,
        };
      },
      sanitizeExtractionResult(result) {
        observed.push(`resolved:${String(result.assertions[0]?.citations[0]?.excerpt ?? null)}`);
        return result;
      },
    });

    expect(observed).toEqual(['parsed:null', 'resolved:hello']);
    expect(store.assertions[0]?.citations[0]?.excerpt).toBe('hello');
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
      store: store as unknown as TragetiStore,
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
        store: store as unknown as TragetiStore,
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
        store: store as unknown as TragetiStore,
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
        store: store as unknown as TragetiStore,
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

  it('throws when DEMO_EXTRACT_PROVIDER=anthropic and DEMO_EMBED_PROVIDER=fixture', () => {
    expect(() =>
      resolveDemoProviders({
        ...minOptions,
        env: {
          DEMO_EXTRACT_PROVIDER: 'anthropic',
          DEMO_EXTRACT_API_KEY: 'sk-ant-test',
          DEMO_EMBED_PROVIDER: 'fixture',
        },
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
          DEMO_EXTRACT_API_KEY: 'sk-test',
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
          DEMO_EMBED_API_KEY: 'sk-test',
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

function openAIStreamResponse(chunks: string[]): Response {
  return openAIStreamDataResponse(chunks.map((chunk) => ({ choices: [{ delta: { content: chunk } }] })));
}

function openAIStreamDataResponse(data: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const item of data) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function requestUrlString(value: string | URL | Request | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof URL) return value.href;
  return value?.url;
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

function dataValue(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const part of path) {
    if (typeof part === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
    } else {
      if (current === null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
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
