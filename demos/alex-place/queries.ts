// Annotated query set for the alex-place skeleton smoke test. Demonstrates
// snapshot mode, trajectory mode (supersession chain), a typed multi-hop
// traversal via findPath, and entity-history retrieval (the "Dad" near-miss).

import type { RetrievalQuery } from 'trageti'
import { NAMESPACE } from './data/episodes.js'

export interface RetrieveCase {
  annotation: string
  query: RetrievalQuery
}

export const retrieveQueries: readonly RetrieveCase[] = [
  {
    annotation:
      '"What did Alex know about making sourdough on January 20, 2026?" (early snapshot)',
    query: {
      namespace: NAMESPACE,
      queryText: 'What did Alex know about making sourdough on January 20, 2026?',
      temporalAnchor: 2,
      retrievalStrategy: 'hybrid',
      mode: 'snapshot',
      limit: 3,
    },
  },
  {
    annotation: '"What does Alex know about making sourdough today?" (latest snapshot)',
    query: {
      namespace: NAMESPACE,
      queryText: 'What does Alex know about making sourdough today?',
      temporalAnchor: 5,
      retrievalStrategy: 'hybrid',
      mode: 'snapshot',
      limit: 3,
    },
  },
  {
    annotation: '"How has my understanding of sourdough proofing evolved?" (hybrid trajectory)',
    query: {
      namespace: NAMESPACE,
      queryText: 'How has my understanding of sourdough proofing evolved?',
      temporalAnchor: 5,
      retrievalStrategy: 'hybrid',
      mode: 'trajectory',
      limit: 3,
    },
  },
]

// Multi-hop demo — uses store.findPath directly because the public
// retrieve({ expandLinks: true }) surface only exposes untyped
// linkedAssertions[]; we want the typed AssertionLink hops.
export const literaturePathQuery = {
  annotation:
    '"What does the literature say about my sourdough acidity?" (multi-hop via findPath)',
  options: {
    namespace: NAMESPACE,
    fromAssertionId: 'a-ref-field-0',
    toAssertionId: 'a-journal-4-0',
    temporalAnchor: 5,
    maxDepth: 2,
  },
}

// Entity-history demo — RetrievalQuery has no entityId filter (only
// entityTypes), so use getEntityHistory directly.
export const dadEntityQuery = {
  annotation: '"What would Dad think?" (getEntityHistory — the near-miss)',
  namespace: NAMESPACE,
  entityId: 'alex-father',
}
