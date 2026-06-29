import type {
  ContextFormatter,
  RetrievedAssertion,
  ContextAssemblyOptions,
  FormattedContext,
  AssertionCitation,
  FormatterTokenOptions,
} from '../../domain/types.js';
import { estimateTokens, resolveTokenCounterOptions, type ResolvedTokenCounter } from './token-count.js';

function citationMarker(citations: AssertionCitation[]): string {
  if (citations.length === 0) return '';
  const parts = citations.map((c) => `${c.episodeId}#${c.sourceRef}`);
  return ` [${parts.join(', ')}]`;
}

export class StructuredFormatter implements ContextFormatter {
  private readonly tokenOptions: ResolvedTokenCounter;

  constructor(options?: number | FormatterTokenOptions) {
    this.tokenOptions = resolveTokenCounterOptions(options);
  }

  format(assertions: RetrievedAssertion[], options: ContextAssemblyOptions): FormattedContext {
    const budget = options.tokenBudget;

    // Group by entityType, then sort each group by position ascending
    const groups = new Map<string, RetrievedAssertion[]>();
    for (const a of assertions) {
      const key = a.entityType ?? '(unclassified)';
      const g = groups.get(key) ?? [];
      g.push(a);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      g.sort((a, b) => a.validFrom - b.validFrom);
    }

    const sections: string[] = [];
    // The rendered set, in render order (grouped + sorted) — not the input
    // order — so AssembledContext.assertions matches the rendered text.
    const includedAssertions: RetrievedAssertion[] = [];
    let tokenEstimate = 0;
    let truncated = false;

    for (const [entityType, items] of groups.entries()) {
      const header = `## ${entityType}`;
      const headerTokens = estimateTokens(header, this.tokenOptions, options);
      if (tokenEstimate + headerTokens > budget) {
        truncated = true;
        break;
      }

      const bullets: string[] = [];
      for (const item of items) {
        const bullet = `- [pos ${String(item.validFrom)}] ${item.content}${citationMarker(item.citations)}`;
        const bulletTokens = estimateTokens(bullet, this.tokenOptions, options);
        if (tokenEstimate + headerTokens + bulletTokens > budget) {
          truncated = true;
          break;
        }
        bullets.push(bullet);
        includedAssertions.push(item);
        tokenEstimate += bulletTokens;
      }
      if (bullets.length === 0) break;
      tokenEstimate += headerTokens;
      sections.push(`${header}\n${bullets.join('\n')}`);
      if (truncated) break;
    }

    return {
      text: sections.join('\n\n'),
      tokenEstimate,
      truncated,
      includedCount: includedAssertions.length,
      includedAssertions,
      metadata: { formatter: 'structured', includedAssertions: includedAssertions.length },
    };
  }
}
