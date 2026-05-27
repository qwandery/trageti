// Annotated query set for the alex-place skeleton smoke test. Demonstrates
// snapshot mode, trajectory mode (supersession chain), a typed multi-hop
// traversal via findPath, and entity-history retrieval (the "Dad" near-miss).

import type { RetrievalQuery } from 'trageti'
import { NAMESPACE } from './data/episodes.js'

export interface RetrieveCase {
  annotation: string
  query: RetrievalQuery
}

export const literatureSemanticQuery: RetrieveCase = {
  annotation: '"What does the literature say about my sourdough acidity?" (semantic retrieval + graph expansion)',
  query: {
    namespace: NAMESPACE,
    queryText: 'What does the literature say about my sourdough acidity?',
    temporalAnchor: 5,
    retrievalStrategy: 'hybrid',
    mode: 'snapshot',
    expandLinks: true,
    maxDepth: 1,
    limit: 25,
  },
}

export const dadSemanticQuery: RetrieveCase = {
  annotation: '"What would Dad think?" (semantic retrieval)',
  query: {
    namespace: NAMESPACE,
    queryText: 'What would Dad think?',
    temporalAnchor: 5,
    retrievalStrategy: 'hybrid',
    mode: 'snapshot',
    limit: 25,
  },
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
      limit: 25,
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
      limit: 25,
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
      limit: 25,
    },
  },
]
