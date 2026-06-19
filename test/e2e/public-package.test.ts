import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as PublicPackageModule from '../../src/index.js';

type PublicPackage = typeof PublicPackageModule;

const tmpDirs: string[] = [];

async function loadPublicPackage(): Promise<PublicPackage> {
  const entrypoint = '../../dist/index.js';
  return (await import(entrypoint)) as PublicPackage;
}

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trageti-public-e2e-'));
  tmpDirs.push(dir);
  return join(dir, 'consumer.db');
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can keep SQLite handles briefly after a failed test; leaking a
      // temp dir is safer than hiding the original failure.
    }
  }
});

function citation(assertionId: string, episodeId: string) {
  return {
    id: `${assertionId}:c0`,
    episodeId,
    sourceRef: 'doc:1',
    excerpt: 'cited excerpt',
  };
}

describe('public package E2E', () => {
  it('imports the built artifact and completes a file-backed consumer journey', async () => {
    const {
      ErrorCode,
      JsonFormatter,
      MockEmbeddingProvider,
      RRFScorer,
      TragetiStore,
      ValidationError,
      prepareDatabase,
    } = await loadPublicPackage();

    expect(ErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(new ValidationError(['sample'])).toBeInstanceOf(Error);
    expect(new RRFScorer()).toBeTruthy();

    const smokeDb = prepareDatabase(':memory:');
    smokeDb.close();

    const database = tmpDbPath();
    const provider = new MockEmbeddingProvider({ dimension: 4 });
    const writer = await TragetiStore.create({
      database,
      namespace: 'public-e2e',
      embeddingDimension: 4,
      embeddingProvider: provider,
    });

    await writer.writeEpisode({
      id: 'ep-1',
      namespace: 'public-e2e',
      position: 1,
      occurredAt: '2024-01-01T00:00:00Z',
      type: 'document',
      content: 'A public consumer writes an episode about blue widgets.',
    });
    await writer.writeAssertion({
      id: 'a-1',
      namespace: 'public-e2e',
      type: 'fact',
      content: 'Blue widgets are available.',
      validFrom: 1,
      validUntil: null,
      confidence: 0.95,
      sourceEpisodeId: 'ep-1',
      entityId: 'widget-blue',
      entityType: 'product',
      citations: [citation('a-1', 'ep-1')],
    });
    await writer.writeAssertion({
      id: 'a-2',
      namespace: 'public-e2e',
      type: 'fact',
      content: 'Blue widgets ship with installation notes.',
      validFrom: 1,
      validUntil: null,
      confidence: 0.9,
      sourceEpisodeId: 'ep-1',
      entityId: 'widget-blue-notes',
      entityType: 'document',
      citations: [citation('a-2', 'ep-1')],
    });
    await writer.writeLink({
      id: 'l-1',
      namespace: 'public-e2e',
      fromId: 'a-1',
      toId: 'a-2',
      linkType: 'supports',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-1',
    });
    await writer.indexBatch([{ assertionId: 'a-1' }, { assertionId: 'a-2' }]);

    const bm25 = await writer.retrieve({
      namespace: 'public-e2e',
      queryText: 'blue widgets',
      retrievalStrategy: 'bm25',
      temporalAnchor: 1,
    });
    expect(bm25.results.map((result) => result.id)).toContain('a-1');

    const hybrid = await writer.retrieve({
      namespace: 'public-e2e',
      queryText: 'installation notes',
      retrievalStrategy: 'hybrid',
      temporalAnchor: 1,
      expandLinks: true,
    });
    expect(hybrid.meta.retrievalStrategy).toBe('hybrid');
    expect(hybrid.results.length).toBeGreaterThan(0);

    const context = await writer.assembleContext({
      namespace: 'public-e2e',
      queryText: 'blue widgets',
      retrievalStrategy: 'bm25',
      temporalAnchor: 1,
      tokenBudget: 2_000,
      formatter: new JsonFormatter(),
    });
    expect(() => JSON.parse(context.text)).not.toThrow();
    await writer.close();

    const reader = await TragetiStore.create({
      database,
      namespace: 'public-e2e',
      embeddingDimension: 4,
      embeddingProvider: provider,
    });
    expect(await reader.getPendingIndexing('public-e2e')).toEqual([]);
    const vector = await reader.retrieve({
      namespace: 'public-e2e',
      queryText: 'blue widgets',
      retrievalStrategy: 'vector',
      temporalAnchor: 1,
    });
    expect(vector.meta.vectorApplied).toBe(true);
    expect(vector.results.length).toBeGreaterThan(0);
    await reader.close();
  });
});
