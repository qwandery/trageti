import type { RetrievalQuery } from 'trageti';
import { NAMESPACE, defaultQueryTexts } from './big-brother.js';

export interface RetrieveCase {
  annotation: string;
  query: RetrievalQuery;
}

export function buildRetrieveQueries(latestPosition: number): readonly RetrieveCase[] {
  return defaultQueryTexts().map((queryText, index) => {
    const trajectory = index === 2 || index === 3;
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
