import type {
  ContextFormatter,
  RetrievedAssertion,
  ContextAssemblyOptions,
  FormattedContext,
} from '../../domain/types.js'

const DEFAULT_TOKENS_PER_CHAR = 0.25

export class JsonFormatter implements ContextFormatter {
  private readonly tokensPerChar: number

  constructor(tokensPerChar = DEFAULT_TOKENS_PER_CHAR) {
    this.tokensPerChar = tokensPerChar
  }

  format(assertions: RetrievedAssertion[], options: ContextAssemblyOptions): FormattedContext {
    const budget = options.tokenBudget
    const included: RetrievedAssertion[] = []
    let tokenEstimate = 0
    let truncated = false

    for (const assertion of assertions) {
      // Estimate tokens for this item before adding
      const itemJson = JSON.stringify(this.toPayload(assertion))
      const itemTokens = Math.ceil(itemJson.length * this.tokensPerChar)
      if (tokenEstimate + itemTokens > budget) {
        truncated = true
        break
      }
      included.push(assertion)
      tokenEstimate += itemTokens
    }

    const text = JSON.stringify(
      included.map((a) => this.toPayload(a)),
      null,
      2,
    )

    return {
      text,
      tokenEstimate,
      truncated,
      metadata: { formatter: 'json', includedAssertions: included.length },
    }
  }

  private toPayload(assertion: RetrievedAssertion): object {
    return {
      id: assertion.id,
      type: assertion.type,
      content: assertion.content,
      validFrom: assertion.validFrom,
      validUntil: assertion.validUntil,
      confidence: assertion.confidence,
      entityId: assertion.entityId,
      entityType: assertion.entityType,
      sourceEpisodeId: assertion.sourceEpisodeId,
      score: assertion.score,
    }
  }
}
