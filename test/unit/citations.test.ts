import { describe, expect, it } from 'vitest';
import { selfCitation } from '../../src/domain/citations.js';

describe('selfCitation', () => {
  it('builds a stable minimal citation for writeAssertion', () => {
    expect(
      selfCitation({
        assertionId: 'a-1',
        episodeId: 'ep-1',
        content: 'verbatim assertion content',
      }),
    ).toEqual({
      id: 'a-1:self',
      episodeId: 'ep-1',
      sourceRef: 'self:a-1',
      excerpt: 'verbatim assertion content',
    });
  });

  it('preserves caller-supplied optional fields', () => {
    expect(
      selfCitation({
        assertionId: 'a-1',
        episodeId: 'ep-1',
        content: 'content',
        id: 'custom',
        sourceRef: 'chunk:1',
        excerptStart: '0',
        excerptEnd: '10',
        metadata: { page: 1 },
      }),
    ).toEqual({
      id: 'custom',
      episodeId: 'ep-1',
      sourceRef: 'chunk:1',
      excerpt: 'content',
      excerptStart: '0',
      excerptEnd: '10',
      metadata: { page: 1 },
    });
  });
});
