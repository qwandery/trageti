import type { TemporalStore } from 'trageti';
import type { ExtractionProvider } from '../shared/providers.js';
import { generateNarrativeSynthesis } from '../shared/synthesis.js';
import { NAMESPACE } from './data/episodes.js';

export async function generateNarrative(store: TemporalStore, extractor: ExtractionProvider): Promise<string> {
  const result = await generateNarrativeSynthesis({
    store,
    extractor,
    namespace: NAMESPACE,
    queryText: 'trageti library evolution and current design',
    temporalAnchor: 10,
    retrievalStrategy: 'bm25',
    liveInstruction:
      'Below is a context window summarising the evolution and current design of the trageti TypeScript library. Write a single grounded paragraph (3-5 sentences) synthesising what the stored context supports right now.',
  });
  return result.text;
}
