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

export function assembleContext(store: TemporalStore, options: AssembleOptions): AssembledContext {
  const query: RetrievalQuery = {
    namespace: options.namespace,
    queryEmbedding: options.queryEmbedding,
    temporalAnchor: options.temporalAnchor,
    limit: 100, // large initial fetch; formatter truncates by token budget
    ...(options.queryText !== undefined && { queryText: options.queryText }),
    ...(options.expandLinks !== undefined && { expandLinks: options.expandLinks }),
    ...(options.maxDepth !== undefined && { maxDepth: options.maxDepth }),
    ...(options.scorer !== undefined && { scorer: options.scorer }),
    ...(options.middleware !== undefined && { middleware: options.middleware }),
  }

  const assertions = store.retrieve(query)

  const formatter = options.formatter ?? options.globalFormatter
  const formatted = formatter.format(assertions, options)

  const positions = assertions.map((a) => a.validFrom)
  const from = positions.length > 0 ? Math.min(...positions) : options.temporalAnchor
  const to = positions.length > 0 ? Math.max(...positions) : options.temporalAnchor

  return {
    text: formatted.text,
    assertions: formatted.truncated ? assertions.slice(0, formatted.metadata['includedAssertions'] as number) : assertions,
    tokenEstimate: formatted.tokenEstimate,
    truncated: formatted.truncated,
    metadata: formatted.metadata,
    coverage: {
      totalAssertions: assertions.length,
      includedAssertions: (formatted.metadata['includedAssertions'] as number | undefined) ?? assertions.length,
      positionRange: { from, to },
    },
  }
}
