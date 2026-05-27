// Annotated query set for alex-place. Demonstrates snapshot retrieval,
// trajectory retrieval, graph-expanded retrieval, and sparse entity follow-up.

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
    queryText: 'What does the literature say about sourdough acidity and fermentation schedule?',
    temporalAnchor: 20,
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
    temporalAnchor: 20,
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
      temporalAnchor: 20,
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
      temporalAnchor: 20,
      retrievalStrategy: 'hybrid',
      mode: 'trajectory',
      limit: 25,
    },
  },
  {
    annotation: `"How has Alex's ramen broth knowledge changed?" (trajectory)`,
    query: {
      namespace: NAMESPACE,
      queryText: "How has Alex's ramen broth knowledge changed?",
      temporalAnchor: 20,
      retrievalStrategy: 'hybrid',
      mode: 'trajectory',
      expandLinks: true,
      maxDepth: 1,
      limit: 25,
    },
  },
  {
    annotation: '"What did Alex learn from dinner feedback?" (current snapshot)',
    query: {
      namespace: NAMESPACE,
      queryText: 'What did Alex learn from dinner feedback?',
      temporalAnchor: 20,
      retrievalStrategy: 'hybrid',
      mode: 'snapshot',
      expandLinks: true,
      maxDepth: 1,
      limit: 25,
    },
  },
  {
    annotation: '"What does Alex know about knife skills and safe cutting?" (current snapshot)',
    query: {
      namespace: NAMESPACE,
      queryText: 'What does Alex know about knife skills and safe cutting?',
      temporalAnchor: 20,
      retrievalStrategy: 'hybrid',
      mode: 'snapshot',
      limit: 25,
    },
  },
  {
    annotation: '"What questions or contradictions are still unresolved?" (current snapshot)',
    query: {
      namespace: NAMESPACE,
      queryText: 'What questions or contradictions are still unresolved?',
      temporalAnchor: 20,
      retrievalStrategy: 'hybrid',
      mode: 'snapshot',
      expandLinks: true,
      maxDepth: 1,
      limit: 25,
    },
  },
  {
    annotation: '"What has Mrs. Park taught Alex?" (current snapshot)',
    query: {
      namespace: NAMESPACE,
      queryText: 'What has Mrs. Park taught Alex?',
      temporalAnchor: 20,
      retrievalStrategy: 'hybrid',
      mode: 'snapshot',
      expandLinks: true,
      maxDepth: 1,
      limit: 25,
    },
  },
]
