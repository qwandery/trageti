// Reference ingestion: write episode -> extract via LLM -> write assertions/links.
// Indexing (vector embedding into sqlite-vec) is left to the caller, who knows
// whether to supply pre-computed vectors or rely on a configured EmbeddingProvider.

import type {
  TemporalStore,
  Episode,
  Assertion,
  AssertionLink,
  NewAssertionInput,
} from 'trageti'
import { buildExtractionPrompt } from './prompt.js'
import { parseExtraction } from './parse.js'

export interface IngestOptions {
  store: TemporalStore
  episode: Omit<Episode, 'createdAt'>
  document: string
  existingAssertions?: Assertion[]
  extract: (prompt: string) => Promise<string>
  namespace: string
  /** Replaces the default extraction prompt entirely. */
  promptOverride?: string
}

export interface ExtractionResult {
  assertions: NewAssertionInput[]
  links: Array<Omit<AssertionLink, 'createdAt'>>
}

export async function ingest(options: IngestOptions): Promise<ExtractionResult> {
  const { store, episode, document, existingAssertions, extract, promptOverride } = options
  await store.writeEpisode(episode)
  const prompt =
    promptOverride ?? buildExtractionPrompt(document, existingAssertions ?? [])
  const raw = await extract(prompt)
  const result = parseExtraction(raw)
  for (const a of result.assertions) {
    await store.writeAssertion(a)
  }
  for (const l of result.links) {
    await store.writeLink(l)
  }
  return result
}
