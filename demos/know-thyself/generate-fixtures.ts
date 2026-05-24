// Functional reference: run extraction over committed episodes via a live
// extractor, then embed every assertion content + query text via a live embedder.
//
// Usage: npx tsx demos/know-thyself/generate-fixtures.ts
// PowerShell: .\node_modules\.bin\tsx.cmd demos\know-thyself\generate-fixtures.ts

import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildExtractionPrompt } from '../shared/prompt.js'
import { parseExtraction } from '../shared/parse.js'
import {
  resolveLiveEmbeddingProvider,
  resolveLiveExtractionProvider,
} from '../shared/providers.js'
import { episodes } from './data/episodes.js'
import { QUERY_TEXTS, EMBEDDING_DIMENSION } from './data/embeddings.js'

async function main(): Promise<void> {
  const extractor = resolveLiveExtractionProvider()
  const embedder = resolveLiveEmbeddingProvider({ embeddingDimension: EMBEDDING_DIMENSION }).provider

  const fixtures: Record<string, string> = {}
  const assertionEmbeddings: Record<string, number[]> = {}
  const allAssertions: Array<{ id: string; content: string }> = []

  for (const episode of episodes) {
    const prompt = buildExtractionPrompt(episode.content, [])
    const raw = await extractor.extract(prompt, { episodeId: episode.id })
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

  const fixturesPath = resolve('demos/know-thyself/data/fixtures.ts')
  const embeddingsPath = resolve('demos/know-thyself/data/embeddings.ts')
  console.log(`-> would write ${fixturesPath} (${String(Object.keys(fixtures).length)} entries)`)
  console.log(
    `-> would write ${embeddingsPath} (${String(allAssertions.length)} assertion vectors, ${String(QUERY_TEXTS.length)} query vectors)`,
  )
  console.log('(file writing left to the operator - review LLM output before committing)')
  void writeFileSync
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
