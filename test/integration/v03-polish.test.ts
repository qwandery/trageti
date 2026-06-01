import { describe, it, expect } from 'vitest';
import { openTestDb } from '../helpers/openTestDb.js';
import { TemporalStore } from '../../src/store/TemporalStore.js';
import { RetrievalInputError } from '../../src/errors/index.js';
import type { TragetiError } from '../../src/errors/index.js';
import type { RetrievalStep } from '../../src/index.js';
import { citationFor } from '../fixtures/scenario.js';

const DIM = 4;

async function seedEpisode(store: TemporalStore, ns: string): Promise<void> {
  await store.writeEpisode({
    id: 'ep-1',
    namespace: ns,
    position: 1,
    occurredAt: '2024-01-01T00:00:00Z',
    type: 'document',
    content: 'episode',
  });
}

async function writeAssertion(
  store: TemporalStore,
  ns: string,
  id: string,
  opts: { validFrom: number; validUntil?: number | null; supersedesId?: string | null } = {
    validFrom: 1,
  },
): Promise<void> {
  await store.writeAssertion({
    id,
    namespace: ns,
    type: 'fact',
    content: `searchterm assertion ${id}`,
    validFrom: opts.validFrom,
    validUntil: opts.validUntil ?? null,
    confidence: 0.9,
    sourceEpisodeId: 'ep-1',
    supersedesId: opts.supersedesId ?? null,
    entityId: 'e-1',
    entityType: 'concept',
    citations: [citationFor(id, 'ep-1')],
  });
}

// ── Snapshot supersession semantics ───────────────────────────────────────────
describe('getTemporalSnapshot honors includeSuperseded', () => {
  // Chain A[1,5) → B[5,10) → C[10,∞), one entity.
  async function chainStore(): Promise<TemporalStore> {
    const store = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM });
    await store.init();
    await seedEpisode(store, 'ns');
    await writeAssertion(store, 'ns', 'A', { validFrom: 1 });
    await writeAssertion(store, 'ns', 'B', { validFrom: 5, supersedesId: 'A' });
    await writeAssertion(store, 'ns', 'C', { validFrom: 10, supersedesId: 'B' });
    return store;
  }

  it('default (includeSuperseded:false) returns only the version valid at the position', async () => {
    const store = await chainStore();
    expect((await store.getTemporalSnapshot({ namespace: 'ns', atPosition: 12 })).map((a) => a.id)).toEqual(['C']);
    expect((await store.getTemporalSnapshot({ namespace: 'ns', atPosition: 7 })).map((a) => a.id)).toEqual(['B']);
    await store.close();
  });

  it('includeSuperseded:true also returns rows closed before the position', async () => {
    const store = await chainStore();
    const at12 = await store.getTemporalSnapshot({
      namespace: 'ns',
      atPosition: 12,
      includeSuperseded: true,
    });
    expect(at12.map((a) => a.id).sort()).toEqual(['A', 'B', 'C']);
    // Every returned row has validFrom <= atPosition.
    for (const a of at12) expect(a.validFrom).toBeLessThanOrEqual(12);
    await store.close();
  });

  it('includeSuperseded:true still excludes rows whose validFrom is after the position', async () => {
    const store = await chainStore();
    const at7 = await store.getTemporalSnapshot({
      namespace: 'ns',
      atPosition: 7,
      includeSuperseded: true,
    });
    // A (closed at 5) and B (valid at 7) are included; C (validFrom=10) is not.
    expect(at7.map((a) => a.id).sort()).toEqual(['A', 'B']);
    await store.close();
  });
});

