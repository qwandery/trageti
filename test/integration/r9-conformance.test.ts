import { describe, it, expect } from 'vitest';
import { openTestDb } from '../helpers/openTestDb.js';
import { TemporalStore } from '../../src/store/TemporalStore.js';
import { MockEmbeddingProvider } from '../../src/defaults/providers/MockEmbeddingProvider.js';
import { StructuredFormatter } from '../../src/defaults/formatting/StructuredFormatter.js';
import type {
  AssertionValidator,
  ContextAssemblyOptions,
  ContextFormatter,
  FormattedContext,
  NormalizedNewAssertion,
  RetrievalScorer,
  RetrievedAssertion,
  ValidationResult,
} from '../../src/domain/types.js';
import type { Logger, LogFields } from '../../src/internal/logger.js';
import { MigrationCompatibilityError, SchemaExtensionError, ValidationError } from '../../src/errors/index.js';
import type { TragetiError } from '../../src/errors/index.js';
import { citationFor } from '../fixtures/scenario.js';

const DIM = 4;

/** A custom validator that approves everything — used to prove store-level
 *  policy still applies when the default validator is replaced. */
class PassValidator implements AssertionValidator {
  validate(_assertion: NormalizedNewAssertion): ValidationResult {
    return { valid: true, errors: [] };
  }
}

class RecordingLogger implements Logger {
  readonly records: Array<{ level: string; code: string; fields: LogFields | undefined }> = [];
  debug(code: string, fields?: LogFields): void {
    this.records.push({ level: 'debug', code, fields });
  }
  info(code: string, fields?: LogFields): void {
    this.records.push({ level: 'info', code, fields });
  }
  warn(code: string, fields?: LogFields): void {
    this.records.push({ level: 'warn', code, fields });
  }
  error(code: string, fields?: LogFields): void {
    this.records.push({ level: 'error', code, fields });
  }
}

async function writeEpisode(store: TemporalStore, ns: string, id = 'ep-1'): Promise<void> {
  await store.writeEpisode({
    id,
    namespace: ns,
    position: 1,
    occurredAt: '2024-01-01T00:00:00Z',
    type: 'document',
    content: 'episode',
  });
}

describe('citation-excerpt policy cannot be bypassed by a custom validator', () => {
  it('writeAssertion rejects a null-excerpt citation under requireCitationExcerpt, even with a custom validator', async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      validators: [new PassValidator()],
      validation: { requireCitationExcerpt: true },
    });
    await store.init();
    await writeEpisode(store, 'ns');
    await expect(
      store.writeAssertion({
        id: 'a-1',
        namespace: 'ns',
        type: 'fact',
        content: 'content',
        validFrom: 1,
        validUntil: null,
        confidence: 0.9,
        sourceEpisodeId: 'ep-1',
        supersedesId: null,
        entityId: null,
        entityType: null,
        citations: [{ id: 'a-1:c0', episodeId: 'ep-1', sourceRef: 'chunk:1', excerpt: null }],
      }),
    ).rejects.toThrow(ValidationError);
    await store.close();
  });

  it('without the flag, a null-excerpt citation emits TRGT_CITATION_EXCERPT_MISSING exactly once', async () => {
    const logger = new RecordingLogger();
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      validators: [new PassValidator()],
      logger,
    });
    await store.init();
    await writeEpisode(store, 'ns');
    await store.writeAssertion({
      id: 'a-1',
      namespace: 'ns',
      type: 'fact',
      content: 'content',
      validFrom: 1,
      validUntil: null,
      confidence: 0.9,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-1', 'ep-1')],
    });
    const warnings = logger.records.filter((r) => r.code === 'TRGT_CITATION_EXCERPT_MISSING');
    expect(warnings).toHaveLength(1);
    await store.close();
  });
});

