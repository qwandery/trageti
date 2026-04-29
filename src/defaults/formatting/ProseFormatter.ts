import type {
  ContextFormatter,
  RetrievedAssertion,
  ContextAssemblyOptions,
  FormattedContext,
} from '../../domain/types.js'

const DEFAULT_TOKENS_PER_CHAR = 0.25

export class ProseFormatter implements ContextFormatter {
  private readonly tokensPerChar: number

  constructor(tokensPerChar = DEFAULT_TOKENS_PER_CHAR) {
    this.tokensPerChar = tokensPerChar
  }

  format(assertions: RetrievedAssertion[], options: ContextAssemblyOptions): FormattedContext {
    const budget = options.tokenBudget
    const lines: string[] = []
    let tokenEstimate = 0
    let truncated = false
    let included = 0

    for (const assertion of assertions) {
      const line = this.formatOne(assertion)
      const lineTokens = Math.ceil(line.length * this.tokensPerChar)
      if (tokenEstimate + lineTokens > budget) {
        truncated = true
        break
      }
      lines.push(line)
      tokenEstimate += lineTokens
      included++
    }

    return {
      text: lines.join('\n\n'),
      tokenEstimate,
      truncated,
      metadata: { formatter: 'prose', includedAssertions: included },
    }
  }

  private formatOne(assertion: RetrievedAssertion): string {
    const parts = [assertion.content]
    if (assertion.entityType) parts.push(`[${assertion.entityType}]`)
    parts.push(`(source: ${assertion.sourceEpisodeId}, pos: ${assertion.validFrom})`)
    return parts.join(' ')
  }
}
