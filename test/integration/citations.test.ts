import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openTestDb } from '../helpers/openTestDb.js'
import { TemporalStore } from '../../src/store/TemporalStore.js'
import { ValidationError } from '../../src/errors/index.js'
import type {
  AssertionValidator,
  NewAssertion,
  ValidationResult,
} from '../../src/domain/types.js'
import { citationFor } from '../fixtures/scenario.js'

const NS = 'cit-ns'
const NS2 = 'cit-ns-2'
const DIM = 4

function makeStore(db: Database, validators?: AssertionValidator[]): TemporalStore {
  const opts = { namespace: NS, embeddingDimension: DIM }
  return new TemporalStore(db, validators ? { ...opts, validators } : opts)
}

class PermissiveValidator implements AssertionValidator {
  validate(_assertion: NewAssertion): ValidationResult {
    return { valid: true, errors: [] }
  }
}

describe('TemporalStore — citations', () => {
  let db: Database
  let store: TemporalStore

  beforeEach(() => {
    db = openTestDb()
    store = makeStore(db)
    store.init()
    store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '', type: 'doc', content: 'c' })
    store.writeEpisode({ id: 'ep-2', namespace: NS, position: 2, occurredAt: '', type: 'doc', content: 'c' })
  })

  it('rejects an assertion with citations: []', () => {
    expect(() =>
      store.writeAssertion({
        id: 'a-empty', namespace: NS, type: 'fact', content: 'no citations',
        validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
        supersedesId: null, entityId: null, entityType: null,
        citations: [],
      }),
    ).toThrow(ValidationError)
  })

  it('rejects a citation pointing to a non-existent episode', () => {
    expect(() =>
      store.writeAssertion({
        id: 'a-bad-ep', namespace: NS, type: 'fact', content: 'bad ep',
        validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
        supersedesId: null, entityId: null, entityType: null,
        citations: [{ id: 'a-bad-ep:c0', episodeId: 'no-such-ep', sourceRef: 'chunk:1', excerpt: null }],
      }),
    ).toThrow(ValidationError)
  })

  it('rejects a citation in a different namespace from its parent', () => {
    store.initNamespace(NS2)
    store.writeEpisode({ id: 'ep-other', namespace: NS2, position: 1, occurredAt: '', type: 'doc', content: 'c' })
    expect(() =>
      store.writeAssertion({
        id: 'a-cross', namespace: NS, type: 'fact', content: 'cross-ns citation',
        validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
        supersedesId: null, entityId: null, entityType: null,
        citations: [{ id: 'a-cross:c0', episodeId: 'ep-other', sourceRef: 'chunk:1', excerpt: null }],
      }),
    ).toThrow(ValidationError)
  })

  it('rejects a citation with empty sourceRef', () => {
    expect(() =>
      store.writeAssertion({
        id: 'a-empty-ref', namespace: NS, type: 'fact', content: 'empty ref',
        validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
        supersedesId: null, entityId: null, entityType: null,
        citations: [{ id: 'a-empty-ref:c0', episodeId: 'ep-1', sourceRef: '', excerpt: null }],
      }),
    ).toThrow(ValidationError)
  })

  it('emits CITATION_EXCERPT_MISSING warning for null excerpt; does not throw', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(() =>
        store.writeAssertion({
          id: 'a-null-excerpt', namespace: NS, type: 'fact', content: 'null excerpt',
          validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
          supersedesId: null, entityId: null, entityType: null,
          citations: [citationFor('a-null-excerpt', 'ep-1')],
        }),
      ).not.toThrow()
      const warnings = writeSpy.mock.calls
        .map((args) => String(args[0]))
        .filter((s) => s.includes('CITATION_EXCERPT_MISSING'))
      expect(warnings.length).toBeGreaterThan(0)
      const payload = warnings.find((s) => s.includes('a-null-excerpt'))
      expect(payload).toBeDefined()
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('read paths populate citations on every assertion', () => {
    store.writeAssertion({
      id: 'a-read', namespace: NS, type: 'fact', content: 'readable',
      validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
      supersedesId: null, entityId: 'e-r', entityType: 'concept',
      citations: [
        { id: 'a-read:c0', episodeId: 'ep-1', sourceRef: 'chunk:1', excerpt: 'verbatim text' },
        { id: 'a-read:c1', episodeId: 'ep-2', sourceRef: 'chunk:2', excerpt: null },
      ],
    })

    // getAssertions
    const all = store.getAssertions(NS)
    const a = all.find((x) => x.id === 'a-read')
    expect(a?.citations.length).toBe(2)
    expect(a?.citations[0]?.sourceRef).toBe('chunk:1')
    expect(a?.citations[0]?.excerpt).toBe('verbatim text')
    expect(a?.citations[1]?.excerpt).toBeNull()

    // getEntityHistory
    const hist = store.getEntityHistory(NS, 'e-r')
    expect(hist[0]?.citations.length).toBe(2)
  })

  it('citation metadata round-trips as JSON', () => {
    store.writeAssertion({
      id: 'a-meta', namespace: NS, type: 'fact', content: 'meta',
      validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
      supersedesId: null, entityId: null, entityType: null,
      citations: [{
        id: 'a-meta:c0', episodeId: 'ep-1', sourceRef: 'chunk:1', excerpt: null,
        metadata: { confidence: 0.9, tags: ['structured', 'extractor-v2'] },
      }],
    })
    const all = store.getAssertions(NS)
    const a = all.find((x) => x.id === 'a-meta')
    expect(a?.citations[0]?.metadata).toEqual({ confidence: 0.9, tags: ['structured', 'extractor-v2'] })
  })

  it('writeCitation adds a citation to an existing assertion', () => {
    store.writeAssertion({
      id: 'a-late', namespace: NS, type: 'fact', content: 'late citation target',
      validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
      supersedesId: null, entityId: null, entityType: null,
      citations: [citationFor('a-late', 'ep-1')],
    })
    const cit = store.writeCitation({
      id: 'cit-late-1',
      assertionId: 'a-late',
      episodeId: 'ep-2',
      sourceRef: 'chunk:5',
      excerpt: 'late-discovered passage',
    })
    expect(cit.id).toBe('cit-late-1')
    expect(cit.createdAt).toBeDefined()
    const a = store.getAssertions(NS).find((x) => x.id === 'a-late')
    expect(a?.citations.length).toBe(2)
    expect(a?.citations.some((c) => c.id === 'cit-late-1')).toBe(true)
  })

  it('writeCitation rejects unknown assertionId', () => {
    expect(() =>
      store.writeCitation({
        id: 'cit-bad', assertionId: 'no-such-assertion', episodeId: 'ep-1', sourceRef: 'chunk:1', excerpt: null,
      }),
    ).toThrow(ValidationError)
  })

  it('writeCitation rejects cross-namespace episode', () => {
    store.writeAssertion({
      id: 'a-late2', namespace: NS, type: 'fact', content: 't',
      validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
      supersedesId: null, entityId: null, entityType: null,
      citations: [citationFor('a-late2', 'ep-1')],
    })
    store.initNamespace(NS2)
    store.writeEpisode({ id: 'ep-other', namespace: NS2, position: 1, occurredAt: '', type: 'doc', content: 'c' })
    expect(() =>
      store.writeCitation({
        id: 'cit-cross', assertionId: 'a-late2', episodeId: 'ep-other', sourceRef: 'chunk:1', excerpt: null,
      }),
    ).toThrow(ValidationError)
  })

  it('legacy citation-less assertion (direct SQL) reads with citations: []', () => {
    db.prepare(
      `INSERT INTO trl_assertions
         (id, namespace, type, content, valid_from, valid_until, confidence,
          source_episode_id, supersedes_id, entity_id, entity_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('a-legacy', NS, 'fact', 'pre-v002 direct insert', 1, null, 1.0, 'ep-1', null, null, null)
    const a = store.getAssertions(NS).find((x) => x.id === 'a-legacy')
    expect(a).toBeDefined()
    expect(a?.citations).toEqual([])
  })

  // ─── Transactional rollback tests (no private stubbing) ────────────────────

  it('rollback: duplicate citation IDs cause SQLite PK violation; assertion is not written', () => {
    expect(() =>
      store.writeAssertion({
        id: 'a-dup-cit', namespace: NS, type: 'fact', content: 'dup',
        validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
        supersedesId: null, entityId: null, entityType: null,
        citations: [
          { id: 'dup-c', episodeId: 'ep-1', sourceRef: 'chunk:1', excerpt: null },
          { id: 'dup-c', episodeId: 'ep-1', sourceRef: 'chunk:2', excerpt: null },
        ],
      }),
    ).toThrow()
    const a = db.prepare('SELECT id FROM trl_assertions WHERE id = ?').get('a-dup-cit') as { id: string } | undefined
    expect(a).toBeUndefined()
    const cits = db.prepare('SELECT COUNT(*) AS c FROM trl_citations WHERE assertion_id = ?').get('a-dup-cit') as { c: number }
    expect(cits.c).toBe(0)
  })

  it('rollback: pre-DB validation rejects supersession on already-closed predecessor; nothing written', () => {
    // Set up a valid predecessor and close it
    store.writeAssertion({
      id: 'pred', namespace: NS, type: 'fact', content: 'first',
      validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
      supersedesId: null, entityId: null, entityType: null,
      citations: [citationFor('pred', 'ep-1')],
    })
    store.supersedeAssertion('pred', { validUntil: 5 })

    // Now try to supersede it again via writeAssertion — should reject pre-DB.
    expect(() =>
      store.writeAssertion({
        id: 'a-supersede-closed', namespace: NS, type: 'fact', content: 'too late',
        validFrom: 7, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-2',
        supersedesId: 'pred', entityId: null, entityType: null,
        citations: [citationFor('a-supersede-closed', 'ep-2')],
      }),
    ).toThrow(ValidationError)
    const a = db.prepare('SELECT id FROM trl_assertions WHERE id = ?').get('a-supersede-closed') as { id: string } | undefined
    expect(a).toBeUndefined()
    // Predecessor's valid_until is unchanged
    const pred = db.prepare('SELECT valid_until FROM trl_assertions WHERE id = ?').get('pred') as { valid_until: number }
    expect(pred.valid_until).toBe(5)
  })
})

// ─── Custom-validator regression: structural invariants are non-bypassable ──

describe('TemporalStore — structural invariants are not delegated to replaceable validators', () => {
  it('citations: [] still rejects with validators: []', () => {
    const db = openTestDb()
    const store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM, validators: [] })
    store.init()
    store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '', type: 'doc', content: 'c' })
    expect(() =>
      store.writeAssertion({
        id: 'a-1', namespace: NS, type: 'fact', content: 'c',
        validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
        supersedesId: null, entityId: null, entityType: null,
        citations: [],
      }),
    ).toThrow(ValidationError)
  })

  it('non-existent supersedesId still rejects with permissive custom validator', () => {
    const db = openTestDb()
    const store = makeStore(db, [new PermissiveValidator()])
    store.init()
    store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '', type: 'doc', content: 'c' })
    expect(() =>
      store.writeAssertion({
        id: 'a-1', namespace: NS, type: 'fact', content: 'c',
        validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
        supersedesId: 'nonexistent', entityId: null, entityType: null,
        citations: [citationFor('a-1', 'ep-1')],
      }),
    ).toThrow(ValidationError)
  })

  it('cross-namespace citation episode still rejects with validators: []', () => {
    const db = openTestDb()
    const store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM, validators: [] })
    store.init()
    store.initNamespace(NS2)
    store.writeEpisode({ id: 'ep-1', namespace: NS, position: 1, occurredAt: '', type: 'doc', content: 'c' })
    store.writeEpisode({ id: 'ep-other', namespace: NS2, position: 1, occurredAt: '', type: 'doc', content: 'c' })
    expect(() =>
      store.writeAssertion({
        id: 'a-1', namespace: NS, type: 'fact', content: 'c',
        validFrom: 1, validUntil: null, confidence: 1, sourceEpisodeId: 'ep-1',
        supersedesId: null, entityId: null, entityType: null,
        citations: [{ id: 'a-1:c0', episodeId: 'ep-other', sourceRef: 'chunk:1', excerpt: null }],
      }),
    ).toThrow(ValidationError)
  })
})
