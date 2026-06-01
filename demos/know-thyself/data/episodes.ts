import type { Episode } from 'trageti';

export const NAMESPACE = 'trageti-history';

export const episodes: ReadonlyArray<Omit<Episode, 'createdAt'>> = [
  {
    id: 'kf-1',
    namespace: NAMESPACE,
    position: 1,
    occurredAt: '2026-04-29T00:00:00Z',
    type: 'keyframe',
    content:
      'v0.1 implementation establishes TemporalStore, SQLite migrations, episodes, assertions, links, embeddings, BM25/vector retrieval, and weighted hybrid scoring. Source document: sources/kf-1.md.',
  },
  {
    id: 'kf-2',
    namespace: NAMESPACE,
    position: 2,
    occurredAt: '2026-05-10T00:00:00Z',
    type: 'keyframe',
    content:
      'v0.2 adds citation storage and trajectory retrieval. Citations become explicit assertion provenance, and supersession chains become directly queryable. Source document: sources/kf-1..kf-2.md.',
  },
  {
    id: 'kf-3',
    namespace: NAMESPACE,
    position: 3,
    occurredAt: '2026-05-19T00:00:00Z',
    type: 'keyframe',
    content:
      'v0.3 phase 1 changes the public contract toward async methods, lifecycle management, logging, metrics, and error foundations. Source document: sources/kf-2..kf-3.md.',
  },
  {
    id: 'kf-4',
    namespace: NAMESPACE,
    position: 4,
    occurredAt: '2026-05-19T00:00:00Z',
    type: 'keyframe',
    content:
      'v0.3 phase 2 adds vectorless namespace state, lazy vector table creation, migration v003, and foreign-key toggling around migrations. Source document: sources/kf-3..kf-4.md.',
  },
  {
    id: 'kf-5',
    namespace: NAMESPACE,
    position: 5,
    occurredAt: '2026-05-19T00:00:00Z',
    type: 'keyframe',
    content:
      'v0.3 phase 3 normalizes writes, introduces provider-driven indexing, RawVectorProvider, and rebuildFts. Source document: sources/kf-4..kf-5.md.',
  },
  {
    id: 'kf-6',
    namespace: NAMESPACE,
    position: 6,
    occurredAt: '2026-05-19T00:00:00Z',
    type: 'keyframe',
    content:
      'v0.3 phase 4 refines retrieval strategy routing, query text modes, score components, and deterministic tie-break behavior. Source document: sources/kf-5..kf-6.md.',
  },
  {
    id: 'kf-7',
    namespace: NAMESPACE,
    position: 7,
    occurredAt: '2026-05-19T00:00:00Z',
    type: 'keyframe',
    content:
      'v0.3.0 release gate adds package metadata, migration guidance, verification docs, coverage thresholds, and release-facing README updates. Source document: sources/kf-6..kf-7.md.',
  },
  {
    id: 'kf-8',
    namespace: NAMESPACE,
    position: 8,
    occurredAt: '2026-05-19T00:00:00Z',
    type: 'keyframe',
    content:
      'v0.3 remediation R1 introduces the RetrievalResult envelope, fail-closed foreign-key handling, README correction, and advanced closeAssertion behavior. Source document: sources/kf-7..kf-8.md.',
  },
  {
    id: 'kf-9',
    namespace: NAMESPACE,
    position: 9,
    occurredAt: '2026-05-20T00:00:00Z',
    type: 'keyframe',
    content:
      'v0.3 remediation R6 adds timestamp migration v004, table rename migration v005, and completes the trl_ to trageti_ schema transition. Source document: sources/kf-8..kf-9.md.',
  },
  {
    id: 'kf-10',
    namespace: NAMESPACE,
    position: 10,
    occurredAt: '2026-05-21T00:00:00Z',
    type: 'keyframe',
    content:
      'v0.3 polish fixes snapshot supersession behavior, improves FTS5 errors, orders startup steps correctly, adds named defaults, and tightens graph determinism. Source document: sources/kf-9..kf-10.md.',
  },
];
