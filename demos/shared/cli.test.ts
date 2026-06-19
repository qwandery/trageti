import { describe, expect, it } from 'vitest';
import type { DemoEmbeddingProvider } from './providers.js';
import {
  assertCustomQuerySupported,
  buildCustomRetrievalQuery,
  envWithDemoRateLimit,
  parseDemoCliOptions,
  warmupDemoProviders,
} from './cli.js';
import type { ResolvedDemoProviders } from './providers.js';

describe('parseDemoCliOptions', () => {
  it('parses --query value', () => {
    expect(parseDemoCliOptions(['node', 'index.ts', '--query', '  Who taught Alex knife skills?  '])).toEqual({
      query: 'Who taught Alex knife skills?',
      rateLimitSeconds: null,
      warmup: false,
      providerSelection: {},
    });
  });

  it('parses --query=value and coexists with llm trace flags', () => {
    expect(
      parseDemoCliOptions([
        'node',
        'index.ts',
        '--llm-trace=full',
        '--limit',
        '60',
        '--warmup',
        '--query=How did retrieval improve?',
      ]),
    ).toEqual({
      query: 'How did retrieval improve?',
      rateLimitSeconds: 60,
      warmup: true,
      providerSelection: {},
    });
  });

  it('parses --limit=value', () => {
    expect(parseDemoCliOptions(['node', 'index.ts', '--limit=2.5'])).toEqual({
      query: null,
      rateLimitSeconds: 2.5,
      warmup: false,
      providerSelection: {},
    });
  });

  it('parses provider shortcut and typed provider overrides', () => {
    expect(
      parseDemoCliOptions([
        'node',
        'index.ts',
        '--provider',
        'openrouter-gpt-mini',
        '--provider:embed=ollama-embed',
        '--provider:vision',
        'ollama',
      ]).providerSelection,
    ).toEqual({
      provider: 'openrouter-gpt-mini',
      embed: 'ollama-embed',
      vision: 'ollama',
    });
  });

  it('rejects missing or empty query values', () => {
    expect(() => parseDemoCliOptions(['node', 'index.ts', '--query'])).toThrow('--query requires');
    expect(() => parseDemoCliOptions(['node', 'index.ts', '--query', '--llm-trace'])).toThrow('--query requires');
    expect(() => parseDemoCliOptions(['node', 'index.ts', '--query=   '])).toThrow('--query requires');
  });

  it('rejects invalid limit values', () => {
    expect(() => parseDemoCliOptions(['node', 'index.ts', '--limit'])).toThrow('--limit requires');
    expect(() => parseDemoCliOptions(['node', 'index.ts', '--limit=-1'])).toThrow('--limit requires');
    expect(() => parseDemoCliOptions(['node', 'index.ts', '--limit=nope'])).toThrow('--limit requires');
  });

  it('rejects invalid provider flag values', () => {
    expect(() => parseDemoCliOptions(['node', 'index.ts', '--provider'])).toThrow('--provider requires');
    expect(() => parseDemoCliOptions(['node', 'index.ts', '--provider=one,two'])).toThrow('one provider id');
    expect(() =>
      parseDemoCliOptions(['node', 'index.ts', '--provider:extract=openai', '--provider:extract=anthropic']),
    ).toThrow('specified more than once');
  });
});

describe('warmupDemoProviders', () => {
  it('warms live extraction and embedding providers', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    await warmupDemoProviders({
      providers: providersForWarmup(calls, 'openai-compatible', 'openai-compatible'),
      logger: fakeLogger(logs),
    });

    expect(calls).toEqual(['extract:Warm up. Reply with: ok', 'embed:warmup']);
    expect(logs.join('\n')).toContain('Warming live providers');
    expect(logs.join('\n')).toContain('Extraction provider warmed');
    expect(logs.join('\n')).toContain('Embedding provider warmed');
  });

  it('skips fixture warmup providers', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    await warmupDemoProviders({
      providers: providersForWarmup(calls, 'fixture', 'fixture'),
      logger: fakeLogger(logs),
    });

    expect(calls).toEqual([]);
    expect(logs.join('\n')).toContain('Extraction warmup skipped for fixture provider');
    expect(logs.join('\n')).toContain('Embedding warmup skipped for fixture provider');
  });
});

describe('envWithDemoRateLimit', () => {
  it('overrides DEMO_RATE_LIMIT when CLI limit is supplied', () => {
    expect(envWithDemoRateLimit({ DEMO_RATE_LIMIT: '5' }, 60)['DEMO_RATE_LIMIT']).toBe('60');
  });

  it('returns the original env object when CLI limit is absent', () => {
    const env = { DEMO_RATE_LIMIT: '5' };
    expect(envWithDemoRateLimit(env, null)).toBe(env);
  });
});

describe('custom query helpers', () => {
  it('builds the standard custom retrieval query shape', () => {
    expect(
      buildCustomRetrievalQuery({
        namespace: 'demo',
        queryText: 'What changed?',
        temporalAnchor: 10,
      }),
    ).toEqual({
      namespace: 'demo',
      queryText: 'What changed?',
      temporalAnchor: 10,
      retrievalStrategy: 'hybrid',
      mode: 'snapshot',
      expandLinks: true,
      maxDepth: 1,
      limit: 25,
    });
  });

  it('rejects fixture embedding providers for custom queries', () => {
    expect(() => {
      assertCustomQuerySupported(embedder('fixture'));
    }).toThrow('Custom --query is not supported');
    expect(() => {
      assertCustomQuerySupported(embedder('openai-compatible'));
    }).not.toThrow();
  });
});

function embedder(kind: DemoEmbeddingProvider['provenance']['kind']): DemoEmbeddingProvider {
  return {
    name: kind,
    label: kind,
    provenance: { kind, configHash: kind },
    provider: {
      name: kind,
      dimension: 2,
      embed() {
        return Promise.resolve([new Float32Array([1, 0])]);
      },
    },
  };
}

function providersForWarmup(
  calls: string[],
  extractionKind: ResolvedDemoProviders['extractor']['provenance']['kind'],
  embeddingKind: DemoEmbeddingProvider['provenance']['kind'],
): ResolvedDemoProviders {
  const extractor = {
    name: extractionKind,
    label: extractionKind,
    provenance: { kind: extractionKind, configHash: extractionKind },
    extract(prompt: string) {
      calls.push(`extract:${prompt}`);
      return Promise.resolve('ok');
    },
  };
  const warmupEmbedder: DemoEmbeddingProvider = {
    name: embeddingKind,
    label: embeddingKind,
    provenance: { kind: embeddingKind, configHash: embeddingKind },
    provider: {
      name: embeddingKind,
      dimension: 2,
      embed(texts: readonly string[]) {
        calls.push(...texts.map((text) => `embed:${text}`));
        return Promise.resolve(texts.map(() => new Float32Array([1, 0])));
      },
    },
  };
  return {
    modeLabel: 'test',
    isLive: extractionKind !== 'fixture' || embeddingKind !== 'fixture',
    extractor,
    embedder: warmupEmbedder,
    provenance: { extraction: extractor.provenance, embedding: warmupEmbedder.provenance },
  };
}

function fakeLogger(logs: string[]) {
  return {
    step(message: string) {
      logs.push(`step:${message}`);
    },
    detail(message: string) {
      logs.push(`detail:${message}`);
    },
    success(message: string) {
      logs.push(`success:${message}`);
    },
    warn(message: string) {
      logs.push(`warn:${message}`);
    },
  };
}
