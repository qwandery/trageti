// Per-keyframe-pair aggregation summaries. In the full example these are
// produced by generate-episodes.ts (LLM call 1: "summarize what materially
// changed between these two commits"). Committed separately from fixtures so
// debugging can compare the aggregation to the extraction output.

export const aggregations: Record<string, string> = {
  'kf-1..kf-2':
    'Citations introduced as an optional assertion field; trajectory retrieval mode added. ' +
    'The temporal field is renamed from sequenceNumber to position and generalized so callers ' +
    'control the ordinal.',
  'kf-2..kf-3':
    'Scoring formula reworked into a four-case DefaultScorer with weight renormalization. ' +
    'Citations are promoted from optional to a structural invariant. Vectorless namespaces ' +
    '(BM25-only) added. Foreign key enforcement and structural validation are tightened.',
}