describe('retrieve() returns the assertion valid at the anchor (mid-chain)', () => {
  async function chainStore(): Promise<TemporalStore> {
    const store = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM });
    await store.init();
    await writeEpisode(store, 'ns');
    // A→B→C: A[1,5) → B[5,10) → C[10,∞). Shared token so BM25 matches all.
    const write = async (id: string, from: number, supersedesId: string | null) => {
      await store.writeAssertion({
        id,
        namespace: 'ns',
        type: 'fact',
        content: `sharedtoken version ${id}`,
        validFrom: from,
        validUntil: null,
        confidence: 0.9,
        sourceEpisodeId: 'ep-1',
        supersedesId,
        entityId: 'e-1',
        entityType: 'concept',
        citations: [citationFor(id, 'ep-1')],
      });
    };
    await write('A', 1, null);
    await write('B', 5, 'A');
    await write('C', 10, 'B');
    return store;
  }

  it('an anchor inside the middle version returns that middle version', async () => {
    const store = await chainStore();
    const { results } = await store.retrieve({
      namespace: 'ns',
      queryText: 'sharedtoken',
      retrievalStrategy: 'bm25',
      temporalAnchor: 7,
    });
    const ids = results.map((r) => r.id);
    expect(ids).toContain('B');
    expect(ids).not.toContain('A');
    expect(ids).not.toContain('C');
    await store.close();
  });

  it('default includeSuperseded:false returns only the version valid at the anchor', async () => {
    const store = await chainStore();
    const { results } = await store.retrieve({
      namespace: 'ns',
      queryText: 'sharedtoken',
      retrievalStrategy: 'bm25',
      temporalAnchor: 12,
    });
    expect(results.map((r) => r.id)).toEqual(['C']);
    await store.close();
  });

  it('includeSuperseded:true surfaces closed/superseded versions too', async () => {
    const store = await chainStore();
    const { results } = await store.retrieve({
      namespace: 'ns',
      queryText: 'sharedtoken',
      retrievalStrategy: 'bm25',
      temporalAnchor: 12,
      includeSuperseded: true,
    });
    const ids = results.map((r) => r.id);
    expect(ids).toContain('A');
    expect(ids).toContain('B');
    expect(ids).toContain('C');
    await store.close();
  });
});

describe('reindexNamespace validates newDimension before vec0 DDL', () => {
  async function vectorStore(): Promise<TemporalStore> {
    const store = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM });
    await store.init();
    return store;
  }

  it('rejects newDimension: 0 with ValidationError', async () => {
    const store = await vectorStore();
    await expect(
      store.reindexNamespace('ns', {
        newDimension: 0,
        embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
      }),
    ).rejects.toThrow(ValidationError);
    await store.close();
  });

  it('rejects a non-integer newDimension with ValidationError', async () => {
    const store = await vectorStore();
    await expect(
      store.reindexNamespace('ns', {
        newDimension: 2.5,
        embeddingProvider: new MockEmbeddingProvider({ dimension: DIM }),
      }),
    ).rejects.toThrow(ValidationError);
    await store.close();
  });
});

describe('graph traversal honors linkTypes and includeSuperseded', () => {
  async function graphStore(): Promise<TemporalStore> {
    const store = new TemporalStore(openTestDb(), { namespace: 'g', embeddingDimension: DIM });
    await store.init();
    await writeEpisode(store, 'g');
    const writeA = async (id: string) => {
      await store.writeAssertion({
        id,
        namespace: 'g',
        type: 'fact',
        content: `assertion ${id}`,
        validFrom: 1,
        validUntil: null,
        confidence: 0.9,
        sourceEpisodeId: 'ep-1',
        supersedesId: null,
        entityId: null,
        entityType: null,
        citations: [citationFor(id, 'ep-1')],
      });
    };
    await writeA('a-1');
    await writeA('a-2');
    await writeA('a-3');
    return store;
  }

  it('getConnected with linkTypes only traverses matching links', async () => {
    const store = await graphStore();
    await store.writeLink({
      id: 'l-rel',
      namespace: 'g',
      fromId: 'a-1',
      toId: 'a-2',
      linkType: 'related',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-1',
    });
    await store.writeLink({
      id: 'l-seq',
      namespace: 'g',
      fromId: 'a-1',
      toId: 'a-3',
      linkType: 'sequential',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-1',
    });
    const related = await store.getConnected({
      namespace: 'g',
      fromAssertionId: 'a-1',
      linkTypes: ['related'],
      maxDepth: 1,
      temporalAnchor: 10,
    });
    expect(related.map((a) => a.id)).toEqual(['a-2']);
    const all = await store.getConnected({
      namespace: 'g',
      fromAssertionId: 'a-1',
      maxDepth: 1,
      temporalAnchor: 10,
    });
    expect(all.map((a) => a.id).sort()).toEqual(['a-2', 'a-3']);
    await store.close();
  });

  it('getConnected traverses an expired link only when includeSuperseded is set', async () => {
    const store = await graphStore();
    // Link expired at position 5 — closed well before the anchor at 10.
    await store.writeLink({
      id: 'l-expired',
      namespace: 'g',
      fromId: 'a-1',
      toId: 'a-2',
      linkType: 'related',
      validFrom: 1,
      validUntil: 5,
      sourceEpisodeId: 'ep-1',
    });
    expect(
      await store.getConnected({
        namespace: 'g',
        fromAssertionId: 'a-1',
        maxDepth: 1,
        temporalAnchor: 10,
      }),
    ).toEqual([]);
    const withSuperseded = await store.getConnected({
      namespace: 'g',
      fromAssertionId: 'a-1',
      maxDepth: 1,
      temporalAnchor: 10,
      includeSuperseded: true,
    });
    expect(withSuperseded.map((a) => a.id)).toEqual(['a-2']);
    await store.close();
  });

  it('findPath honors linkTypes', async () => {
    const store = await graphStore();
    await store.writeLink({
      id: 'l-seq',
      namespace: 'g',
      fromId: 'a-1',
      toId: 'a-2',
      linkType: 'sequential',
      validFrom: 1,
      validUntil: null,
      sourceEpisodeId: 'ep-1',
    });
    expect(
      await store.findPath({
        namespace: 'g',
        fromAssertionId: 'a-1',
        toAssertionId: 'a-2',
        linkTypes: ['related'],
        maxDepth: 5,
        temporalAnchor: 10,
      }),
    ).toBeNull();
    const viaSequential = await store.findPath({
      namespace: 'g',
      fromAssertionId: 'a-1',
      toAssertionId: 'a-2',
      linkTypes: ['sequential'],
      maxDepth: 5,
      temporalAnchor: 10,
    });
    expect(viaSequential).not.toBeNull();
    expect(viaSequential!.map((l) => l.id)).toEqual(['l-seq']);
    await store.close();
  });
});

