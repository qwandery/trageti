import { describe, it, expect } from 'vitest'
import { namespaceToTableSuffix, namespaceToEmbeddingTable } from '../../src/internal/hash.js'

describe('namespaceToTableSuffix', () => {
  it('produces a 16 hex char string', () => {
    const suffix = namespaceToTableSuffix('my-namespace')
    expect(suffix).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic', () => {
    expect(namespaceToTableSuffix('test')).toBe(namespaceToTableSuffix('test'))
  })

  it('produces distinct values for distinct namespaces', () => {
    const a = namespaceToTableSuffix('namespace-a')
    const b = namespaceToTableSuffix('namespace-b')
    expect(a).not.toBe(b)
  })

  it('handles empty string', () => {
    const suffix = namespaceToTableSuffix('')
    expect(suffix).toMatch(/^[0-9a-f]{16}$/)
  })

  it('handles unicode namespace strings', () => {
    const suffix = namespaceToTableSuffix('名前空間-テスト')
    expect(suffix).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('namespaceToEmbeddingTable', () => {
  it('has the correct prefix format', () => {
    const table = namespaceToEmbeddingTable('my-namespace')
    expect(table).toMatch(/^trl_embeddings_[0-9a-f]{16}$/)
  })

  it('is deterministic', () => {
    expect(namespaceToEmbeddingTable('test')).toBe(namespaceToEmbeddingTable('test'))
  })
})
