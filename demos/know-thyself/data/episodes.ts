// Committed episode stand-ins for the skeleton. In the full demo these are
// produced by generate-episodes.ts from git diffs; here they are hand-written
// to keep the smoke test offline and reviewable.

import type { Episode } from 'trageti'

export const NAMESPACE = 'trageti-history'

export const episodes: ReadonlyArray<Omit<Episode, 'createdAt'>> = [
  {
    id: 'kf-1',
    namespace: NAMESPACE,
    position: 1,
    occurredAt: '2026-05-10T00:00:00Z',
    type: 'keyframe',
    content:
      'v0.1 implementation: weighted hybrid scoring formula (semantic + bm25 + recency); ' +
      'temporal model uses an Episode.sequenceNumber field; assertions are written without ' +
      'mandatory citations.',
  },
  {
    id: 'kf-2',
    namespace: NAMESPACE,
    position: 2,
    occurredAt: '2026-05-10T00:00:00Z',
    type: 'keyframe',
    content:
      'v0.2 adds citations and trajectory retrieval. Citations become an optional but ' +
      'recommended field on assertions. Trajectory mode reconstructs supersession chains. ' +
      'The temporal field is renamed: sequenceNumber → position, and generalized so callers ' +
      'can define their own ordinal scheme.',
  },
  {
    id: 'kf-3',
    namespace: NAMESPACE,
    position: 3,
    occurredAt: '2026-05-19T00:00:00Z',
    type: 'keyframe',
    content:
      'v0.3.0 release. The DefaultScorer is reworked into a four-case formula with weight ' +
      'renormalization. Citations become a structural invariant — every assertion must ' +
      'carry at least one. Vectorless namespaces (BM25-only) are supported alongside ' +
      'vector namespaces; foreign key enforcement and structural validation guard data ' +
      'integrity end to end.',
  },
]
