import type { RetrievalQuery, RetrievalResult, RetrievalMiddleware, RetrievedAssertion } from '../domain/types.js';

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
  const q = applyBeforeHooks(globalMiddleware, callMiddleware, query);
  const result = fn(q);
  const results = applyAfterHooks(globalMiddleware, callMiddleware, result.results, q);
  return { results, meta: result.meta };
}

export function applyBeforeHooks(
  globalMiddleware: readonly RetrievalMiddleware[],
  callMiddleware: readonly RetrievalMiddleware[],
  query: RetrievalQuery,
): RetrievalQuery {
  const all = [...globalMiddleware, ...callMiddleware];
  let q = query;
  for (const mw of all) {
    if (mw.before) q = mw.before(q);
  }
  return q;
}

export function applyAfterHooks(
  globalMiddleware: readonly RetrievalMiddleware[],
  callMiddleware: readonly RetrievalMiddleware[],
  results: RetrievedAssertion[],
  query: RetrievalQuery,
): RetrievedAssertion[] {
  const all = [...globalMiddleware, ...callMiddleware];
  let out = results;
  for (const mw of [...all].reverse()) {
    if (mw.after) out = mw.after(out, query);
  }
  return out;
}
