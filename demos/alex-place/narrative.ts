// Synthesis pass - assembles the current state of Alex's culinary journey
// from the assertion store and either runs a live LLM synthesis or returns a
// clearly-labeled pre-written paragraph. Demonstrates the downstream
// assembleContext -> LLM pattern trageti is designed to support.

import type { TragetiStore } from 'trageti';
import type { ExtractionProvider } from '../shared/providers.js';
import { generateNarrativeSynthesis } from '../shared/synthesis.js';
import { NAMESPACE } from './data/episodes.js';

const PRE_WRITTEN =
  '(pre-written synthesis - configure DEMO_EXTRACT_PROVIDER for live synthesis)\n' +
  'Alex is partway through a self-directed culinary apprenticeship. The sourdough arc has ' +
  'moved from an over-soured loaf toward better acidity control, then hit a whole-wheat ' +
  'setback and a gluten-free turn after a physician identified gluten intolerance. The ' +
  'ramen arc has shifted from admiring opaque broth to understanding the role of fat, gelatin, ' +
  'and vigorous boiling, while noodle texture remains a separate unresolved problem. Dinner ' +
  "feedback, Mrs. Park's kimchi advice, knife-practice notes, and the gluten-free dinner show " +
  'Alex turning constraints and scattered observations into repeatable technique without treating every question as solved.';

export async function generateNarrative(store: TragetiStore, extractor: ExtractionProvider): Promise<string> {
  const result = await generateNarrativeSynthesis({
    store,
    extractor,
    namespace: NAMESPACE,
    queryText: 'cooking progress',
    temporalAnchor: 24,
    liveInstruction:
      "Below is a context window summarising the current state of a home cook's culinary journal. Write a single grounded paragraph (3-5 sentences) synthesising what the stored context supports right now. Do not invent family backstory, emotional history, memories, trauma, mastery, or conclusions that are not directly supported by the context.",
    fixtureText: PRE_WRITTEN,
  });
  return result.text;
}
