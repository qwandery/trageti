import { describe, it, expect } from 'vitest'
import { isReserved, RESERVED_SQLITE_KEYWORDS } from '../../src/db/schema/reserved-words.js'

describe('isReserved', () => {
  it('recognises uppercase keywords', () => {
    expect(isReserved('SELECT')).toBe(true)
    expect(isReserved('WHERE')).toBe(true)
    expect(isReserved('FROM')).toBe(true)
    expect(isReserved('TABLE')).toBe(true)
    expect(isReserved('INDEX')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isReserved('select')).toBe(true)
    expect(isReserved('Select')).toBe(true)
    expect(isReserved('sElEcT')).toBe(true)
  })

  it('returns false for non-reserved identifiers', () => {
    expect(isReserved('approval_status')).toBe(false)
    expect(isReserved('source_chunk_index')).toBe(false)
    expect(isReserved('my_custom_column')).toBe(false)
  })

  it('the keyword set is non-empty', () => {
    expect(RESERVED_SQLITE_KEYWORDS.size).toBeGreaterThan(50)
  })
})
