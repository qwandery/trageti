// Annotated query set for know-thyself. Queries are intentionally generic so
// the demo can run against any git repository keyframe series.

import type { RetrievalQuery } from 'trageti';
import { NAMESPACE, defaultQueryTexts } from './history.js';

export interface RetrieveCase {
  annotation: string;
  query: RetrievalQuery;
}

export function buildRetrieveQueries(latestPosition: number): readonly RetrieveCase[] {
  return defaultQueryTexts().map((queryText, index) => {
    const trajectory = index === 1 || index === 4 || index === 5;
    const query: RetrievalQuery = {
      namespace: NAMESPACE,
      queryText,
      temporalAnchor: latestPosition,
      retrievalStrategy: 'hybrid',
      mode: trajectory ? 'trajectory' : 'snapshot',
      limit: 25,
    };
    if (!trajectory) {
      query.expandLinks = true;
      query.maxDepth = 1;
    }
    return {
      annotation: `"${queryText}" (${trajectory ? 'hybrid trajectory' : 'hybrid snapshot'})`,
      query,
    };
  });
}

export function buildInitialSnapshot(initialPosition: number): {
  annotation: string;
  options: { namespace: string; atPosition: number };
} {
  return {
    annotation: `"What was true at the initial keyframe?" (getTemporalSnapshot @ position ${String(initialPosition)})`,
    options: {
      namespace: NAMESPACE,
      atPosition: initialPosition,
    },
  };
}
