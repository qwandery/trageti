import { describe, it, expect } from 'vitest';
import { RecommendedAssertionTypes, RecommendedLinkTypes } from '../../src/domain/vocabulary.js';

describe('vocabulary constants', () => {
  it('RecommendedAssertionTypes is frozen', async () => {
    expect(Object.isFrozen(RecommendedAssertionTypes)).toBe(true);
  });

  it('RecommendedLinkTypes is frozen', async () => {
    expect(Object.isFrozen(RecommendedLinkTypes)).toBe(true);
  });

  it('RecommendedAssertionTypes contains expected core types', async () => {
    expect(RecommendedAssertionTypes.FACT).toBe('fact');
    expect(RecommendedAssertionTypes.UPDATE).toBe('update');
  });

  it('RecommendedLinkTypes contains expected core types', async () => {
    expect(RecommendedLinkTypes.RELATED).toBe('related');
  });
});
