// Per-keyframe-pair source summaries. These mirror the reviewed source
// documents committed under data/sources/ and are kept as a compact debugging
// index for comparing source synthesis to extraction output.

export const aggregations: Record<string, string> = {
  'kf-1..kf-2':
    'v0.2 adds citation storage and trajectory retrieval. The temporal field is renamed from sequenceNumber to position, and citations become the expected provenance mechanism even before later structural enforcement.',
  'kf-2..kf-3':
    'v0.3 phase 1 moves the public store contract toward async operations and explicit lifecycle management, while adding typed errors, logging, metrics, and connection preparation.',
  'kf-3..kf-4':
    'v0.3 phase 2 adds vectorless namespace state, lazy vector table creation, migration v003, and foreign-key toggling around migrations.',
  'kf-4..kf-5':
    'v0.3 phase 3 moves indexing to the embedding-provider boundary, adds RawVectorProvider for caller-supplied vectors, and exposes rebuildFts as a maintenance path.',
  'kf-5..kf-6':
    'v0.3 phase 4 makes retrieval strategy routing explicit, adds queryTextMode, reports applied retrieval signals, and stabilizes tie-break behavior.',
  'kf-6..kf-7':
    'The v0.3.0 release gate updates package metadata, README, changelog, migration guidance, verification docs, and coverage thresholds.',
  'kf-7..kf-8':
    'Remediation R1 changes retrieval to return a RetrievalResult envelope, treats foreign-key enforcement as fail-closed, and adds advanced.closeAssertion.',
  'kf-8..kf-9':
    'Remediation R6 adds timestamp migration v004, table rename migration v005, and aligns verification docs with the implemented trageti_ schema.',
  'kf-9..kf-10':
    'The polish commit fixes snapshot supersession behavior, improves FTS5 errors, corrects startup step order, adds named defaults, and tightens graph determinism.',
};
