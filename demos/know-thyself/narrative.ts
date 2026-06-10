import type { TragetiStore } from 'trageti';
import type { ExtractionProvider } from '../shared/providers.js';
import { generateNarrativeSynthesis } from '../shared/synthesis.js';
import { NAMESPACE } from './history.js';

export async function generateNarrative(
  store: TragetiStore,
  extractor: ExtractionProvider,
  temporalAnchor: number,
): Promise<string> {
  const result = await generateNarrativeSynthesis({
    store,
    extractor,
    namespace: NAMESPACE,
    queryText: 'repository evolution and current design',
    temporalAnchor,
    retrievalStrategy: 'bm25',
    liveInstruction:
      'Below is a context window summarising the evolution and current design of a git repository. Write a single grounded paragraph (3-5 sentences) synthesising what the stored context supports right now.',
  });
  return result.text;
}
