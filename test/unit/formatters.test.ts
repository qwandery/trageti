import { describe, it, expect } from 'vitest'
import { ProseFormatter } from '../../src/defaults/formatting/ProseFormatter.js'
import { StructuredFormatter } from '../../src/defaults/formatting/StructuredFormatter.js'
import { JsonFormatter } from '../../src/defaults/formatting/JsonFormatter.js'
import type { RetrievedAssertion, ContextAssemblyOptions } from '../../src/domain/types.js'

function makeAssertion(id: string, content: string, entityType: string | null = null): RetrievedAssertion {
  return {
    id,
    namespace: 'ns',
    type: 'fact',
    content,
    validFrom: 1,
    validUntil: null,
    confidence: 1,
    sourceEpisodeId: 'ep-1',
    supersedesId: null,
    entityId: null,
    entityType,
    createdAt: '2024-01-01T00:00:00Z',
    extensions: {},
    score: 0.9,
    scoreComponents: { semanticDistance: 0.1, bm25Score: null, position: 1 },
  }
}

const baseOptions: ContextAssemblyOptions = {
  namespace: 'ns',
  queryEmbedding: new Float32Array(4),
  temporalAnchor: 10,
  tokenBudget: 10_000,
}

describe('ProseFormatter', () => {
  it('formats assertions as prose lines', () => {
    const f = new ProseFormatter()
    const result = f.format([makeAssertion('a-1', 'The sky is blue.')], baseOptions)
    expect(result.text).toContain('The sky is blue.')
    expect(result.truncated).toBe(false)
  })

  it('truncates when token budget is exceeded', () => {
    const f = new ProseFormatter(1) // 1 token per char = very aggressive
    const assertions = Array.from({ length: 20 }, (_, i) =>
      makeAssertion(`a-${i}`, `This is a fairly long assertion number ${i} with plenty of text.`),
    )
    const result = f.format(assertions, { ...baseOptions, tokenBudget: 10 })
    expect(result.truncated).toBe(true)
  })

  it('tokenEstimate is non-negative', () => {
    const f = new ProseFormatter()
    const result = f.format([makeAssertion('a-1', 'Hello.')], baseOptions)
    expect(result.tokenEstimate).toBeGreaterThan(0)
  })
})

describe('StructuredFormatter', () => {
  it('groups assertions by entityType', () => {
    const f = new StructuredFormatter()
    const assertions = [
      makeAssertion('a-1', 'Claim one.', 'person'),
      makeAssertion('a-2', 'Claim two.', 'location'),
    ]
    const result = f.format(assertions, baseOptions)
    expect(result.text).toContain('## person')
    expect(result.text).toContain('## location')
  })

  it('uses (unclassified) for null entityType', () => {
    const f = new StructuredFormatter()
    const result = f.format([makeAssertion('a-1', 'No entity.')], baseOptions)
    expect(result.text).toContain('(unclassified)')
  })

  it('truncates when budget is exceeded', () => {
    const f = new StructuredFormatter(1)
    const assertions = Array.from({ length: 10 }, (_, i) =>
      makeAssertion(`a-${i}`, `Long assertion text ${i}.`, 'type-a'),
    )
    const result = f.format(assertions, { ...baseOptions, tokenBudget: 5 })
    expect(result.truncated).toBe(true)
  })
})

describe('JsonFormatter', () => {
  it('produces valid JSON', () => {
    const f = new JsonFormatter()
    const result = f.format([makeAssertion('a-1', 'Test claim.')], baseOptions)
    expect(() => JSON.parse(result.text)).not.toThrow()
  })

  it('includes content and id in output', () => {
    const f = new JsonFormatter()
    const result = f.format([makeAssertion('a-1', 'Test claim.')], baseOptions)
    const parsed = JSON.parse(result.text) as Array<{ id: string; content: string }>
    expect(parsed[0]?.id).toBe('a-1')
    expect(parsed[0]?.content).toBe('Test claim.')
  })

  it('truncates when budget is exceeded', () => {
    const f = new JsonFormatter(1)
    const assertions = Array.from({ length: 20 }, (_, i) =>
      makeAssertion(`a-${i}`, `Assertion with substantial content text number ${i}.`),
    )
    const result = f.format(assertions, { ...baseOptions, tokenBudget: 10 })
    expect(result.truncated).toBe(true)
  })
})
