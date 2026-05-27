// Functional reference: run extraction over committed episodes via a live
// extractor, then embed every assertion content + query text via a live embedder.
//
// Usage: npx tsx demos/know-thyself/generate-fixtures.ts [--write]

import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { buildExtractionPrompt } from '../shared/prompt.js'
import { parseExtraction } from '../shared/parse.js'
import { resolveCitationExcerpts, validateExtractionResult } from '../shared/ingest.js'
import {
  resolveLiveEmbeddingProvider,
  resolveLiveExtractionProvider,
} from '../shared/providers.js'
import { createLlmTraceOptions } from '../shared/output.js'
import { episodes } from './data/episodes.js'
import { citationSources } from './data/sources.js'
import { QUERY_TEXTS, EMBEDDING_DIMENSION } from './data/embeddings.js'

async function main(): Promise<void> {
  const writeCommitted = process.argv.includes('--write')
  const trace = createLlmTraceOptions()
  const extractor = resolveLiveExtractionProvider({ trace })
  const embedder = resolveLiveEmbeddingProvider({ embeddingDimension: EMBEDDING_DIMENSION, trace }).provider

  const fixtures: Record<string, string> = {}
  const assertionEmbeddings: Record<string, number[]> = {}
  const allAssertions: Array<{ id: string; content: string }> = []

  for (const episode of episodes) {
    const prompt = buildExtractionPrompt(episode.content, [], episode, episode.namespace, citationSources)
    const raw = await extractor.extract(prompt, { episodeId: episode.id })
    const result = parseExtraction(raw)
    const cited = resolveCitationExcerpts(result, episode.content, citationSources)
    validateExtractionResult(cited, [])
    fixtures[episode.id] = raw
    for (const a of cited.assertions) {
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
  const fixturesContent = renderFixtures(fixtures)
  const embeddingsContent = renderEmbeddings(assertionEmbeddings, queryEmbeddings)
  const reviewFixturesPath = resolve('demos/.local/know-thyself/generated-fixtures.ts')
  const reviewEmbeddingsPath = resolve('demos/.local/know-thyself/generated-embeddings.ts')
  writeGenerated(reviewFixturesPath, fixturesContent)
  writeGenerated(reviewEmbeddingsPath, embeddingsContent)

  console.log(`-> wrote review file ${reviewFixturesPath} (${String(Object.keys(fixtures).length)} entries)`)
  console.log(
    `-> wrote review file ${reviewEmbeddingsPath} (${String(allAssertions.length)} assertion vectors, ${String(QUERY_TEXTS.length)} query vectors)`,
  )
  if (writeCommitted) {
    writeGenerated(fixturesPath, fixturesContent)
    writeGenerated(embeddingsPath, embeddingsContent)
    console.log('-> updated committed know-thyself fixture files because --write was supplied')
  } else {
    console.log('(review .local generated files, then rerun with --write to replace committed fixture files)')
  }
}

function writeGenerated(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function renderFixtures(fixtures: Record<string, string>): string {
  return `export const fixtures: Record<string, string> = ${JSON.stringify(fixtures, null, 2)}\n`
}

function renderEmbeddings(
  assertionEmbeddings: Record<string, number[]>,
  queryEmbeddings: Record<string, number[]>,
): string {
  return [
    `export const EMBEDDING_DIMENSION = ${String(EMBEDDING_DIMENSION)}`,
    '',
    `export const QUERY_TEXTS: readonly string[] = ${JSON.stringify(QUERY_TEXTS, null, 2)}`,
    '',
    `export const assertionEmbeddings: Readonly<Record<string, number[]>> = ${JSON.stringify(assertionEmbeddings, null, 2)}`,
    '',
    `export const queryEmbeddings: Readonly<Record<string, number[]>> = ${JSON.stringify(queryEmbeddings, null, 2)}`,
    '',
  ].join('\n')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
