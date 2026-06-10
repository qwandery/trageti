import type { ContextAssemblyOptions, AssembledContext, ContextFormatter, RetrievalQuery } from '../domain/types.js';
import type { TragetiStore } from '../store/TragetiStore.js';
import { ErrorCode, RetrievalInputError } from '../errors/index.js';
import { DEFAULT_ASSEMBLY_RETRIEVAL_LIMIT } from '../internal/retrieval-defaults.js';

interface AssembleOptions extends ContextAssemblyOptions {
  globalFormatter: ContextFormatter;
}

export async function assembleContext(store: TragetiStore, options: AssembleOptions): Promise<AssembledContext> {
  // Public-input validation before any SQLite execution (spec §200-202).
  // tokenBudget is a soft cap; public contract requires a positive integer.
  const tb = options.tokenBudget;
  if (!Number.isInteger(tb) || tb <= 0) {
    throw new RetrievalInputError(
      ErrorCode.RETRIEVAL_INVALID_TOKEN_BUDGET,
      `tokenBudget must be a positive integer, got ${String(tb)}`,
    );
  }

  const query: RetrievalQuery = {
    namespace: options.namespace,
    temporalAnchor: options.temporalAnchor,
    // Large initial fetch; the formatter truncates by token budget.
    limit: DEFAULT_ASSEMBLY_RETRIEVAL_LIMIT,
  };
  if (options.queryEmbedding !== undefined) query.queryEmbedding = options.queryEmbedding;
  if (options.queryText !== undefined) query.queryText = options.queryText;
  if (options.queryTextMode !== undefined) query.queryTextMode = options.queryTextMode;
  if (options.expandLinks !== undefined) query.expandLinks = options.expandLinks;
  if (options.maxDepth !== undefined) query.maxDepth = options.maxDepth;
  if (options.mode !== undefined) query.mode = options.mode;
  if (options.scorer !== undefined) query.scorer = options.scorer;
  if (options.middleware !== undefined) query.middleware = options.middleware;
  if (options.retrievalStrategy !== undefined) query.retrievalStrategy = options.retrievalStrategy;
  if (options.debug !== undefined) query.debug = options.debug;
  if (options.signal !== undefined) query.signal = options.signal;

  const retrieval = await store.retrieve(query);
  const assertions = retrieval.results;

  const formatter = options.formatter ?? options.globalFormatter;
  const formatted = formatter.format(assertions, options);

  // The assertions actually rendered into `text`. A formatter that reorders or
  // regroups (e.g. StructuredFormatter) reports them via `includedAssertions`;
  // for third-party formatters that omit it, fall back to the input prefix.
  const renderedAssertions =
    formatted.includedAssertions ?? (formatted.truncated ? assertions.slice(0, formatted.includedCount) : assertions);

  const positions = assertions.map((a) => a.validFrom);
  const from = positions.length > 0 ? Math.min(...positions) : options.temporalAnchor;
  const to = positions.length > 0 ? Math.max(...positions) : options.temporalAnchor;

  return {
    text: formatted.text,
    assertions: renderedAssertions,
    tokenEstimate: formatted.tokenEstimate,
    truncated: formatted.truncated,
    metadata: formatted.metadata,
    coverage: {
      totalAssertions: assertions.length,
      includedAssertions: formatted.includedCount,
      positionRange: { from, to },
    },
  };
}
