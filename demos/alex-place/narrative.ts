// Synthesis pass - assembles the current state of Alex's culinary journey
// from the assertion store and either runs a live LLM synthesis or returns a
// clearly-labeled pre-written paragraph. Demonstrates the downstream
// assembleContext -> LLM pattern trageti is designed to support.

import type { TemporalStore } from 'trageti';
import type { ExtractionProvider } from '../shared/providers.js';

const PRE_WRITTEN =
  '(pre-written synthesis - set ANTHROPIC_API_KEY or OPENAI_API_KEY for live synthesis)\n' +
  'Alex is partway through a self-directed culinary apprenticeship. The sourdough arc has ' +
  'moved from an over-soured loaf toward better acidity control, then hit a whole-wheat ' +
  'setback that Alex partially corrected with higher hydration and gentler handling. The ' +
  'ramen arc has shifted from admiring opaque broth to understanding the role of fat, gelatin, ' +
  'and vigorous boiling, while noodle texture remains a separate unresolved problem. Dinner ' +
  "feedback, Mrs. Park's kimchi advice, and knife-practice notes show Alex turning scattered " +
  'observations into repeatable technique without treating every question as solved.';

export async function generateNarrative(
  store: TemporalStore,
  extractor: ExtractionProvider,
  isLive: boolean,
): Promise<string> {
  const ctx = await store.assembleContext({
    namespace: 'alex-journal',
    queryText: 'cooking progress',
    temporalAnchor: 20,
    tokenBudget: 1000,
  });

  if (!isLive) return PRE_WRITTEN;

  const prompt = `Below is a context window summarising the current state of a home cook's culinary journal. Write a single grounded paragraph (3-5 sentences) synthesising what the stored context supports right now. Be specific, avoid lists, and do not invent family backstory, emotional history, memories, trauma, mastery, or conclusions that are not directly supported by the context. If a point is uncertain, preserve that uncertainty.

${ctx.text}`;
  return extractor.extract(prompt);
}
