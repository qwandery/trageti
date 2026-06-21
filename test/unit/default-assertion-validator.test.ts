import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultAssertionValidator } from '../../src/defaults/validation/DefaultAssertionValidator.js';
import type { NormalizedNewAssertion } from '../../src/domain/types.js';
import type { LogFields, Logger } from '../../src/internal/logger.js';

class CapturingLogger implements Logger {
  readonly warnings: Array<{ code: string; fields: LogFields | undefined }> = [];

  debug(): void {}
  info(): void {}
  warn(code: string, fields?: LogFields): void {
    this.warnings.push({ code, fields });
  }
  error(): void {}
}

function createAssertion(overrides: Partial<NormalizedNewAssertion> = {}): NormalizedNewAssertion {
  return {
    id: 'a-1',
    namespace: 'ns',
    type: 'fact',
    content: 'The roaster uses field fermentation.',
    validFrom: 1,
    validUntil: null,
    confidence: 0.9,
    sourceEpisodeId: 'ep-1',
    supersedesId: null,
    entityId: null,
    entityType: null,
    citations: [
      {
        id: 'c-1',
        episodeId: 'ep-1',
        sourceRef: 'note:1',
        excerpt: 'The roaster uses field fermentation.',
      },
    ],
    ...overrides,
  };
}

describe('DefaultAssertionValidator', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE trageti_episodes (
        id TEXT NOT NULL,
        namespace TEXT NOT NULL
      );
      INSERT INTO trageti_episodes (id, namespace) VALUES ('ep-1', 'ns');
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('accepts a well-formed assertion whose source episode exists', () => {
    const logger = new CapturingLogger();
    const validator = new DefaultAssertionValidator(db, { logger });

    expect(validator.validate(createAssertion())).toEqual({ valid: true, errors: [] });
    expect(logger.warnings).toEqual([]);
  });

  it('reports required-field, numeric, range, and confidence errors before checking the episode FK', () => {
    const validator = new DefaultAssertionValidator(db);
    const result = validator.validate(
      createAssertion({
        id: ' ',
        namespace: '',
        type: '',
        content: '',
        sourceEpisodeId: '',
        validFrom: Number.NaN,
        validUntil: Number.POSITIVE_INFINITY,
        confidence: 1.1,
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'id is required',
        'namespace is required',
        'type is required',
        'content is required',
        'sourceEpisodeId is required',
        'validFrom must be a finite number, got NaN',
        'validUntil must be a finite number, got Infinity',
        'confidence must be a number in [0.0, 1.0]',
      ]),
    );
    expect(result.errors).not.toEqual(expect.arrayContaining([expect.stringContaining('does not reference')]));
  });

  it('rejects a valid-looking assertion whose source episode is absent from the namespace', () => {
    const validator = new DefaultAssertionValidator(db);

    expect(validator.validate(createAssertion({ sourceEpisodeId: 'missing' }))).toEqual({
      valid: false,
      errors: ['sourceEpisodeId "missing" does not reference a known episode in namespace "ns"'],
    });
  });

  it('warns but accepts null citation excerpts by default', () => {
    const logger = new CapturingLogger();
    const validator = new DefaultAssertionValidator(db, { logger });

    const result = validator.validate(
      createAssertion({
        citations: [{ id: 'c-null', episodeId: 'ep-1', sourceRef: 'note:2', excerpt: null }],
      }),
    );

    expect(result).toEqual({ valid: true, errors: [] });
    expect(logger.warnings).toEqual([
      {
        code: 'TRGT_CITATION_EXCERPT_MISSING',
        fields: { assertionId: 'a-1', citationId: 'c-null' },
      },
    ]);
  });

  it('can require citation excerpts as validation failures', () => {
    const logger = new CapturingLogger();
    const validator = new DefaultAssertionValidator(db, { logger, requireCitationExcerpt: true });

    const result = validator.validate(
      createAssertion({
        citations: [{ id: 'c-null', episodeId: 'ep-1', sourceRef: 'note:2', excerpt: null }],
      }),
    );

    expect(result).toEqual({ valid: false, errors: ['citation "c-null" excerpt is required'] });
    expect(logger.warnings).toEqual([]);
  });

  it('can leave citation excerpt policy to the store without warning or failing', () => {
    const logger = new CapturingLogger();
    const validator = new DefaultAssertionValidator(db, {
      logger,
      requireCitationExcerpt: true,
      enforceCitationExcerptPolicy: false,
    });

    expect(
      validator.validate(
        createAssertion({
          citations: [{ id: 'c-null', episodeId: 'ep-1', sourceRef: 'note:2', excerpt: null }],
        }),
      ),
    ).toEqual({ valid: true, errors: [] });
    expect(logger.warnings).toEqual([]);
  });

  it('rejects a finite validUntil that is not greater than validFrom', () => {
    const validator = new DefaultAssertionValidator(db);

    expect(validator.validate(createAssertion({ validFrom: 4, validUntil: 4 })).errors).toContain(
      'validUntil must be strictly greater than validFrom',
    );
  });
});
