import { describe, expect, it } from 'vitest';
import type { Episode, NewAssertionInput, NewAssertionLinkInput, NewEpisodeInput, TragetiStore } from 'trageti';
import { ingest, ExtractionValidationError } from './ingest.js';
import type { ExtractionProvider } from './providers.js';

describe('ingest re-attempt and degradation', () => {
  it('re-prompts with corrective feedback and succeeds on a later attempt', async () => {
    const store = new FakeStore();
    const extractor = sequencedProvider([
      citationResponse({ excerptStart: '0', excerptEnd: '999' }),
      citationResponse({ excerptStart: '0', excerptEnd: '5' }),
    ]);
    const warnings: string[] = [];

    const result = await ingest({
      store: store as unknown as TragetiStore,
      episode: makeEpisode(),
      document: 'doc',
      namespace: 'demo',
      citationSources: { 'src.md': 'hello world' },
      extractor,
      maxValidationAttempts: 2,
      logger: { warn: (m) => warnings.push(m) },
    });

    expect(extractor.calls).toBe(2);
    expect(result.assertions[0]?.citations[0]?.excerpt).toBe('hello');
    expect(store.episodes).toHaveLength(1);
    // The second prompt must carry corrective feedback about the bad offsets.
    expect(extractor.prompts[1]).toContain('CORRECTION REQUIRED');
    expect(warnings.join('\n')).toContain('re-attempt 2/2');
  });

  it('throws ExtractionValidationError when re-attempts are exhausted and degradation is off', async () => {
    const store = new FakeStore();
    const extractor = sequencedProvider([citationResponse({ excerptStart: '0', excerptEnd: '999' })]);

    await expect(
      ingest({
        store: store as unknown as TragetiStore,
        episode: makeEpisode(),
        document: 'doc',
        namespace: 'demo',
        citationSources: { 'src.md': 'hello world' },
        extractor,
        maxValidationAttempts: 2,
      }),
    ).rejects.toBeInstanceOf(ExtractionValidationError);
    expect(extractor.calls).toBe(2);
    expect(store.episodes).toHaveLength(0);
  });

  it('repairs out-of-bounds offsets by clamping when degradation is enabled', async () => {
    const store = new FakeStore();
    const extractor = sequencedProvider([citationResponse({ excerptStart: '0', excerptEnd: '999' })]);
    const warnings: string[] = [];

    const result = await ingest({
      store: store as unknown as TragetiStore,
      episode: makeEpisode(),
      document: 'doc',
      namespace: 'demo',
      citationSources: { 'src.md': 'hello world' },
      extractor,
      maxValidationAttempts: 1,
      degradeCitationsOnFailure: true,
      logger: { warn: (m) => warnings.push(m) },
    });

    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0]?.citations[0]?.excerpt).toBe('hello world');
    expect(result.assertions[0]?.citations[0]?.excerptEnd).toBe('11');
    expect(store.episodes).toHaveLength(1);
    expect(warnings.join('\n')).toContain('repaired citation');
  });

  it('drops unrepairable citations and assertions left without any', async () => {
    const store = new FakeStore();
    const extractor = sequencedProvider([
      citationResponse({ sourceRef: 'unknown.md', excerptStart: '0', excerptEnd: '3' }),
    ]);
    const warnings: string[] = [];

    const result = await ingest({
      store: store as unknown as TragetiStore,
      episode: makeEpisode(),
      document: 'doc',
      namespace: 'demo',
      citationSources: { 'src.md': 'hello world' },
      extractor,
      maxValidationAttempts: 1,
      degradeCitationsOnFailure: true,
      logger: { warn: (m) => warnings.push(m) },
    });

    expect(result.assertions).toHaveLength(0);
    // Episode is still written; degradation never fabricates excerpt text.
    expect(store.episodes).toHaveLength(1);
    expect(warnings.join('\n')).toContain('dropped citation');
    expect(warnings.join('\n')).toContain('dropped assertion');
  });

  it('keeps an assertion when at least one citation survives degradation', async () => {
    const store = new FakeStore();
    const extractor = sequencedProvider([
      multiCitationResponse([
        { id: 'c-good', sourceRef: 'src.md', excerptStart: '0', excerptEnd: '5' },
        { id: 'c-bad', sourceRef: 'unknown.md', excerptStart: '0', excerptEnd: '3' },
      ]),
    ]);
    const warnings: string[] = [];

    const result = await ingest({
      store: store as unknown as TragetiStore,
      episode: makeEpisode(),
      document: 'doc',
      namespace: 'demo',
      citationSources: { 'src.md': 'hello world' },
      extractor,
      maxValidationAttempts: 1,
      degradeCitationsOnFailure: true,
      logger: { warn: (m) => warnings.push(m) },
    });

    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0]?.citations).toHaveLength(1);
    expect(result.assertions[0]?.citations[0]?.id).toBe('c-good');
    expect(warnings.join('\n')).toContain('dropped citation "c-bad"');
  });

  it('does not degrade non-repairable schema failures even when degradation is enabled', async () => {
    const store = new FakeStore();
    // Missing required fields -> schema error (not citation, not repairable).
    const extractor = sequencedProvider([JSON.stringify({ assertions: [{ id: 'a' }], links: [] })]);

    await expect(
      ingest({
        store: store as unknown as TragetiStore,
        episode: makeEpisode(),
        document: 'doc',
        namespace: 'demo',
        extractor,
        maxValidationAttempts: 2,
        degradeCitationsOnFailure: true,
      }),
    ).rejects.toThrow('Extraction result failed validation');
    expect(store.episodes).toHaveLength(0);
  });
});

