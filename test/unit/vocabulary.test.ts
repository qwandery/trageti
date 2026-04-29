import { describe, it, expect } from 'vitest'
import { RecommendedAssertionTypes, RecommendedLinkTypes } from '../../src/domain/vocabulary.js'

describe('vocabulary constants', () => {
  it('RecommendedAssertionTypes is frozen', () => {
    expect(Object.isFrozen(RecommendedAssertionTypes)).toBe(true)
  })

  it('RecommendedLinkTypes is frozen', () => {
    expect(Object.isFrozen(RecommendedLinkTypes)).toBe(true)
  })

  it('RecommendedAssertionTypes contains expected core types', () => {
    expect(RecommendedAssertionTypes.FACT).toBe('fact')
    expect(RecommendedAssertionTypes.UPDATE).toBe('update')
  })

  it('RecommendedLinkTypes contains expected core types', () => {
    expect(RecommendedLinkTypes.RELATED).toBe('related')
  })
})
