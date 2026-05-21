import type {
  ContextAssemblyOptions,
  AssembledContext,
  ContextFormatter,
  RetrievalQuery,
} from '../domain/types.js'
import type { TemporalStore } from '../store/TemporalStore.js'
import { ErrorCode, RetrievalInputError } from '../errors/index.js'

interface AssembleOptions extends ContextAssemblyOptions {
  globalFormatter: ContextFormatter
}

export async function assembleContext(
  store: TemporalStore,
  options: AssembleOptions,
): Promise<AssembledContext> {
  // Public-input validation before any SQLite execution (spec §200-202).
  // tokenBudget is a soft cap; project decision: a valid value is a positive
  // finite number.
  const tb = options.tokenBudget
  if (!Number.isFinite(tb) || tb <= 0) {
    throw new RetrievalInputError(
      ErrorCode.RETRIEVAL_INPUT_EMPTY,
      `tokenBudget must be a positive finite number, got ${String(tb)}`,
    )
  }

  const query: RetrievalQuery = {
    namespace: options.namespace,
    temporalAnchor: options.temporalAnchor,
    limit: 100, // large initial fetch; formatter truncates by token budget
  }
  if (options.queryEmbedding !== undefined) query.queryEmbedding = options.queryEmbedding
  if (options.queryText !== undefined) query.queryText = options.queryText
  if (options.queryTextMode !== undefined) query.queryTextMode = options.queryTextMode
  if (options.expandLinks !== undefined) query.expandLinks = options.expandLinks
  if (options.maxDepth !== undefined) query.maxDepth = options.maxDepth
  if (options.mode !== undefined) query.mode = options.mode
  if (options.scorer !== undefined) query.scorer = options.scorer
  if (options.middleware !== undefined) query.middleware = options.middleware
  if (options.retrievalStrategy !== undefined) query.retrievalStrategy = options.retrievalStrategy

  const retrieval = await store.retrieve(query)
  const assertions = retrieval.results

  const formatter = options.formatter ?? options.globalFormatter
  const formatted = formatter.format(assertions, options)

  const positions = assertions.map((a) => a.validFrom)
  const from = positions.length > 0 ? Math.min(...positions) : options.temporalAnchor
  const to = positions.length > 0 ? Math.max(...positions) : options.temporalAnchor

  return {
    text: formatted.text,
    assertions: formatted.truncated ? assertions.slice(0, formatted.includedCount) : assertions,
    tokenEstimate: formatted.tokenEstimate,
    truncated: formatted.truncated,
    metadata: formatted.metadata,
    coverage: {
      totalAssertions: assertions.length,
      includedAssertions: formatted.includedCount,
      positionRange: { from, to },
    },
  }
}
