import type { RetrievalQuery, RetrievalResult, RetrievalMiddleware } from '../domain/types.js';

/**
 * Applies middleware chains around a retrieval function.
 * Before: global (registration order) → per-call (registration order)
 * After: per-call (reverse) → global (reverse)
 *
 * `before` hooks transform the query; `after` hooks transform the result
 * `results` array. The `meta` envelope is preserved across `after` hooks.
 */
export function applyMiddleware(
  globalMiddleware: readonly RetrievalMiddleware[],
  callMiddleware: readonly RetrievalMiddleware[],
  query: RetrievalQuery,
  fn: (q: RetrievalQuery) => RetrievalResult,
): RetrievalResult {
  const all = [...globalMiddleware, ...callMiddleware];

  let q = query;
  for (const mw of all) {
    if (mw.before) q = mw.before(q);
  }

  const result = fn(q);
  let results = result.results;

  for (const mw of [...all].reverse()) {
    if (mw.after) results = mw.after(results, q);
  }

  return { results, meta: result.meta };
}
