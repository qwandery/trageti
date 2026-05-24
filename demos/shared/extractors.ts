// Compatibility exports for older demo scripts. New code should import from
// providers.ts so extraction and embedding stay independently configured.

import type { EmbeddingProvider } from 'trageti'
import {
  createAnthropicExtractionProvider,
  createOpenAICompatibleExtractionProvider,
  createOllamaNativeEmbeddingProvider,
  createOpenAICompatibleEmbeddingProvider,
} from './providers.js'

export function anthropicExtractor(apiKey: string): (prompt: string) => Promise<string> {
  const provider = createAnthropicExtractionProvider(apiKey)
  return (prompt) => provider.extract(prompt)
}

export function openaiExtractor(options: {
  baseUrl: string
  apiKey: string
  model: string
}): (prompt: string) => Promise<string> {
  const provider = createOpenAICompatibleExtractionProvider(options)
  return (prompt) => provider.extract(prompt)
}

export function ollamaEmbeddingProvider(opts: {
  host: string
  model: string
  dimension: number
}): EmbeddingProvider {
  return createOllamaNativeEmbeddingProvider(opts).provider
}

export function openaiEmbeddingProvider(opts: {
  baseUrl: string
  apiKey: string
  model: string
  dimension: number
}): EmbeddingProvider {
  return createOpenAICompatibleEmbeddingProvider(opts).provider
}
