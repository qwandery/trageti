import type { TragetiStore } from 'trageti';
import { generateNarrativeSynthesis, type SynthesisWarnLogger } from '../shared/synthesis.js';
import type { ExtractionProvider } from '../shared/providers.js';
import { NAMESPACE, NARRATIVE_QUERY_TEXT } from './big-brother.js';

export async function generateNarrative(
  store: TragetiStore,
  extractor: ExtractionProvider,
  latestPosition: number,
  logger?: SynthesisWarnLogger,
): Promise<string> {
  const result = await generateNarrativeSynthesis({
    store,
    extractor,
    namespace: NAMESPACE,
    queryText: NARRATIVE_QUERY_TEXT,
    temporalAnchor: latestPosition,
    retrievalStrategy: 'hybrid',
    liveInstruction:
      'Write a concise activity narrative from the screen-observation assertions. Identify visible apps and tools, apparent goals, progress over time, and a grounded next step.',
    fixtureText:
      'The screen history shows the user implementing the Big Brother demo, validating TypeScript work in a terminal, then consulting vision-input documentation and notes about provider configuration, image citations, and capture consent. The next supported step is to finish wiring multimodal provider requests, documentation, and validation.',
    ...(logger ? { logger } : {}),
  });
  return result.text;
}
