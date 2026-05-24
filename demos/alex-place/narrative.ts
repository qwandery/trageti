// Synthesis pass — assembles the current state of Alex's culinary journey
// from the assertion store and either runs a live LLM synthesis or returns a
// clearly-labeled pre-written paragraph. Demonstrates the downstream
// assembleContext → LLM pattern trageti is designed to support.

import type { TemporalStore } from 'trageti'
import type { ExtractionProvider } from '../shared/providers.js'

const PRE_WRITTEN =
  '(pre-written synthesis — set ANTHROPIC_API_KEY or OPENAI_API_KEY for live synthesis)\n' +
  "Alex is partway through a self-directed culinary apprenticeship. The sourdough arc has " +
  'turned a corner: the early bake was dense and over-soured, but a younger levain, shorter ' +
  'bulk, and no cold retard brought acidity in line — with the caveat that the technique has ' +
  'only been validated against one starter. A first encounter with a milky tonkotsu-style ' +
  'ramen broth has opened a new investigation: fat and gelatin both suspended in the boil, ' +
  'something Alex now wants to reverse-engineer at home.'

export async function generateNarrative(
  store: TemporalStore,
  extractor: ExtractionProvider,
  isLive: boolean,
): Promise<string> {
  const ctx = await store.assembleContext({
    namespace: 'alex-journal',
    queryText: 'cooking progress',
    temporalAnchor: 5,
    tokenBudget: 1000,
  })

  if (!isLive) return PRE_WRITTEN

  const prompt = `Below is a context window summarising the current state of a home cook's culinary journal. Write a single warm paragraph (3-5 sentences) synthesising where they are right now. Be specific, avoid lists, and let the human texture come through.

${ctx.text}`
  return extractor.extract(prompt)
}
