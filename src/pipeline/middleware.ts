import type { RetrievalQuery, RetrievedAssertion, RetrievalMiddleware } from '../domain/types.js'

/**
 * Applies middleware chains around a retrieval function.
 * Before: global (registration order) → per-call (registration order)
 * After: per-call (reverse) → global (reverse)
 */
export function applyMiddleware(
  globalMiddleware: readonly RetrievalMiddleware[],
  callMiddleware: readonly RetrievalMiddleware[],
  query: RetrievalQuery,
  fn: (q: RetrievalQuery) => RetrievedAssertion[],
): RetrievedAssertion[] {
  const all = [...globalMiddleware, ...callMiddleware]

  let q = query
  for (const mw of all) {
    if (mw.before) q = mw.before(q)
  }

  let results = fn(q)

  for (const mw of [...all].reverse()) {
    if (mw.after) results = mw.after(results, q)
  }

  return results
}
