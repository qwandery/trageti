// Annotated query set for know-thyself. Queries cover current snapshots,
// trajectory retrieval, data-integrity evolution, vectorless retrieval, schema
// migration history, and graph/determinism refinements.

import type { RetrievalQuery } from 'trageti';
import { NAMESPACE } from './data/episodes.js';

export interface RetrieveCase {
  annotation: string;
  query: RetrievalQuery;
}

export const retrieveQueries: readonly RetrieveCase[] = [
  {
    annotation: '"What is the current retrieval result contract?" (hybrid snapshot @ position 10)',
    query: {
      namespace: NAMESPACE,
      queryText: 'What is the current retrieval result contract?',
      temporalAnchor: 10,
      retrievalStrategy: 'hybrid',
      mode: 'snapshot',
      expandLinks: true,
      maxDepth: 1,
      limit: 25,
    },
  },
  {
    annotation: '"How did the temporal model evolve?" (hybrid trajectory)',
    query: {
      namespace: NAMESPACE,
      queryText: 'How did the temporal model evolve?',
      temporalAnchor: 10,
      retrievalStrategy: 'hybrid',
      mode: 'trajectory',
      limit: 25,
    },
  },
  {
    annotation: '"How did citation provenance evolve?" (hybrid trajectory)',
    query: {
      namespace: NAMESPACE,
      queryText: 'How did citation provenance evolve?',
      temporalAnchor: 10,
      retrievalStrategy: 'hybrid',
      mode: 'trajectory',
      limit: 25,
    },
  },
  {
    annotation: '"How does the library handle data integrity?" (hybrid snapshot)',
    query: {
      namespace: NAMESPACE,
      queryText: 'How does the library handle data integrity?',
      temporalAnchor: 10,
      retrievalStrategy: 'hybrid',
      mode: 'snapshot',
      expandLinks: true,
      maxDepth: 1,
      limit: 25,
    },
  },
  {
    annotation: '"What changed about vectorless namespaces and embedding providers?" (snapshot)',
    query: {
      namespace: NAMESPACE,
      queryText: 'What changed about vectorless namespaces and embedding providers?',
      temporalAnchor: 10,
      retrievalStrategy: 'hybrid',
      mode: 'snapshot',
      expandLinks: true,
      maxDepth: 1,
      limit: 25,
    },
  },
  {
    annotation: '"How did retrieval determinism improve?" (snapshot + graph expansion)',
    query: {
      namespace: NAMESPACE,
      queryText: 'How did retrieval determinism improve?',
      temporalAnchor: 10,
      retrievalStrategy: 'hybrid',
      mode: 'snapshot',
      expandLinks: true,
      maxDepth: 1,
      limit: 25,
    },
  },
];

// Position-based snapshot: this uses store.getTemporalSnapshot directly because
// the question is "what was true at position N," not a similarity search.
export const snapshotAtV01 = {
  annotation: '"What was the temporal model as of v0.1?" (getTemporalSnapshot @ position 1)',
  options: {
    namespace: NAMESPACE,
    atPosition: 1,
  },
};
