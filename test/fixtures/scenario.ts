import type { TragetiStore } from '../../src/store/TragetiStore.js';
import type { NewAssertionCitation } from '../../src/domain/types.js';

/**
 * Build a default citation for a writeAssertion call. Tests that need richer
 * citation data can pass an explicit array; this helper covers the common case
 * where every assertion just needs *some* valid citation to satisfy the v0.2
 * structural invariants.
 */
export function citationFor(
  assertionId: string,
  episodeId: string,
  sourceRef = 'chunk:1',
  index = 0,
): NewAssertionCitation {
  return {
    id: `${assertionId}:c${String(index)}`,
    episodeId,
    sourceRef,
    excerpt: null,
  };
}

/**
 * Domain-neutral fixture: 3 episodes, ~10 assertions, 5 links, 2 supersession chains.
 *
 * v0.2 changes:
 *   - Every writeAssertion supplies at least one citation.
 *   - Supersession chain 1 (a-6 → a-7): a-7 is now written with supersedesId='a-6',
 *     which atomically closes a-6.valid_until = 5. The explicit
 *     supersedeAssertion('a-6', { replacedById: 'a-7' }) call is removed —
 *     auto-supersession handles it.
 *   - Supersession chain 2 (a-8): kept as an explicit supersedeAssertion call
 *     because there is no replacement assertion.
 */
export async function loadScenario(store: TragetiStore, namespace: string): Promise<void> {
  await store.writeEpisode({
    id: 'ep-1',
    namespace,
    position: 1,
    occurredAt: '2024-01-01T00:00:00Z',
    type: 'document',
    content: 'Episode 1 content',
  });
  await store.writeEpisode({
    id: 'ep-2',
    namespace,
    position: 5,
    occurredAt: '2024-01-05T00:00:00Z',
    type: 'document',
    content: 'Episode 2 content',
  });
  await store.writeEpisode({
    id: 'ep-3',
    namespace,
    position: 10,
    occurredAt: '2024-01-10T00:00:00Z',
    type: 'document',
    content: 'Episode 3 content',
  });

  // Active assertions
  await store.writeAssertion({
    id: 'a-1',
    namespace,
    type: 'fact',
    content: 'Alpha is the first item.',
    validFrom: 1,
    validUntil: null,
    confidence: 0.9,
    sourceEpisodeId: 'ep-1',
    supersedesId: null,
    entityId: 'entity-alpha',
    entityType: 'concept',
    citations: [citationFor('a-1', 'ep-1')],
  });
  await store.writeAssertion({
    id: 'a-2',
    namespace,
    type: 'fact',
    content: 'Beta is the second item.',
    validFrom: 1,
    validUntil: null,
    confidence: 0.85,
    sourceEpisodeId: 'ep-1',
    supersedesId: null,
    entityId: 'entity-beta',
    entityType: 'concept',
    citations: [citationFor('a-2', 'ep-1')],
  });
  await store.writeAssertion({
    id: 'a-3',
    namespace,
    type: 'update',
    content: 'Alpha has been updated at position 5.',
    validFrom: 5,
    validUntil: null,
    confidence: 0.95,
    sourceEpisodeId: 'ep-2',
    supersedesId: null,
    entityId: 'entity-alpha',
    entityType: 'concept',
    citations: [citationFor('a-3', 'ep-2')],
  });
  await store.writeAssertion({
    id: 'a-4',
    namespace,
    type: 'pattern',
    content: 'Alpha and Beta interact frequently.',
    validFrom: 5,
    validUntil: null,
    confidence: 0.7,
    sourceEpisodeId: 'ep-2',
    supersedesId: null,
    entityId: null,
    entityType: 'relationship',
    citations: [citationFor('a-4', 'ep-2')],
  });
  await store.writeAssertion({
    id: 'a-5',
    namespace,
    type: 'fact',
    content: 'Gamma emerged at position 10.',
    validFrom: 10,
    validUntil: null,
    confidence: 0.8,
    sourceEpisodeId: 'ep-3',
    supersedesId: null,
    entityId: 'entity-gamma',
    entityType: 'concept',
    citations: [citationFor('a-5', 'ep-3')],
  });

  // Supersession chain 1: a-6 superseded by a-7 (atomic via writeAssertion)
  await store.writeAssertion({
    id: 'a-6',
    namespace,
    type: 'fact',
    content: 'Delta was once active.',
    validFrom: 1,
    validUntil: null,
    confidence: 0.6,
    sourceEpisodeId: 'ep-1',
    supersedesId: null,
    entityId: 'entity-delta',
    entityType: 'concept',
    citations: [citationFor('a-6', 'ep-1')],
  });
  await store.writeAssertion({
    id: 'a-7',
    namespace,
    type: 'update',
    content: 'Delta has been revised.',
    validFrom: 5,
    validUntil: null,
    confidence: 0.9,
    sourceEpisodeId: 'ep-2',
    supersedesId: 'a-6',
    entityId: 'entity-delta',
    entityType: 'concept',
    citations: [citationFor('a-7', 'ep-2')],
  });

  // Supersession chain 2: a-8 superseded with no replacement (explicit)
  await store.writeAssertion({
    id: 'a-8',
    namespace,
    type: 'absence',
    content: 'Epsilon was noted absent.',
    validFrom: 1,
    validUntil: null,
    confidence: 0.5,
    sourceEpisodeId: 'ep-1',
    supersedesId: null,
    entityId: 'entity-epsilon',
    entityType: 'concept',
    citations: [citationFor('a-8', 'ep-1')],
  });
  await store.advanced.closeAssertion('a-8', { validUntil: 10 });

  // Links
  await store.writeLink({
    id: 'l-1',
    namespace,
    fromId: 'a-1',
    toId: 'a-2',
    linkType: 'related',
    validFrom: 1,
    validUntil: null,
    sourceEpisodeId: 'ep-1',
  });
  await store.writeLink({
    id: 'l-2',
    namespace,
    fromId: 'a-1',
    toId: 'a-3',
    linkType: 'sequential',
    validFrom: 5,
    validUntil: null,
    sourceEpisodeId: 'ep-2',
  });
  await store.writeLink({
    id: 'l-3',
    namespace,
    fromId: 'a-2',
    toId: 'a-4',
    linkType: 'generative',
    validFrom: 5,
    validUntil: null,
    sourceEpisodeId: 'ep-2',
  });
  await store.writeLink({
    id: 'l-4',
    namespace,
    fromId: 'a-3',
    toId: 'a-5',
    linkType: 'sequential',
    validFrom: 10,
    validUntil: null,
    sourceEpisodeId: 'ep-3',
  });
  await store.writeLink({
    id: 'l-5',
    namespace,
    fromId: 'a-6',
    toId: 'a-7',
    linkType: 'supersedes',
    validFrom: 5,
    validUntil: null,
    sourceEpisodeId: 'ep-2',
  });
}
