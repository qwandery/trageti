// Annotated query set for the know-thyself skeleton smoke test. Four queries
// exercising snapshot mode, trajectory mode (supersession chain), a
// position-based snapshot via getTemporalSnapshot, and a hybrid retrieval
// whose output annotates raw scoreComponents + applied-signal flags.

import type { RetrievalQuery } from 'trageti'
import { NAMESPACE } from './data/episodes.js'

export interface RetrieveCase {
  annotation: string
  query: RetrievalQuery
}

export const retrieveQueries: readonly RetrieveCase[] = [
  {
    annotation: '"What is the current scoring formula?" (hybrid snapshot @ position 3)',
    query: {
      namespace: NAMESPACE,
      queryText: 'What is the current scoring formula?',
      temporalAnchor: 3,
      retrievalStrategy: 'hybrid',
      mode: 'snapshot',
      limit: 25,
    },
  },
  {
    annotation: '"How did the temporal model evolve?" (hybrid trajectory)',
    query: {
      namespace: NAMESPACE,
      queryText: 'How did the temporal model evolve?',
      temporalAnchor: 3,
      retrievalStrategy: 'hybrid',
      mode: 'trajectory',
      limit: 25,
    },
  },
  {
    annotation:
      '"How does the library handle data integrity?" (hybrid; demonstrates raw scoreComponents)',
    query: {
      namespace: NAMESPACE,
      queryText: 'How does the library handle data integrity?',
      temporalAnchor: 3,
      retrievalStrategy: 'hybrid',
      mode: 'snapshot',
      limit: 25,
    },
  },
]

// Position-based snapshot — uses store.getTemporalSnapshot directly because
// the question is "what was true at position N," not a similarity search.
export const snapshotAtV01 = {
  annotation: '"What was the temporal model as of v0.1?" (getTemporalSnapshot @ position 1)',
  options: {
    namespace: NAMESPACE,
    atPosition: 1,
  },
}
