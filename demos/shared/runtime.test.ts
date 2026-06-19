import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import type {
  Assertion,
  AssertionCitation,
  AssertionLink,
  Episode,
  NewAssertionInput,
  NewAssertionLinkInput,
  NewEpisodeInput,
  TragetiStore,
} from 'trageti';
import { demoDataVersion, ensureDemoMetadata, ingestEpisodes, ingestPreparedUnits } from './runtime.js';
import { resolveDemoProviders, type ResolvedDemoProviders } from './providers.js';
import { sanitizeForTerminal } from './sanitize.js';

const BASE_EPISODES: NewEpisodeInput[] = [
  {
    id: 'ep-1',
    namespace: 'test',
    position: 1,
    type: 'doc',
    content: 'hello world',
    occurredAt: '2026-01-01T00:00:00Z',
  },
];
const BASE_FIXTURES: Record<string, string> = { 'ep-1': '{"assertions":[],"links":[]}' };
const BASE_ASSERTION_EMBEDDINGS: Record<string, number[]> = { 'a-1': [0.1, 0.2] };
const BASE_QUERY_TEXTS = ['what is hello?'];
const BASE_QUERY_EMBEDDINGS: Record<string, number[]> = { 'what is hello?': [0.3, 0.4] };

function version(
  overrides: {
    episodes?: NewEpisodeInput[];
    fixtures?: Record<string, string>;
    assertionEmbeddings?: Record<string, number[]>;
    queryEmbeddings?: Record<string, number[]>;
    queryTexts?: string[];
  } = {},
): string {
  return demoDataVersion(
    'test-demo',
    overrides.episodes ?? BASE_EPISODES,
    overrides.fixtures ?? BASE_FIXTURES,
    overrides.assertionEmbeddings ?? BASE_ASSERTION_EMBEDDINGS,
    overrides.queryEmbeddings ?? BASE_QUERY_EMBEDDINGS,
    overrides.queryTexts ?? BASE_QUERY_TEXTS,
  );
}

describe('demoDataVersion', () => {
  it('is idempotent — same data produces same version', () => {
    expect(version()).toBe(version());
  });

  it('is different when episode content changes', () => {
    const base = BASE_EPISODES[0];
    if (!base) throw new Error('fixture');
    const modified = [{ ...base, content: 'goodbye world' }];
    expect(version({ episodes: modified })).not.toBe(version());
  });

  it('is different when a fixture value changes', () => {
    const modified = { 'ep-1': '{"assertions":[{"id":"x"}],"links":[]}' };
    expect(version({ fixtures: modified })).not.toBe(version());
  });

  it('is different when an assertion embedding vector changes', () => {
    const modified = { 'a-1': [0.9, 0.8] };
    expect(version({ assertionEmbeddings: modified })).not.toBe(version());
  });

  it('is different when a query embedding vector changes', () => {
    const modified = { q1: [0.9, 0.8] };
    expect(version({ queryEmbeddings: modified })).not.toBe(version());
  });

  it('is different when a query text changes', () => {
    expect(version({ queryTexts: ['different query?'] })).not.toBe(version());
  });

  it('is the same regardless of key insertion order (deterministic)', () => {
    const v1 = demoDataVersion(
      'test-demo',
      BASE_EPISODES,
      BASE_FIXTURES,
      { b: [1], a: [2] },
      BASE_QUERY_EMBEDDINGS,
      BASE_QUERY_TEXTS,
    );
    const v2 = demoDataVersion(
      'test-demo',
      BASE_EPISODES,
      BASE_FIXTURES,
      { a: [2], b: [1] },
      BASE_QUERY_EMBEDDINGS,
      BASE_QUERY_TEXTS,
    );
    expect(v1).toBe(v2);
  });
});

describe('sanitizeForTerminal', () => {
  it('strips ANSI and unsafe controls while preserving layout', () => {
    expect(sanitizeForTerminal('\u001b[31mred\u001b[0m\nnext\tcol\u0007')).toBe('red\nnext\tcol');
  });
});

