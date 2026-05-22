// Functional reference: run extraction over the committed episodes and the
// embedder over every assertion content + query text. Writes data/fixtures.ts
// and data/embeddings.ts.
//
// Usage: npx tsx examples/alex-place/generate-fixtures.ts
// Requires a live extractor env var AND a live embedder env var (paired).

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  anthropicExtractor,
  openaiExtractor,
  ollamaEmbeddingProvider,
  openaiEmbeddingProvider,
} from '../shared/extractors.js'
import { buildExtractionPrompt } from '../shared/prompt.js'
import { parseExtraction } from '../shared/parse.js'
import { episodes } from './data/episodes.js'
import { QUERY_TEXTS, EMBEDDING_DIMENSION } from './data/embeddings.js'

async function main(): Promise<void> {
  const anthropic = process.env['ANTHROPIC_API_KEY']
  const openai = process.env['OPENAI_API_KEY']
  const ollamaHost = process.env['OLLAMA_HOST']

  const extract = anthropic
    ? anthropicExtractor(anthropic)
    : openai
      ? openaiExtractor({ baseUrl: 'https://api.openai.com/v1', apiKey: openai, model: 'gpt-4o-mini' })
      : null
  if (!extract) throw new Error('generate-fixtures requires ANTHROPIC_API_KEY or OPENAI_API_KEY')

  const embedder = openai
    ? openaiEmbeddingProvider({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: openai,
        model: 'text-embedding-3-small',
        dimension: EMBEDDING_DIMENSION,
      })
    : ollamaHost
      ? ollamaEmbeddingProvider({
          host: ollamaHost,
          model: 'nomic-embed-text',
          dimension: EMBEDDING_DIMENSION,
        })
      : null
  if (!embedder) throw new Error('generate-fixtures requires OPENAI_API_KEY or OLLAMA_HOST for embeddings')

  const fixtures: Record<string, string> = {}
  const assertionEmbeddings: Record<string, number[]> = {}
  const allAssertions: Array<{ id: string; content: string }> = []

  for (const episode of episodes) {
    const prompt = buildExtractionPrompt(episode.content, [])
    const raw = await extract(prompt)
    fixtures[episode.id] = raw
    const result = parseExtraction(raw)
    for (const a of result.assertions) {
      allAssertions.push({ id: a.id, content: a.content })
    }
  }

  const assertionVectors = await embedder.embed(allAssertions.map((a) => a.content))
  for (let i = 0; i < allAssertions.length; i++) {
    const a = allAssertions[i]
    const v = assertionVectors[i]
    if (!a || !v) throw new Error(`generate-fixtures: assertion/vector misalignment at ${String(i)}`)
    assertionEmbeddings[a.id] = Array.from(v)
  }

  const queryEmbeddings: Record<string, number[]> = {}
  const queryVectors = await embedder.embed(QUERY_TEXTS)
  for (let i = 0; i < QUERY_TEXTS.length; i++) {
    const t = QUERY_TEXTS[i]
    const v = queryVectors[i]
    if (!t || !v) throw new Error(`generate-fixtures: query/vector misalignment at ${String(i)}`)
    queryEmbeddings[t] = Array.from(v)
  }

  console.log(`-> would write examples/alex-place/data/fixtures.ts (${String(Object.keys(fixtures).length)} entries)`)
  console.log(
    `-> would write examples/alex-place/data/embeddings.ts (${String(allAssertions.length)} assertion vectors, ${String(QUERY_TEXTS.length)} query vectors)`,
  )
  console.log('(file writing left to the operator — review LLM output before committing)')
  void writeFileSync
  void resolve
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
