import { describe, it, expect } from 'vitest';
import { applyMiddleware } from '../../src/pipeline/middleware.js';
import type { RetrievalMiddleware, RetrievalQuery, RetrievalResult } from '../../src/domain/types.js';

describe('applyMiddleware', () => {
  it('preserves the compatibility wrapper around split before and after hooks', () => {
    const order: string[] = [];
    const globalMiddleware: RetrievalMiddleware = {
      before: (query) => {
        order.push('global-before');
        return { ...query, limit: 1 };
      },
      after: (results) => {
        order.push('global-after');
        return results.map((result) => ({ ...result, score: result.score + 1 }));
      },
    };
    const callMiddleware: RetrievalMiddleware = {
      before: (query) => {
        order.push('call-before');
        return { ...query, temporalAnchor: 2 };
      },
      after: (results) => {
        order.push('call-after');
        return results;
      },
    };
    const query: RetrievalQuery = { namespace: 'mw', queryEmbedding: new Float32Array([1]), temporalAnchor: 1 };
    const result = applyMiddleware([globalMiddleware], [callMiddleware], query, (q): RetrievalResult => {
      order.push(`core:${String(q.limit)}:${String(q.temporalAnchor)}`);
      return {
        results: [
          {
            id: 'a-1',
            namespace: q.namespace,
            type: 'fact',
            content: 'content',
            validFrom: 1,
            validUntil: null,
            confidence: 1,
            sourceEpisodeId: 'ep-1',
            supersedesId: null,
            entityId: null,
            entityType: null,
            createdAt: '2024-01-01T00:00:00.000Z',
            extensions: {},
            score: 1,
            scoreComponents: { semanticDistance: null, bm25Score: null, position: 1 },
            citations: [],
          },
        ],
        meta: {
          namespace: q.namespace,
          temporalAnchor: q.temporalAnchor,
          limit: q.limit ?? 10,
          candidateCount: 1,
          retrievalStrategy: 'hybrid',
          vectorApplied: false,
          bm25Applied: false,
          queryTextMode: null,
          warnings: [],
        },
      };
    });

    expect(order).toEqual(['global-before', 'call-before', 'core:1:2', 'call-after', 'global-after']);
    expect(result.results[0]?.score).toBe(2);
    expect(result.meta.candidateCount).toBe(1);
  });
});
