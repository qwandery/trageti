import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider, Episode } from 'trageti';
import { generateFixtureFiles } from './generate-fixtures.js';
import type { ExtractionProvider } from './providers.js';

const generatedDir = join('demos', '.local', 'fixture-helper-test');

afterEach(() => {
  if (existsSync(generatedDir)) rmSync(generatedDir, { recursive: true, force: true });
});

describe('generateFixtureFiles', () => {
  it('passes accumulated prior assertions into later extraction prompts', async () => {
    const prompts: string[] = [];
    const extractor: ExtractionProvider = {
      name: 'test',
      label: 'test',
      provenance: { kind: 'fixture', configHash: 'test' },
      extract(prompt, options) {
        prompts.push(prompt);
        return Promise.resolve(JSON.stringify(fixtureForEpisode(options?.episodeId ?? 'missing')));
      },
    };
    const embedder: EmbeddingProvider = {
      name: 'test-embedder',
      dimension: 2,
      embed(texts) {
        return Promise.resolve(texts.map(() => new Float32Array([1, 0])));
      },
    };

    await generateFixtureFiles({
      demoName: 'fixture-helper-test',
      episodes,
      queryTexts: ['query'],
      embeddingDimension: 2,
      extractor,
      embedder,
      writeCommitted: false,
      committedFixturesPath: 'unused-fixtures.ts',
      committedEmbeddingsPath: 'unused-embeddings.ts',
    });

    expect(prompts[0]).toContain('(no prior assertions)');
    expect(prompts[1]).toContain('a-ep-1-0: first claim');
  });
});

const episodes: Array<Omit<Episode, 'createdAt'>> = [
  {
    id: 'ep-1',
    namespace: 'fixture-helper-test',
    position: 1,
    occurredAt: '2026-01-01T00:00:00Z',
    type: 'note',
    content: 'first claim source',
  },
  {
    id: 'ep-2',
    namespace: 'fixture-helper-test',
    position: 2,
    occurredAt: '2026-01-02T00:00:00Z',
    type: 'note',
    content: 'second claim source',
  },
];

function fixtureForEpisode(episodeId: string): unknown {
  const index = episodeId === 'ep-1' ? 0 : 1;
  const content = index === 0 ? 'first claim' : 'second claim';
  const source = index === 0 ? episodes[0] : episodes[1];
  if (!source) throw new Error('missing source episode');
  return {
    assertions: [
      {
        id: `a-${episodeId}-0`,
        namespace: source.namespace,
        type: 'fact',
        content,
        validFrom: source.position,
        confidence: 0.9,
        sourceEpisodeId: episodeId,
        supersedesId: null,
        entityId: null,
        entityType: null,
        citations: [
          {
            id: `c-${episodeId}-0`,
            episodeId,
            sourceRef: 'episode document',
            excerpt: null,
            excerptStart: '0',
            excerptEnd: '5',
          },
        ],
      },
    ],
    links: [],
  };
}