describe('ensureDemoMetadata', () => {
  const dbFiles: string[] = [];

  function tempDb(): string {
    const p = join(tmpdir(), `trageti-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbFiles.push(p);
    return p;
  }

  afterEach(() => {
    for (const p of dbFiles.splice(0)) {
      if (existsSync(p)) rmSync(p);
    }
  });

  it('throws when called again with changed data version', () => {
    const database = tempDb();
    const providers = resolveDemoProviders({
      fixtures: BASE_FIXTURES,
      assertionEmbeddings: BASE_ASSERTION_EMBEDDINGS,
      queryEmbeddings: BASE_QUERY_EMBEDDINGS,
      queryTexts: BASE_QUERY_TEXTS,
      embeddingDimension: 2,
      env: {},
      providerSelection: { provider: 'fixture' },
    });

    ensureDemoMetadata({ database, demoName: 'test-demo', dataVersion: version(), providers });

    const modifiedFixtures = { 'ep-1': '{"assertions":[{"id":"changed"}],"links":[]}' };
    const v2 = version({ fixtures: modifiedFixtures });

    expect(() => {
      ensureDemoMetadata({ database, demoName: 'test-demo', dataVersion: v2, providers });
    }).toThrow('built with different');
  });
});

describe('ingestEpisodes resume checks', () => {
  it('re-indexes pending assertions on rerun', async () => {
    const store = new ResumeStore([makeAssertion('a-1')], [{ id: 'a-1', content: 'hello world' }]);

    await ingestEpisodes({
      store: store as unknown as TragetiStore,
      namespace: 'test',
      episodes: BASE_EPISODES,
      providers: fixtureProviders(),
    });

    expect(store.indexedIds).toEqual(['a-1']);
  });

  it('fails clearly when an existing episode has no assertions', async () => {
    const store = new ResumeStore([], []);

    await expect(
      ingestEpisodes({
        store: store as unknown as TragetiStore,
        namespace: 'test',
        episodes: BASE_EPISODES,
        providers: fixtureProviders(),
      }),
    ).rejects.toThrow('exists but has no assertions');
  });

  it('emits no embedding trace when trace is disabled', async () => {
    const messages: string[] = [];
    const store = new FreshIngestStore();

    await ingestEpisodes({
      store: store as unknown as TragetiStore,
      namespace: 'test',
      episodes: BASE_EPISODES,
      providers: providersWithOneAssertion(),
      trace: fakeTrace(false, messages),
    });

    expect(messages).toEqual([]);
  });

  it('traces fresh assertion embedding/indexing progress', async () => {
    const messages: string[] = [];
    const store = new FreshIngestStore();

    await ingestEpisodes({
      store: store as unknown as TragetiStore,
      namespace: 'test',
      episodes: BASE_EPISODES,
      providers: providersWithOneAssertion(),
      trace: fakeTrace(true, messages),
    });

    expect(messages.join('\n')).toContain('Embedding/indexing start -> ep-1: 1 assertion(s)');
    expect(messages.join('\n')).toContain('fixture / raw-vector');
    expect(messages.join('\n')).toContain('Embedding/indexing complete <- ep-1: indexed 1, skipped 0');
  });

  it('traces pending embedding retry progress', async () => {
    const messages: string[] = [];
    const store = new ResumeStore([makeAssertion('a-1')], [{ id: 'a-1', content: 'hello world' }]);

    await ingestEpisodes({
      store: store as unknown as TragetiStore,
      namespace: 'test',
      episodes: BASE_EPISODES,
      providers: fixtureProviders(),
      trace: fakeTrace(true, messages),
    });

    expect(messages.join('\n')).toContain('Pending embedding retry start -> 1 assertion(s)');
    expect(messages.join('\n')).toContain('Pending embedding retry complete <- indexed 1, skipped 0');
  });

  it('logs normal extraction request details without trace mode', async () => {
    const details: string[] = [];
    const store = new FreshIngestStore();

    await ingestEpisodes({
      store: store as unknown as TragetiStore,
      namespace: 'test',
      episodes: BASE_EPISODES,
      providers: providersWithOneAssertion(),
      logger: captureLogger(details),
    });

    const output = details.join('\n');
    expect(output).toContain('Extracting ep-1: doc position 1 via fixture (json, prompt ~');
    expect(output).toContain('Document: "hello world"');
    expect(output).toContain('Source refs: episode document');
    expect(output).toContain('Extraction complete: 1 claim, no links');
  });

  it('wraps extraction failures with safe prepared unit context', async () => {
    const longSource = 'SECRET FULL SOURCE '.repeat(40);
    const store = new FreshIngestStore();

    try {
      await ingestPreparedUnits({
        store: store as unknown as TragetiStore,
        namespace: 'test',
        units: [
          {
            id: 'unit-1',
            episode: BASE_EPISODES[0] ?? fail('missing episode'),
            document: 'Short safe document text for the failing request.',
            citationSources: { 'source.md': longSource },
          },
        ],
        providers: providersWithFailingExtractor(),
      });
      throw new Error('expected ingestion to fail');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(
        /Extraction failed for prepared unit "unit-1" \/ episode "ep-1"[\s\S]*Provider: failing-provider; responseFormat=json[\s\S]*Source refs: source\.md[\s\S]*Cause: provider failed HTTP 500/,
      );
      expect(message).not.toContain('SECRET FULL SOURCE');
    }
  });
});

function fixtureProviders(): ResolvedDemoProviders {
  return resolveDemoProviders({
    fixtures: BASE_FIXTURES,
    assertionEmbeddings: BASE_ASSERTION_EMBEDDINGS,
    queryEmbeddings: BASE_QUERY_EMBEDDINGS,
    queryTexts: BASE_QUERY_TEXTS,
    embeddingDimension: 2,
    env: {},
    providerSelection: { provider: 'fixture' },
  });
}

function providersWithOneAssertion(): ResolvedDemoProviders {
  return resolveDemoProviders({
    fixtures: {
      'ep-1': JSON.stringify({
        assertions: [
          {
            id: 'a-1',
            namespace: 'ignored',
            type: 'fact',
            content: 'hello world',
            validFrom: 1,
            confidence: 1,
            sourceEpisodeId: 'ignored',
            citations: [
              {
                id: 'c-1',
                episodeId: 'ignored',
                sourceRef: 'src',
                excerpt: null,
                excerptStart: '0',
                excerptEnd: '5',
              },
            ],
          },
        ],
        links: [],
      }),
    },
    assertionEmbeddings: { 'a-1': [0.1, 0.2] },
    queryEmbeddings: BASE_QUERY_EMBEDDINGS,
    queryTexts: BASE_QUERY_TEXTS,
    embeddingDimension: 2,
    env: {},
    providerSelection: { provider: 'fixture' },
  });
}

function providersWithFailingExtractor(): ResolvedDemoProviders {
  const providers = fixtureProviders();
  return {
    ...providers,
    extractor: {
      name: 'failing',
      label: 'failing-provider',
      provenance: { kind: 'openai-compatible', configHash: 'fail' },
      extract() {
        return Promise.reject(new Error('provider failed HTTP 500'));
      },
    },
    provenance: {
      ...providers.provenance,
      extraction: { kind: 'openai-compatible', configHash: 'fail' },
    },
  };
}

function fakeTrace(enabled: boolean, messages: string[]) {
  return {
    enabled,
    includePayloads: false,
    includeRawVectors: false,
    log(message: string) {
      messages.push(message);
    },
  };
}

function captureLogger(details: string[]) {
  return {
    step(message: string) {
      details.push(message);
    },
    detail(message: string) {
      details.push(message);
    },
    success(message: string) {
      details.push(message);
    },
    warn(message: string) {
      details.push(message);
    },
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function makeAssertion(id: string): Assertion {
  return {
    id,
    namespace: 'test',
    type: 'fact',
    content: 'hello world',
    validFrom: 1,
    validUntil: null,
    confidence: 1,
    sourceEpisodeId: 'ep-1',
    supersedesId: null,
    entityId: null,
    entityType: null,
    citations: [],
    extensions: {},
    createdAt: '2026-01-01T00:00:00Z',
  };
}

class ResumeStore {
  readonly indexedIds: string[] = [];

  constructor(
    private readonly assertions: Assertion[],
    private pending: Array<{ id: string; content: string }>,
  ) {}

  getEpisode(id: string): Promise<Episode | null> {
    if (id !== 'ep-1') return Promise.resolve(null);
    const episode = BASE_EPISODES[0];
    if (!episode) throw new Error('missing fixture episode');
    return Promise.resolve({ ...episode, createdAt: '2026-01-01T00:00:00Z', extensions: {} });
  }

  getAssertions(): Promise<Assertion[]> {
    return Promise.resolve([...this.assertions]);
  }

  getPendingIndexing(): Promise<Array<{ id: string; content: string }>> {
    return Promise.resolve([...this.pending]);
  }

  indexBatch(items: Array<{ assertionId: string }>): Promise<{ indexed: number; skipped: unknown[] }> {
    this.indexedIds.push(...items.map((item) => item.assertionId));
    this.pending = [];
    return Promise.resolve({ indexed: items.length, skipped: [] });
  }
}

class FreshIngestStore {
  readonly episodes: Array<NewEpisodeInput> = [];
  readonly assertions: Assertion[] = [];
  readonly links: Array<NewAssertionLinkInput> = [];
  readonly indexedIds: string[] = [];

  getEpisode(): Promise<Episode | null> {
    return Promise.resolve(null);
  }

  writeEpisode(episode: NewEpisodeInput): Promise<Episode> {
    this.episodes.push(episode);
    return Promise.resolve({ ...episode, createdAt: '2026-01-01T00:00:00Z', extensions: {} });
  }

  writeAssertion(assertion: NewAssertionInput): Promise<Assertion> {
    const citations: AssertionCitation[] = assertion.citations.map((citation) => ({
      ...citation,
      assertionId: assertion.id,
      createdAt: '2026-01-01T00:00:00Z',
    }));
    const stored: Assertion = {
      ...assertion,
      validUntil: assertion.validUntil ?? null,
      supersedesId: assertion.supersedesId ?? null,
      entityId: assertion.entityId ?? null,
      entityType: assertion.entityType ?? null,
      citations,
      extensions: {},
      createdAt: '2026-01-01T00:00:00Z',
    };
    this.assertions.push(stored);
    return Promise.resolve(stored);
  }

  writeLink(link: NewAssertionLinkInput): Promise<AssertionLink> {
    this.links.push(link);
    return Promise.resolve({ ...link, createdAt: '2026-01-01T00:00:00Z', extensions: {} });
  }

  getAssertions(): Promise<Assertion[]> {
    return Promise.resolve([...this.assertions]);
  }

  getPendingIndexing(): Promise<Array<{ id: string; content: string }>> {
    return Promise.resolve([]);
  }

  indexBatch(items: Array<{ assertionId: string }>): Promise<{ indexed: number; skipped: unknown[] }> {
    this.indexedIds.push(...items.map((item) => item.assertionId));
    return Promise.resolve({ indexed: items.length, skipped: [] });
  }
}