describe('getMigrations() reports appliedAt', () => {
  it('every applied migration carries a non-null appliedAt timestamp', async () => {
    const store = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM });
    await store.init();
    const migrations = await store.getMigrations();
    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.name).toBe('v001_baseline');
    for (const m of migrations) {
      expect(typeof m.appliedAt).toBe('string');
      expect(m.appliedAt).not.toBeNull();
    }
    await store.close();
  });
});

describe('FTS5 tokenizer validation at init', () => {
  it('rejects an unknown built-in tokenizer with SchemaExtensionError', async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      fts5Tokenizer: { tokenizer: 'not_a_real_tokenizer' },
    });
    await expect(store.init()).rejects.toThrow(SchemaExtensionError);
  });
});

describe('FTS5 tokenizer change on reopen is never silently ignored', () => {
  it('rebuilds silently when the database has no assertions', async () => {
    const db = openTestDb();
    const store1 = new TemporalStore(db, { namespace: 'ns', embeddingDimension: DIM });
    await store1.init();
    // Reopen with a different explicit tokenizer; the DB is empty → safe rebuild.
    const store2 = new TemporalStore(db, {
      namespace: 'ns',
      embeddingDimension: DIM,
      fts5Tokenizer: { tokenizer: 'porter' },
    });
    await store2.init();
    const result = await store2.rebuildFts();
    expect(result.newTokenizer.tokenizer).toBe('porter');
    await store2.close();
  });

  it('throws MigrationCompatibilityError when assertions exist', async () => {
    const db = openTestDb();
    const store1 = new TemporalStore(db, { namespace: 'ns', embeddingDimension: DIM });
    await store1.init();
    await writeEpisode(store1, 'ns');
    await store1.writeAssertion({
      id: 'a-1',
      namespace: 'ns',
      type: 'fact',
      content: 'content',
      validFrom: 1,
      validUntil: null,
      confidence: 0.9,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-1', 'ep-1')],
    });
    const store2 = new TemporalStore(db, {
      namespace: 'ns',
      embeddingDimension: DIM,
      fts5Tokenizer: { tokenizer: 'porter' },
    });
    await expect(store2.init()).rejects.toThrow(MigrationCompatibilityError);
  });
});