// ── Raw FTS5 validation errors ────────────────────────────────────────────────
describe('malformed fts5 query text fails with RETRIEVAL_INVALID_QUERY_TEXT', () => {
  async function seededStore(): Promise<TemporalStore> {
    const store = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM });
    await store.init();
    await seedEpisode(store, 'ns');
    await writeAssertion(store, 'ns', 'a-1', { validFrom: 1 });
    return store;
  }

  const malformed = ['searchterm AND', 'NEAR(', '"unterminated', '(searchterm OR'];

  it('throws RetrievalInputError with code RETRIEVAL_INVALID_QUERY_TEXT', async () => {
    const store = await seededStore();
    for (const queryText of malformed) {
      let thrown: unknown;
      try {
        await store.retrieve({
          namespace: 'ns',
          queryText,
          retrievalStrategy: 'bm25',
          queryTextMode: 'fts5',
          temporalAnchor: 5,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(RetrievalInputError);
      expect((thrown as TragetiError).code).toBe('RETRIEVAL_INVALID_QUERY_TEXT');
    }
    await store.close();
  });

  it('the thrown message leaks neither the offending query text nor a raw SQLite fragment', async () => {
    const store = await seededStore();
    const offending = 'searchterm AND';
    let message = '';
    try {
      await store.retrieve({
        namespace: 'ns',
        queryText: offending,
        retrievalStrategy: 'bm25',
        queryTextMode: 'fts5',
        temporalAnchor: 5,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(offending);
    // No raw SQLite parser fragment (e.g. 'fts5: syntax error near "..."').
    expect(message).not.toContain('syntax error');
    expect(message).not.toContain('near "');
    await store.close();
  });

  it('blank query text under bm25 still throws RETRIEVAL_REQUIRES_QUERY_TEXT (unchanged)', async () => {
    const store = await seededStore();
    let thrown: unknown;
    try {
      await store.retrieve({
        namespace: 'ns',
        queryText: '   ',
        retrievalStrategy: 'bm25',
        queryTextMode: 'fts5',
        temporalAnchor: 5,
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as TragetiError).code).toBe('RETRIEVAL_REQUIRES_QUERY_TEXT');
    await store.close();
  });
});

// ── Debug / explain step ordering ─────────────────────────────────────────────
describe('rank is emitted after score and before graph/trajectory expansion', () => {
  async function seededStore(): Promise<TemporalStore> {
    const store = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM });
    await store.init();
    await seedEpisode(store, 'ns');
    await writeAssertion(store, 'ns', 'a-1', { validFrom: 1 });
    return store;
  }

  it('debug onStep emits rank between score and the expansion steps', async () => {
    const store = await seededStore();
    const steps: RetrievalStep[] = [];
    await store.retrieve({
      namespace: 'ns',
      queryText: 'searchterm',
      retrievalStrategy: 'bm25',
      temporalAnchor: 5,
      expandLinks: true,
      mode: 'trajectory',
      debug: { onStep: (step) => steps.push(step) },
    });
    expect(steps.indexOf('rank')).toBeGreaterThan(steps.indexOf('score'));
    expect(steps.indexOf('rank')).toBeLessThan(steps.indexOf('graph-expand'));
    expect(steps.indexOf('rank')).toBeLessThan(steps.indexOf('trajectory-expand'));
    await store.close();
  });

  it('explain() lists rank in the same position', async () => {
    const store = await seededStore();
    const plan = await store.explain({
      namespace: 'ns',
      queryText: 'searchterm',
      retrievalStrategy: 'bm25',
      temporalAnchor: 5,
      expandLinks: true,
      mode: 'trajectory',
    });
    const order = plan.steps.map((s) => s.step);
    expect(order.indexOf('rank')).toBeGreaterThan(order.indexOf('score'));
    expect(order.indexOf('rank')).toBeLessThan(order.indexOf('graph-expand'));
    expect(order.indexOf('rank')).toBeLessThan(order.indexOf('trajectory-expand'));
    await store.close();
  });
});

// ── Deterministic graph neighborhood ordering ─────────────────────────────────
describe('CTEGraphAdapter.findConnected returns a stable order', () => {
  it('repeated getConnected calls over a multi-link neighborhood are reproducible', async () => {
    const store = new TemporalStore(openTestDb(), { namespace: 'g', embeddingDimension: DIM });
    await store.init();
    await seedEpisode(store, 'g');
    for (const id of ['a-1', 'a-2', 'a-3', 'a-4', 'a-5', 'a-6', 'a-7']) {
      await writeAssertion(store, 'g', id, { validFrom: 1 });
    }
    // Six links sharing source a-1, written in ascending link-id order.
    const targets = ['a-2', 'a-3', 'a-4', 'a-5', 'a-6', 'a-7'];
    for (let i = 0; i < targets.length; i++) {
      await store.writeLink({
        id: `l-${i + 1}`,
        namespace: 'g',
        fromId: 'a-1',
        toId: targets[i] as string,
        linkType: 'related',
        validFrom: 1,
        validUntil: null,
        sourceEpisodeId: 'ep-1',
      });
    }

    const call = async (): Promise<string[]> =>
      (
        await store.getConnected({
          namespace: 'g',
          fromAssertionId: 'a-1',
          maxDepth: 1,
          temporalAnchor: 10,
        })
      ).map((a) => a.id);

    const first = await call();
    // Links were inserted in ascending id order; the adapter's
    // `ORDER BY MIN(depth), created_at, id` therefore yields the targets in
    // insertion order.
    expect(first).toEqual(targets);
    // Reproducible: every repeated call returns the identical order.
    for (let i = 0; i < 5; i++) {
      expect(await call()).toEqual(first);
    }
    await store.close();
  });
});