function citationResponse(citation: { sourceRef?: string; excerptStart: string; excerptEnd: string }): string {
  return multiCitationResponse([{ id: 'c-1', sourceRef: citation.sourceRef ?? 'src.md', ...citation }]);
}

function multiCitationResponse(
  citations: Array<{ id: string; sourceRef: string; excerptStart: string; excerptEnd: string }>,
): string {
  return JSON.stringify({
    assertions: [
      {
        id: 'a-1',
        namespace: 'demo',
        type: 'fact',
        content: 'content',
        validFrom: 1,
        confidence: 0.9,
        sourceEpisodeId: 'ep-1',
        citations: citations.map((c) => ({
          id: c.id,
          episodeId: 'ep-1',
          sourceRef: c.sourceRef,
          excerpt: null,
          excerptStart: c.excerptStart,
          excerptEnd: c.excerptEnd,
        })),
      },
    ],
    links: [],
  });
}

interface SequencedProvider extends ExtractionProvider {
  calls: number;
  prompts: string[];
}

function sequencedProvider(responses: string[]): SequencedProvider {
  const provider: SequencedProvider = {
    name: 'seq',
    label: 'seq',
    provenance: { kind: 'openai-compatible', configHash: 'seq' },
    calls: 0,
    prompts: [],
    extract(prompt: string) {
      const response = responses[Math.min(provider.calls, responses.length - 1)] ?? '';
      provider.calls += 1;
      provider.prompts.push(prompt);
      return Promise.resolve(response);
    },
  };
  return provider;
}

function makeEpisode(): NewEpisodeInput {
  return {
    id: 'ep-1',
    namespace: 'demo',
    position: 1,
    occurredAt: '2026-01-01T00:00:00Z',
    type: 'test',
    content: 'doc',
  };
}

class FakeStore {
  readonly episodes: NewEpisodeInput[] = [];
  readonly assertions: NewAssertionInput[] = [];
  readonly links: NewAssertionLinkInput[] = [];

  writeEpisode(episode: NewEpisodeInput): Promise<Episode> {
    this.episodes.push(episode);
    return Promise.resolve({ ...episode, createdAt: '', extensions: {} });
  }

  writeAssertion(assertion: NewAssertionInput): Promise<never> {
    this.assertions.push(assertion);
    return Promise.resolve(undefined as never);
  }

  writeLink(link: NewAssertionLinkInput): Promise<never> {
    this.links.push(link);
    return Promise.resolve(undefined as never);
  }
}
