import type {
  ContextFormatter,
  RetrievedAssertion,
  ContextAssemblyOptions,
  FormattedContext,
  Assertion,
  AssertionCitation,
} from '../../domain/types.js'

const DEFAULT_TOKENS_PER_CHAR = 0.25

interface AssertionPayload {
  id: string
  type: string
  content: string
  validFrom: number
  validUntil: number | null
  confidence: number
  entityId: string | null
  entityType: string | null
  sourceEpisodeId: string
  citations: AssertionCitation[]
  score?: number
  supersessionChain?: AssertionPayload[]
}

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
      const itemJson = JSON.stringify(this.toRetrievedPayload(assertion))
      const itemTokens = Math.ceil(itemJson.length * this.tokensPerChar)
      if (tokenEstimate + itemTokens > budget) {
        truncated = true
        break
      }
      included.push(assertion)
      tokenEstimate += itemTokens
    }

    const text = JSON.stringify(
      included.map((a) => this.toRetrievedPayload(a)),
      null,
      2,
    )

    return {
      text,
      tokenEstimate,
      truncated,
      includedCount: included.length,
      includedAssertions: included,
      metadata: { formatter: 'json', includedAssertions: included.length },
    }
  }

  private toRetrievedPayload(assertion: RetrievedAssertion): AssertionPayload {
    const payload: AssertionPayload = {
      ...this.toAssertionPayload(assertion),
      score: assertion.score,
    }
    if (assertion.supersessionChain !== undefined) {
      payload.supersessionChain = assertion.supersessionChain.map((a) => this.toAssertionPayload(a))
    }
    return payload
  }

  private toAssertionPayload(assertion: Assertion): AssertionPayload {
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
      citations: assertion.citations,
    }
  }
}
