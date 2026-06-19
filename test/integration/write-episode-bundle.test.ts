import { describe, expect, it } from 'vitest';
import { TragetiStore } from '../../src/index.js';
import { openTestDb } from '../helpers/openTestDb.js';

describe('writeEpisodeBundle', () => {
  it('writes an episode, assertions, citations, and links atomically', async () => {
    const store = await TragetiStore.create({ database: openTestDb(), namespace: 'bundle', embeddingDimension: 2 });

    await store.writeEpisodeBundle({
      episode: {
        id: 'ep-1',
        namespace: 'bundle',
        position: 1,
        occurredAt: '2026-01-01T00:00:00Z',
        type: 'demo',
        content: 'episode one',
      },
      assertions: [
        assertion('a-1', 'ep-1', 'first assertion'),
        assertion('a-2', 'ep-1', 'second assertion'),
      ],
      links: [
        {
          id: 'l-1',
          namespace: 'bundle',
          fromId: 'a-2',
          toId: 'a-1',
          linkType: 'contextualizes',
          validFrom: 1,
          validUntil: null,
          sourceEpisodeId: 'ep-1',
        },
      ],
    });

    expect(await store.getEpisode('ep-1')).not.toBeNull();
    expect((await store.getAssertions('bundle', { includeSuperseded: true })).map((row) => row.id).sort()).toEqual([
      'a-1',
      'a-2',
    ]);
    expect((await store.getLinksByIds(['l-1'])).map((row) => row.id)).toEqual(['l-1']);
  });

  it('rolls back the whole bundle when a later assertion insert fails', async () => {
    const db = openTestDb();
    const store = await TragetiStore.create({ database: db, namespace: 'bundle', embeddingDimension: 2 });
    await store.writeEpisode({
      id: 'ep-1',
      namespace: 'bundle',
      position: 1,
      occurredAt: '2026-01-01T00:00:00Z',
      type: 'seed',
      content: 'seed',
    });
    await store.writeAssertion(assertion('a-1', 'ep-1', 'seed assertion'));

    await expect(
      store.writeEpisodeBundle({
        episode: {
          id: 'ep-2',
          namespace: 'bundle',
          position: 2,
          occurredAt: '2026-01-02T00:00:00Z',
          type: 'demo',
          content: 'episode two',
        },
        assertions: [
          assertion('a-2', 'ep-2', 'replacement assertion', { supersedesId: 'a-1' }),
          assertion('a-1', 'ep-2', 'duplicate assertion id'),
        ],
      }),
    ).rejects.toThrow();

    expect(await store.getEpisode('ep-2')).toBeNull();
    const predecessor = db.prepare<[string], { valid_until: number | null }>(
      'SELECT valid_until FROM trageti_assertions WHERE id = ?',
    ).get('a-1');
    expect(predecessor?.valid_until).toBeNull();
  });
});

function assertion(id: string, episodeId: string, content: string, overrides: { supersedesId?: string } = {}) {
  return {
    id,
    namespace: 'bundle',
    type: 'fact',
    content,
    validFrom: episodeId === 'ep-1' ? 1 : 2,
    validUntil: null,
    confidence: 1,
    sourceEpisodeId: episodeId,
    supersedesId: overrides.supersedesId ?? null,
    entityId: id === 'a-2' ? 'entity' : null,
    entityType: id === 'a-2' ? 'thing' : null,
    citations: [
      {
        id: `c-${id}`,
        episodeId,
        sourceRef: 'source',
        excerpt: content,
      },
    ],
  };
}
