/**
 * Shared retrieval / context-assembly / graph default constants.
 *
 * These values are part of the documented v0.3 behavior (see the spec's
 * Retrieval and Graph sections). They live in one module so the retrieval
 * pipeline, context assembly, and the graph wrappers cannot drift apart — and
 * so each magic number has a single, named, documented definition.
 */

/** Default `RetrievalQuery.limit` when the caller omits it. */
export const DEFAULT_RETRIEVAL_LIMIT = 10;

/**
 * Candidate over-fetch factor. Each retrieval stage selects
 * `limit * OVERSAMPLE_MULTIPLIER` candidates before scoring and truncation, so
 * ranking has headroom over the requested `limit`.
 */
export const OVERSAMPLE_MULTIPLIER = 3;

/**
 * Initial `retrieve()` limit used by `assembleContext()`: a deliberately large
 * fetch that the configured `ContextFormatter` then truncates down to the
 * caller's token budget.
 */
export const DEFAULT_ASSEMBLY_RETRIEVAL_LIMIT = 100;

/** Default hop budget for `store.getConnected()` when `maxDepth` is omitted. */
export const DEFAULT_GRAPH_CONNECTED_DEPTH = 3;

/** Default hop budget for `store.findPath()` when `maxDepth` is omitted. */
export const DEFAULT_GRAPH_PATH_DEPTH = 5;
