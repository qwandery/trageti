import type {
  ContextFormatter,
  RetrievedAssertion,
  ContextAssemblyOptions,
  FormattedContext,
} from '../../domain/types.js'

const DEFAULT_TOKENS_PER_CHAR = 0.25

export class StructuredFormatter implements ContextFormatter {
  private readonly tokensPerChar: number

  constructor(tokensPerChar = DEFAULT_TOKENS_PER_CHAR) {
    this.tokensPerChar = tokensPerChar
  }

  format(assertions: RetrievedAssertion[], options: ContextAssemblyOptions): FormattedContext {
    const budget = options.tokenBudget

    // Group by entityType, then sort each group by position ascending
    const groups = new Map<string, RetrievedAssertion[]>()
    for (const a of assertions) {
      const key = a.entityType ?? '(unclassified)'
      const g = groups.get(key) ?? []
      g.push(a)
      groups.set(key, g)
    }
    for (const g of groups.values()) {
      g.sort((a, b) => a.validFrom - b.validFrom)
    }

    const sections: string[] = []
    let tokenEstimate = 0
    let truncated = false
    let included = 0

    for (const [entityType, items] of groups.entries()) {
      const header = `## ${entityType}`
      const headerTokens = Math.ceil(header.length * this.tokensPerChar)
      if (tokenEstimate + headerTokens > budget) { truncated = true; break }

      const bullets: string[] = []
      for (const item of items) {
        const bullet = `- [pos ${item.validFrom}] ${item.content}`
        const bulletTokens = Math.ceil(bullet.length * this.tokensPerChar)
        if (tokenEstimate + headerTokens + bulletTokens > budget) { truncated = true; break }
        bullets.push(bullet)
        tokenEstimate += bulletTokens
        included++
      }
      tokenEstimate += headerTokens
      sections.push(`${header}\n${bullets.join('\n')}`)
      if (truncated) break
    }

    return {
      text: sections.join('\n\n'),
      tokenEstimate,
      truncated,
      metadata: { formatter: 'structured', includedAssertions: included },
    }
  }
}
