import type { ContextAssemblyOptions, FormatterTokenOptions, TokenCounter } from '../../domain/types.js';
import { ErrorCode, RetrievalInputError, errorCodeOf } from '../../errors/index.js';

export const DEFAULT_TOKENS_PER_CHAR = 0.25;

export interface ResolvedTokenCounter {
  tokensPerChar: number;
  tokenCounter?: TokenCounter;
}

export function resolveTokenCounterOptions(options: number | FormatterTokenOptions = {}): ResolvedTokenCounter {
  if (typeof options === 'number') {
    return { tokensPerChar: options };
  }
  return {
    tokensPerChar: options.tokensPerChar ?? DEFAULT_TOKENS_PER_CHAR,
    ...(options.tokenCounter !== undefined && { tokenCounter: options.tokenCounter }),
  };
}

export function estimateTokens(
  text: string,
  formatterOptions: ResolvedTokenCounter,
  assemblyOptions: ContextAssemblyOptions,
): number {
  const counter = assemblyOptions.tokenCounter ?? formatterOptions.tokenCounter;
  if (!counter) return Math.ceil(text.length * formatterOptions.tokensPerChar);
  let count: number;
  try {
    count = counter(text);
  } catch (err) {
    throw new RetrievalInputError(ErrorCode.TOKEN_COUNTER_ERROR, `TokenCounter failed: ${errorCodeOf(err)}`);
  }
  if (!Number.isFinite(count) || count < 0) {
    throw new RetrievalInputError(
      ErrorCode.TOKEN_COUNTER_INVALID_OUTPUT,
      `TokenCounter must return a finite non-negative number, got ${String(count)}`,
    );
  }
  return Math.ceil(count);
}
