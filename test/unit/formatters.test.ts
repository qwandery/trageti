import { describe, it, expect } from 'vitest'
import { ProseFormatter } from '../../src/defaults/formatting/ProseFormatter.js'
import { StructuredFormatter } from '../../src/defaults/formatting/StructuredFormatter.js'
import { JsonFormatter } from '../../src/defaults/formatting/JsonFormatter.js'
import type { RetrievedAssertion, ContextAssemblyOptions, AssertionCitation } from '../../src/domain/types.js'

function makeCitation(id: string, episodeId = 'ep-1', sourceRef = 'chunk:1'): AssertionCitation {
  return { id, assertionId: id.split(':')[0] ?? id, episodeId, sourceRef, excerpt: null, createdAt: '2024-01-01T00:00:00Z' }
}

function makeAssertion(
  id: string,
  content: string,
  entityType: string | null = null,
  citations: AssertionCitation[] = [makeCitation(`${id}:c0`)],
): RetrievedAssertion {
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
    citations,
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

  it('appends a compact citation marker', () => {
    const f = new ProseFormatter()
    const result = f.format(
      [makeAssertion('a-1', 'Cited claim.', null, [
        makeCitation('a-1:c0', 'ep-1', 'chunk:3'),
        makeCitation('a-1:c1', 'ep-2', '0:08:14-0:12:30'),
      ])],
      baseOptions,
    )
    expect(result.text).toContain('[ep-1#chunk:3, ep-2#0:08:14-0:12:30]')
  })

  it('citation marker length is counted toward tokenEstimate', () => {
    const f = new ProseFormatter()
    const noCit = f.format(
      [makeAssertion('a-1', 'Same content.', null, [])],
      baseOptions,
    )
    const withCit = f.format(
      [makeAssertion('a-1', 'Same content.', null, [makeCitation('a-1:c0', 'ep-long', 'a-very-long-source-reference-string')])],
      baseOptions,
    )
    expect(withCit.tokenEstimate).toBeGreaterThan(noCit.tokenEstimate)
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

  it('appends a compact citation marker per bullet', () => {
    const f = new StructuredFormatter()
    const result = f.format(
      [makeAssertion('a-1', 'Cited claim.', 'concept', [makeCitation('a-1:c0', 'ep-1', 'chunk:3')])],
      baseOptions,
    )
    expect(result.text).toContain('[ep-1#chunk:3]')
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

  it('includes citations in payload', () => {
    const f = new JsonFormatter()
    const result = f.format(
      [makeAssertion('a-1', 'Cited.', null, [makeCitation('a-1:c0', 'ep-1', 'chunk:3')])],
      baseOptions,
    )
    const parsed = JSON.parse(result.text) as Array<{ citations: AssertionCitation[] }>
    expect(parsed[0]?.citations.length).toBe(1)
    expect(parsed[0]?.citations[0]?.sourceRef).toBe('chunk:3')
  })

  it('includes supersessionChain in payload when present', () => {
    const f = new JsonFormatter()
    const a = makeAssertion('a-2', 'Current.')
    a.supersessionChain = [makeAssertion('a-1', 'Older version.')]
    const result = f.format([a], baseOptions)
    const parsed = JSON.parse(result.text) as Array<{ supersessionChain?: Array<{ id: string }> }>
    expect(parsed[0]?.supersessionChain?.[0]?.id).toBe('a-1')
  })
})
