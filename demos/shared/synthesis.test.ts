import { describe, expect, it, vi } from 'vitest';
import type { AssembledContext, RetrievedAssertion, TragetiStore } from 'trageti';
import type { ExtractionProvider } from './providers.js';
import { generateAssembledAnswer } from './synthesis.js';

describe('generateAssembledAnswer', () => {
  it('builds a deterministic template answer from highest-signal assembled assertions', async () => {
    const store = storeWithContext(
      contextWithAssertions([
        assertion('low', 'Lower-ranked support should be omitted from the short answer.', 0.1, 1),
        assertion('high', 'Retrieval now returns a metadata envelope with warnings.', 0.9, 3),
        assertion('mid', 'The result contract includes scores and cited assertions.', 0.6, 2),
      ]),
    );

    const result = await generateAssembledAnswer({
      store,
      extractor: fixtureExtractor(),
      annotation: '"What is the current retrieval result contract?"',
      query: {
        namespace: 'demo',
        queryText: 'What is the current retrieval result contract?',
        temporalAnchor: 3,
        retrievalStrategy: 'hybrid',
      },
    });

    expect(result.mode).toBe('template');
    expect(result.text).toContain('Retrieval now returns a metadata envelope with warnings');
    expect(result.text).toContain('The result contract includes scores and cited assertions');
    expect(result.context).toMatchObject({
      includedAssertions: 3,
      totalAssertions: 3,
      tokenEstimate: 99,
      truncated: false,
      positionRange: { from: 1, to: 3 },
    });
  });

  it('returns a clear unsupported answer for empty context', async () => {
    const result = await generateAssembledAnswer({
      store: storeWithContext(contextWithAssertions([])),
      extractor: fixtureExtractor(),
      annotation: '"missing"',
      query: { namespace: 'demo', queryText: 'missing', temporalAnchor: 1 },
    });

    expect(result.text).toBe(
      'The assembled context did not include any assertions for this query, so the demo cannot synthesize a supported answer.',
    );
    expect(result.context.includedAssertions).toBe(0);
  });

  it('surfaces truncated context in the template answer and metadata', async () => {
    const ctx = contextWithAssertions([
      assertion('a', 'Only the first supporting claim fit the context budget.', 1, 1),
    ]);
    ctx.truncated = true;

    const result = await generateAssembledAnswer({
      store: storeWithContext(ctx),
      extractor: fixtureExtractor(),
      annotation: '"truncated"',
      query: { namespace: 'demo', queryText: 'truncated', temporalAnchor: 1 },
    });

    expect(result.context.truncated).toBe(true);
    expect(result.text).toContain('The context was truncated');
  });

  it('uses the live extractor with a grounded prompt when configured', async () => {
    const extract = vi.fn<(prompt: string) => Promise<string>>(() => Promise.resolve('live answer'));
    const extractor = liveExtractor(extract);
    const ctx = contextWithAssertions([assertion('a', 'Context claim.', 1, 1)]);

    const result = await generateAssembledAnswer({
      store: storeWithContext(ctx),
      extractor,
      annotation: '"live query"',
      query: {
        namespace: 'demo',
        queryText: 'live query',
        temporalAnchor: 7,
        mode: 'trajectory',
      },
    });

    expect(result.mode).toBe('live');
    expect(result.text).toBe('live answer');
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0]?.[0]).toContain('Query text: live query');
    expect(extract.mock.calls[0]?.[0]).toContain('Context claim.');
    expect(extract.mock.calls[0]?.[0]).toContain('Retrieval mode: trajectory');
  });

  it('falls back to the template answer when live synthesis keeps returning empty output', async () => {
    const extract = vi.fn<(prompt: string) => Promise<string>>(() => Promise.resolve('   '));
    const warnings: string[] = [];
    const ctx = contextWithAssertions([assertion('a', 'A supported claim from context.', 1, 1)]);

    const result = await generateAssembledAnswer({
      store: storeWithContext(ctx),
      extractor: liveExtractor(extract),
      annotation: '"degraded"',
      query: { namespace: 'demo', queryText: 'degraded', temporalAnchor: 1 },
      logger: { warn: (m) => warnings.push(m) },
    });

    expect(result.mode).toBe('template');
    expect(result.text).toContain('A supported claim from context');
    expect(extract).toHaveBeenCalledTimes(2);
    expect(warnings.join('\n')).toContain('falling back to template synthesis');
  });

  it('falls back to template synthesis when the live extractor throws', async () => {
    const extract = vi.fn<(prompt: string) => Promise<string>>(() => Promise.reject(new Error('provider down')));
    const warnings: string[] = [];
    const ctx = contextWithAssertions([assertion('a', 'Another supported claim.', 1, 1)]);

    const result = await generateAssembledAnswer({
      store: storeWithContext(ctx),
      extractor: liveExtractor(extract),
      annotation: '"errored"',
      query: { namespace: 'demo', queryText: 'errored', temporalAnchor: 1 },
      logger: { warn: (m) => warnings.push(m) },
    });

    expect(result.mode).toBe('template');
    expect(warnings.join('\n')).toContain('failed: provider down');
  });
});

function storeWithContext(ctx: AssembledContext): Pick<TragetiStore, 'assembleContext'> {
  return {
    assembleContext() {
      return Promise.resolve(ctx);
    },
  };
}

function contextWithAssertions(assertions: RetrievedAssertion[]): AssembledContext {
  const positions = assertions.map((a) => a.validFrom);
  return {
    text: assertions.map((a) => a.content).join('\n'),
    assertions,
    tokenEstimate: 99,
    truncated: false,
    metadata: {},
    coverage: {
      totalAssertions: assertions.length,
      includedAssertions: assertions.length,
      positionRange: {
        from: positions.length > 0 ? Math.min(...positions) : 0,
        to: positions.length > 0 ? Math.max(...positions) : 0,
      },
    },
  };
}

function assertion(id: string, content: string, score: number, validFrom: number): RetrievedAssertion {
  return {
    id,
    namespace: 'demo',
    type: 'fact',
    content,
    validFrom,
    validUntil: null,
    confidence: 0.9,
    sourceEpisodeId: 'episode-1',
    supersedesId: null,
    entityId: null,
    entityType: null,
    citations: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    extensions: {},
    score,
    scoreComponents: {
      semanticDistance: null,
      bm25Score: null,
      position: validFrom,
    },
  };
}

function fixtureExtractor(): ExtractionProvider {
  return {
    name: 'fixture',
    label: 'fixture',
    provenance: { kind: 'fixture', model: 'fixtures', configHash: 'fixture' },
    extract() {
      return Promise.reject(new Error('fixture extractor should not be called for template synthesis'));
    },
  };
}

function liveExtractor(extract: (prompt: string) => Promise<string>): ExtractionProvider {
  return {
    name: 'live',
    label: 'live',
    provenance: { kind: 'openai-compatible', model: 'test', configHash: 'live' },
    extract,
  };
}
