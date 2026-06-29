import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openTestDb } from '../helpers/openTestDb.js';
import { TragetiStore } from '../../src/store/TragetiStore.js';
import { citationFor, loadScenario } from '../fixtures/scenario.js';

const NS = 'test-ns';
const DIM = 4;

describe('TragetiStore — graph traversal', () => {
  let db: Database;
  let store: TragetiStore;

  beforeEach(async () => {
    db = openTestDb();
    store = new TragetiStore(db, { namespace: NS, embeddingDimension: DIM });
    await store.init();
    await loadScenario(store, NS);
  });

  // Scenario links:
  //   l-1: a-1 → a-2 (related, validFrom=1)
  //   l-2: a-1 → a-3 (sequential, validFrom=5)
  //   l-3: a-2 → a-4 (generative, validFrom=5)
  //   l-4: a-3 → a-5 (sequential, validFrom=10)
  //   l-5: a-6 → a-7 (supersedes, validFrom=5)

  it('getConnected returns directly linked assertions at depth 1', async () => {
    const connected = await store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-1',
      maxDepth: 1,
      temporalAnchor: 10,
    });
    const ids = connected.map((a) => a.id);
    expect(ids).toContain('a-2');
    expect(ids).toContain('a-3');
    expect(ids).not.toContain('a-1'); // source excluded
  });

  it('getConnected respects depth boundary', async () => {
    // At depth 1 from a-1, should not include a-4 (a-1→a-2→a-4 is depth 2)
    const depth1 = await store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-1',
      maxDepth: 1,
      temporalAnchor: 10,
    });
    expect(depth1.map((a) => a.id)).not.toContain('a-4');

    // At depth 2 from a-1, a-4 should be reachable via a-1→a-2→a-4
    const depth2 = await store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-1',
      maxDepth: 2,
      temporalAnchor: 10,
    });
    expect(depth2.map((a) => a.id)).toContain('a-4');
  });

  it('getConnected filters by link type', async () => {
    const related = await store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-1',
      maxDepth: 1,
      linkTypes: ['related'],
      temporalAnchor: 10,
    });
    const ids = related.map((a) => a.id);
    expect(ids).toContain('a-2');
    expect(ids).not.toContain('a-3'); // l-2 is 'sequential', not 'related'
  });

  it('getConnected excludes links with validFrom > temporalAnchor', async () => {
    // l-2 has validFrom=5; querying at anchor=4 should exclude it
    const connected = await store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-1',
      maxDepth: 1,
      temporalAnchor: 4,
    });
    const ids = connected.map((a) => a.id);
    expect(ids).toContain('a-2'); // l-1 validFrom=1, visible at anchor=4
    expect(ids).not.toContain('a-3'); // l-2 validFrom=5, not yet valid at anchor=4
  });

  it('getConnected excludes expired links (valid_until <= temporalAnchor)', async () => {
    await store.writeAssertion({
      id: 'a-temp-target',
      namespace: NS,
      type: 'fact',
      content: 'temporary target',
      validFrom: 1,
      validUntil: null,
      confidence: 1,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: 'temp-target',
      entityType: 'topic',
      citations: [citationFor('a-temp-target', 'ep-1')],
    });
    // Add a link that expires at position 8.
    await store.writeLink({
      id: 'l-temp',
      namespace: NS,
      fromId: 'a-1',
      toId: 'a-temp-target',
      linkType: 'temporary',
      validFrom: 1,
      validUntil: 8,
      sourceEpisodeId: 'ep-1',
    });

    // At anchor=7: link is still valid (validUntil=8 > 7)
    const before = await store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-1',
      maxDepth: 1,
      temporalAnchor: 7,
    });
    expect(before.map((a) => a.id)).toContain('a-temp-target');

    // At anchor=8: link has expired (validUntil=8, condition is valid_until > anchor fails for equal)
    const after = await store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-1',
      maxDepth: 1,
      temporalAnchor: 8,
    });
    expect(after.map((a) => a.id)).not.toContain('a-temp-target');
  });

  it('findPath returns links on the path between two assertions', async () => {
    // a-1 → a-2 (l-1) is a direct 1-hop path
    const path = await store.findPath({
      namespace: NS,
      fromAssertionId: 'a-1',
      toAssertionId: 'a-2',
      maxDepth: 3,
      temporalAnchor: 10,
    });
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    // Path should end at a-2
    const lastLink = path![path!.length - 1]!;
    expect(lastLink.toId).toBe('a-2');
  });

  it('findPath returns null when no path exists within maxDepth', async () => {
    // a-5 has no outgoing links in the fixture — no path from a-5 to a-1
    const path = await store.findPath({
      namespace: NS,
      fromAssertionId: 'a-5',
      toAssertionId: 'a-1',
      maxDepth: 5,
      temporalAnchor: 10,
    });
    expect(path).toBeNull();
  });

  it('findPath returns the full ordered path for multi-hop walks', async () => {
    // a-1 → a-2 → a-4 via l-1 and l-3
    const path = await store.findPath({
      namespace: NS,
      fromAssertionId: 'a-1',
      toAssertionId: 'a-4',
      maxDepth: 5,
      temporalAnchor: 10,
    });
    expect(path).not.toBeNull();
    expect(path!.length).toBe(2);
    expect(path![0]!.fromId).toBe('a-1');
    expect(path![0]!.toId).toBe('a-2');
    expect(path![1]!.fromId).toBe('a-2');
    expect(path![1]!.toId).toBe('a-4');
    expect(path![0]!.id).toBe('l-1');
    expect(path![1]!.id).toBe('l-3');
  });

  it('findPath returns [] for zero-hop (same source and target)', async () => {
    const path = await store.findPath({
      namespace: NS,
      fromAssertionId: 'a-1',
      toAssertionId: 'a-1',
      maxDepth: 5,
      temporalAnchor: 10,
    });
    expect(path).toEqual([]);
  });

  it('findPath returns null for zero-hop when the assertion does not exist in the namespace', async () => {
    const path = await store.findPath({
      namespace: NS,
      fromAssertionId: 'missing',
      toAssertionId: 'missing',
      maxDepth: 5,
      temporalAnchor: 10,
    });
    expect(path).toBeNull();
  });

  it('continues traversal in the destination namespace after a cross-namespace hop', async () => {
    await store.initNamespace('other', { embeddingDimension: DIM });
    await store.writeEpisode({
      id: 'ep-other',
      namespace: 'other',
      position: 1,
      occurredAt: '',
      type: 'doc',
      content: 'other episode',
    });
    for (const id of ['b-1', 'b-2']) {
      await store.writeAssertion({
        id,
        namespace: 'other',
        type: 'fact',
        content: id,
        validFrom: 1,
        validUntil: null,
        confidence: 1,
        sourceEpisodeId: 'ep-other',
        supersedesId: null,
        entityId: id,
        entityType: 'topic',
        citations: [citationFor(id, 'ep-other')],
      });
    }
    await store.writeLink({
      id: 'l-cross',
      namespace: NS,
      fromId: 'a-1',
      toId: 'b-1',
      linkType: 'related',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-1',
    });
    await store.writeLink({
      id: 'l-other',
      namespace: 'other',
      fromId: 'b-1',
      toId: 'b-2',
      linkType: 'related',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-other',
    });

    const connected = await store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-1',
      maxDepth: 2,
      temporalAnchor: 10,
      linkTypes: ['related'],
    });
    expect(connected.map((assertion) => assertion.id)).toContain('b-2');

    const path = await store.findPath({
      namespace: NS,
      fromAssertionId: 'a-1',
      toAssertionId: 'b-2',
      maxDepth: 2,
      temporalAnchor: 10,
      linkTypes: ['related'],
    });
    expect(path?.map((link) => link.id)).toEqual(['l-cross', 'l-other']);
  });

  it('findPath handles cycles without infinite loop or repeated assertions', async () => {
    // Construct a cycle: a-2 → a-1 (closing a-1 → a-2 → a-1)
    await store.writeLink({
      id: 'l-cycle',
      namespace: NS,
      fromId: 'a-2',
      toId: 'a-1',
      linkType: 'related',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-1',
    });
    // Path from a-1 to a-1 is zero-hop, returns [] (no cycle traversal).
    expect(
      await store.findPath({
        namespace: NS,
        fromAssertionId: 'a-1',
        toAssertionId: 'a-1',
        maxDepth: 5,
        temporalAnchor: 10,
      }),
    ).toEqual([]);
    // Path from a-1 to nonexistent target — must terminate without infinite loop.
    const path = await store.findPath({
      namespace: NS,
      fromAssertionId: 'a-1',
      toAssertionId: 'a-nonexistent',
      maxDepth: 10,
      temporalAnchor: 10,
    });
    expect(path).toBeNull();
    // Path from a-2 to a-4 (a-2 → a-4 directly via l-3) — cycle guard must not skip it.
    const valid = await store.findPath({
      namespace: NS,
      fromAssertionId: 'a-2',
      toAssertionId: 'a-4',
      maxDepth: 5,
      temporalAnchor: 10,
    });
    expect(valid).not.toBeNull();
    // Visited-set invariant: no assertion appears more than once in the path.
    const assertions = [valid![0]!.fromId, ...valid!.map((l) => l.toId)];
    expect(new Set(assertions).size).toBe(assertions.length);
  });

  it('findPath picks the deterministic path among equal-depth candidates', async () => {
    // Build a second 2-hop route a-1 → a-5 → a-4 alongside a-1 → a-2 → a-4.
    // a-1 → a-5 needs a new link; a-5 → a-4 also needs a new link.
    await store.writeLink({
      id: 'l-alt1',
      namespace: NS,
      fromId: 'a-1',
      toId: 'a-5',
      linkType: 'related',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-1',
    });
    await store.writeLink({
      id: 'l-alt2',
      namespace: NS,
      fromId: 'a-5',
      toId: 'a-4',
      linkType: 'related',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-1',
    });
    // Pin distinct created_at values so the tie-break has a stable signal.
    // Path A (a-1 → a-2 → a-4 via l-1, l-3): force l-1 to earlier timestamp.
    db.prepare("UPDATE trageti_links SET created_at = '2024-01-01T00:00:00.001Z' WHERE id = ?").run('l-1');
    db.prepare("UPDATE trageti_links SET created_at = '2024-01-01T00:00:00.002Z' WHERE id = ?").run('l-3');
    // Path B (a-1 → a-5 → a-4 via l-alt1, l-alt2): later timestamps.
    db.prepare("UPDATE trageti_links SET created_at = '2024-01-02T00:00:00.000Z' WHERE id = ?").run('l-alt1');
    db.prepare("UPDATE trageti_links SET created_at = '2024-01-02T00:00:01.000Z' WHERE id = ?").run('l-alt2');

    // Run ten times; assert the same path is returned each time, and that it is Path A
    // (smaller first-hop created_at wins the lex comparison).
    const winners = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.findPath({
          namespace: NS,
          fromAssertionId: 'a-1',
          toAssertionId: 'a-4',
          maxDepth: 5,
          temporalAnchor: 10,
        }),
      ),
    );
    for (const path of winners) {
      expect(path).not.toBeNull();
      expect(path!.length).toBe(2);
      expect(path![0]!.id).toBe('l-1');
      expect(path![1]!.id).toBe('l-3');
    }
  });

  it('getConnected returns empty array when no links exist', async () => {
    // a-5 has no outgoing links
    const connected = await store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-5',
      maxDepth: 3,
      temporalAnchor: 10,
    });
    expect(connected).toEqual([]);
  });
});
