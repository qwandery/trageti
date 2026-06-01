import type {
  ContextFormatter,
  RetrievedAssertion,
  ContextAssemblyOptions,
  FormattedContext,
  AssertionCitation,
} from '../../domain/types.js';

const DEFAULT_TOKENS_PER_CHAR = 0.25;

/** Compact citation marker, e.g. `[ep-1#chunk:3, ep-2#0:08:14-0:12:30]`. */
function citationMarker(citations: AssertionCitation[]): string {
  if (citations.length === 0) return '';
  const parts = citations.map((c) => `${c.episodeId}#${c.sourceRef}`);
  return ` [${parts.join(', ')}]`;
}

export class ProseFormatter implements ContextFormatter {
  private readonly tokensPerChar: number;

  constructor(tokensPerChar = DEFAULT_TOKENS_PER_CHAR) {
    this.tokensPerChar = tokensPerChar;
  }

  format(assertions: RetrievedAssertion[], options: ContextAssemblyOptions): FormattedContext {
    const budget = options.tokenBudget;
    const lines: string[] = [];
    const includedAssertions: RetrievedAssertion[] = [];
    let tokenEstimate = 0;
    let truncated = false;

    for (const assertion of assertions) {
      const line = this.formatOne(assertion);
      const lineTokens = Math.ceil(line.length * this.tokensPerChar);
      if (tokenEstimate + lineTokens > budget) {
        truncated = true;
        break;
      }
      lines.push(line);
      includedAssertions.push(assertion);
      tokenEstimate += lineTokens;
    }

    return {
      text: lines.join('\n\n'),
      tokenEstimate,
      truncated,
      includedCount: includedAssertions.length,
      includedAssertions,
      metadata: { formatter: 'prose', includedAssertions: includedAssertions.length },
    };
  }

  private formatOne(assertion: RetrievedAssertion): string {
    const parts = [assertion.content];
    if (assertion.entityType) parts.push(`[${assertion.entityType}]`);
    parts.push(`(source: ${assertion.sourceEpisodeId}, pos: ${String(assertion.validFrom)})`);
    return parts.join(' ') + citationMarker(assertion.citations);
  }
}