describe('retrieval input validation uses dedicated error codes', () => {
  async function seededStore(): Promise<TemporalStore> {
    const store = new TemporalStore(openTestDb(), { namespace: 'ns', embeddingDimension: DIM });
    await store.init();
    await writeEpisode(store, 'ns');
    await store.writeAssertion({
      id: 'a-1',
      namespace: 'ns',
      type: 'fact',
      content: 'foxes and badgers',
      validFrom: 1,
      validUntil: null,
      confidence: 0.9,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-1', 'ep-1')],
    });
    return store;
  }

  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (err) {
      return (err as TragetiError).code;
    }
    throw new Error('expected a rejection');
  };

  it('bad temporalWindow → RETRIEVAL_INVALID_TEMPORAL_WINDOW', async () => {
    const store = await seededStore();
    expect(
      await codeOf(
        store.retrieve({
          namespace: 'ns',
          queryText: 'foxes',
          retrievalStrategy: 'bm25',
          temporalWindow: { from: 9, to: 1 },
          temporalAnchor: 5,
        }),
      ),
    ).toBe('RETRIEVAL_INVALID_TEMPORAL_WINDOW');
    await store.close();
  });

  it('bad minConfidence → RETRIEVAL_INVALID_CONFIDENCE', async () => {
    const store = await seededStore();
    expect(
      await codeOf(
        store.retrieve({
          namespace: 'ns',
          queryText: 'foxes',
          retrievalStrategy: 'bm25',
          minConfidence: 2,
          temporalAnchor: 5,
        }),
      ),
    ).toBe('RETRIEVAL_INVALID_CONFIDENCE');
    await store.close();
  });

  it('bad tokenBudget → RETRIEVAL_INVALID_TOKEN_BUDGET', async () => {
    const store = await seededStore();
    expect(
      await codeOf(
        store.assembleContext({
          namespace: 'ns',
          temporalAnchor: 5,
          queryText: 'foxes',
          retrievalStrategy: 'bm25',
          tokenBudget: -1,
        }),
      ),
    ).toBe('RETRIEVAL_INVALID_TOKEN_BUDGET');
    await store.close();
  });

  it('scoreBatch length mismatch → SCORER_BATCH_LENGTH_MISMATCH', async () => {
    const store = await seededStore();
    const badScorer: RetrievalScorer = {
      score: () => 1,
      scoreBatch: () => [],
    };
    expect(
      await codeOf(
        store.retrieve({
          namespace: 'ns',
          queryText: 'foxes',
          retrievalStrategy: 'bm25',
          scorer: badScorer,
          temporalAnchor: 5,
        }),
      ),
    ).toBe('SCORER_BATCH_LENGTH_MISMATCH');
    await store.close();
  });
});

describe('AssembledContext.assertions matches the rendered text', () => {
  it('StructuredFormatter truncation: every returned assertion is in the rendered text', async () => {
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      defaultFormatter: new StructuredFormatter(),
    });
    await store.init();
    await writeEpisode(store, 'ns');
    // Several assertions across two entity types — StructuredFormatter groups
    // by entityType, so render order differs from insertion order.
    let pos = 1;
    for (const [id, entityType] of [
      ['a-1', 'alpha'],
      ['a-2', 'beta'],
      ['a-3', 'alpha'],
      ['a-4', 'beta'],
      ['a-5', 'alpha'],
    ] as const) {
      await store.writeAssertion({
        id,
        namespace: 'ns',
        type: 'fact',
        content: `searchterm assertion body ${id}`,
        validFrom: pos++,
        validUntil: null,
        confidence: 0.9,
        sourceEpisodeId: 'ep-1',
        supersedesId: null,
        entityId: null,
        entityType,
        citations: [citationFor(id, 'ep-1')],
      });
    }
    const result = await store.assembleContext({
      namespace: 'ns',
      temporalAnchor: 10,
      queryText: 'searchterm',
      retrievalStrategy: 'bm25',
      tokenBudget: 40,
    });
    expect(result.truncated).toBe(true);
    expect(result.assertions.length).toBe(result.coverage.includedAssertions);
    expect(result.assertions.length).toBeGreaterThan(0);
    for (const a of result.assertions) {
      expect(result.text).toContain(a.content);
    }
    await store.close();
  });

  it('falls back for a third-party formatter that omits includedAssertions', async () => {
    const minimalFormatter: ContextFormatter = {
      format(assertions: RetrievedAssertion[], _options: ContextAssemblyOptions): FormattedContext {
        return {
          text: assertions.map((a) => a.content).join('\n'),
          tokenEstimate: 0,
          truncated: false,
          includedCount: assertions.length,
          metadata: { formatter: 'minimal' },
        };
      },
    };
    const store = new TemporalStore(openTestDb(), {
      namespace: 'ns',
      embeddingDimension: DIM,
      defaultFormatter: minimalFormatter,
    });
    await store.init();
    await writeEpisode(store, 'ns');
    await store.writeAssertion({
      id: 'a-1',
      namespace: 'ns',
      type: 'fact',
      content: 'searchterm body',
      validFrom: 1,
      validUntil: null,
      confidence: 0.9,
      sourceEpisodeId: 'ep-1',
      supersedesId: null,
      entityId: null,
      entityType: null,
      citations: [citationFor('a-1', 'ep-1')],
    });
    const result = await store.assembleContext({
      namespace: 'ns',
      temporalAnchor: 5,
      queryText: 'searchterm',
      retrievalStrategy: 'bm25',
      tokenBudget: 1000,
    });
    expect(result.assertions.map((a) => a.id)).toEqual(['a-1']);
    await store.close();
  });
});
