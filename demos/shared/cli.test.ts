import { describe, expect, it } from 'vitest';
import type { DemoEmbeddingProvider } from './providers.js';
import { assertCustomQuerySupported, buildCustomRetrievalQuery, parseDemoCliOptions } from './cli.js';

describe('parseDemoCliOptions', () => {
  it('parses --query value', () => {
    expect(parseDemoCliOptions(['node', 'index.ts', '--query', '  Who taught Alex knife skills?  '])).toEqual({
      query: 'Who taught Alex knife skills?',
    });
  });

  it('parses --query=value and coexists with llm trace flags', () => {
    expect(parseDemoCliOptions(['node', 'index.ts', '--llm-trace=full', '--query=How did retrieval improve?'])).toEqual(
      {
        query: 'How did retrieval improve?',
      },
    );
  });

  it('rejects missing or empty query values', () => {
    expect(() => parseDemoCliOptions(['node', 'index.ts', '--query'])).toThrow('--query requires');
    expect(() => parseDemoCliOptions(['node', 'index.ts', '--query', '--llm-trace'])).toThrow('--query requires');
    expect(() => parseDemoCliOptions(['node', 'index.ts', '--query=   '])).toThrow('--query requires');
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
