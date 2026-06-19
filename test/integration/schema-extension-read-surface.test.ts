import { describe, it, expect } from 'vitest';
import { openTestDb } from '../helpers/openTestDb.js';
import { TragetiStore } from '../../src/store/TragetiStore.js';
import type { SchemaExtensions } from '../../src/domain/types.js';
import { citationFor } from '../fixtures/scenario.js';

const NS = 'ext-read';
const extensions: SchemaExtensions = {
  columns: [
    {
      table: 'trageti_assertions',
      column: 'review_state',
      definition: "TEXT DEFAULT 'draft'",
    },
    {
      table: 'trageti_episodes',
      column: 'source_kind',
      definition: "TEXT DEFAULT 'journal'",
    },
    {
      table: 'trageti_links',
      column: 'edge_weight',
      definition: 'REAL DEFAULT 0',
    },
  ],
};

async function seed(store: TragetiStore): Promise<void> {
  await store.writeEpisode({
    id: 'ep-1',
    namespace: NS,
    position: 1,
    occurredAt: '2024-01-01T00:00:00Z',
    type: 'journal',
    content: 'episode one',
  });
  for (const id of ['a-1', 'a-2', 'a-3']) {
    await store.writeAssertion({
      id,
      namespace: NS,
      type: 'fact',
      content: `claim ${id}`,
      validFrom: 1,
      validUntil: null,
      confidence: 0.9,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: id,
      entityType: 'concept',
      citations: [citationFor(id, 'ep-1')],
    });
  }
  await store.writeLink({
    id: 'l-1',
    namespace: NS,
    fromId: 'a-1',
    toId: 'a-2',
    linkType: 'related',
    validFrom: 1,
    validUntil: null,
    sourceEpisodeId: 'ep-1',
  });
  await store.writeLink({
    id: 'l-2',
    namespace: NS,
    fromId: 'a-2',
    toId: 'a-3',
    linkType: 'related',
    validFrom: 1,
    validUntil: null,
    sourceEpisodeId: 'ep-1',
  });
}

describe('schema extension read surface', () => {
  it('hydrates assertion, episode, and link extension bags after SQL-side extension updates and reopen', async () => {
    const db = openTestDb();
    const writer = await TragetiStore.create({
      database: db,
      namespace: NS,
      schemaExtensions: extensions,
    });
    await seed(writer);

    db.prepare("UPDATE trageti_episodes SET source_kind = 'field-note' WHERE id = 'ep-1'").run();
    db.prepare("UPDATE trageti_assertions SET review_state = 'approved' WHERE id = 'a-2'").run();
    db.prepare("UPDATE trageti_links SET edge_weight = 0.7 WHERE id = 'l-1'").run();
    db.prepare("UPDATE trageti_links SET edge_weight = 0.4 WHERE id = 'l-2'").run();

    const insertedLink = await writer.writeLink({
      id: 'l-default',
      namespace: NS,
      fromId: 'a-1',
      toId: 'a-3',
      linkType: 'shortcut',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-1',
    });
    expect(insertedLink.extensions).toEqual({ edge_weight: 0 });
    await writer.close();

    const reader = await TragetiStore.create({
      database: db,
      namespace: NS,
      schemaExtensions: extensions,
    });

    const episode = await reader.getEpisode('ep-1');
    expect(episode?.extensions).toEqual({ source_kind: 'field-note' });

    const assertions = await reader.getAssertions(NS, { includeSuperseded: true });
    const byId = new Map(assertions.map((assertion) => [assertion.id, assertion]));
    expect(byId.get('a-1')?.extensions).toEqual({ review_state: 'draft' });
    expect(byId.get('a-2')?.extensions).toEqual({ review_state: 'approved' });

    const connected = await reader.getConnected({
      namespace: NS,
      fromAssertionId: 'a-1',
      temporalAnchor: 1,
      maxDepth: 1,
      linkTypes: ['related'],
    });
    expect(connected.map((assertion) => assertion.id)).toEqual(['a-2']);
    expect(connected[0]?.extensions).toEqual({ review_state: 'approved' });

    const path = await reader.findPath({
      namespace: NS,
      fromAssertionId: 'a-1',
      toAssertionId: 'a-3',
      temporalAnchor: 1,
      maxDepth: 2,
      linkTypes: ['related'],
    });
    expect(path?.map((link) => [link.id, link.extensions['edge_weight']])).toEqual([
      ['l-1', 0.7],
      ['l-2', 0.4],
    ]);

    await reader.close();
    db.close();
  });
});
