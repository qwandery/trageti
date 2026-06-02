import { describe, expect, it } from 'vitest';
import type { DemoEmbeddingProvider } from './providers.js';
import {
  assertCustomQuerySupported,
  buildCustomRetrievalQuery,
  envWithDemoRateLimit,
  parseDemoCliOptions,
} from './cli.js';

describe('parseDemoCliOptions', () => {
  it('parses --query value', () => {
    expect(parseDemoCliOptions(['node', 'index.ts', '--query', '  Who taught Alex knife skills?  '])).toEqual({
      query: 'Who taught Alex knife skills?',
      rateLimitSeconds: null,
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
        '--query=How did retrieval improve?',
      ]),
    ).toEqual({
      query: 'How did retrieval improve?',
      rateLimitSeconds: 60,
    });
  });

  it('parses --limit=value', () => {
    expect(parseDemoCliOptions(['node', 'index.ts', '--limit=2.5'])).toEqual({
      query: null,
      rateLimitSeconds: 2.5,
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
