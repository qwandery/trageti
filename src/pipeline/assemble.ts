import type {
  ContextAssemblyOptions,
  AssembledContext,
  ContextFormatter,
  RetrievalQuery,
} from '../domain/types.js'
import type { TemporalStore } from '../store/TemporalStore.js'

interface AssembleOptions extends ContextAssemblyOptions {
  globalFormatter: ContextFormatter
}

export async function assembleContext(
  store: TemporalStore,
  options: AssembleOptions,
): Promise<AssembledContext> {
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
    assertions: formatted.truncated
      ? assertions.slice(0, formatted.metadata['includedAssertions'] as number)
      : assertions,
    tokenEstimate: formatted.tokenEstimate,
    truncated: formatted.truncated,
    metadata: formatted.metadata,
    coverage: {
      totalAssertions: assertions.length,
      includedAssertions:
        (formatted.metadata['includedAssertions'] as number | undefined) ?? assertions.length,
      positionRange: { from, to },
    },
  }
}
