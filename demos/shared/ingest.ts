// Reference ingestion: extract and validate via LLM -> write episode/assertions/links.
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
import type { ExtractionProvider } from './providers.js'

export interface IngestOptions {
  store: TemporalStore
  episode: Omit<Episode, 'createdAt'>
  document: string
  existingAssertions?: Assertion[]
  extractor: ExtractionProvider
  namespace: string
  /** Replaces the default extraction prompt entirely. */
  promptOverride?: string
}

export interface ExtractionResult {
  assertions: NewAssertionInput[]
  links: Array<Omit<AssertionLink, 'createdAt'>>
}

export async function ingest(options: IngestOptions): Promise<ExtractionResult> {
  const { store, episode, document, existingAssertions, extractor, promptOverride, namespace } = options
  const prompt =
    promptOverride ?? buildExtractionPrompt(document, existingAssertions ?? [], episode, namespace)
  const raw = await extractor.extract(prompt, { episodeId: episode.id })
  const result = parseExtraction(raw)
  validateExtractionResult(result, existingAssertions ?? [])

  const normalized = normalizeExtractionResult(result, namespace, episode)
  await store.writeEpisode(episode)
  for (const a of normalized.assertions) {
    await store.writeAssertion(a)
  }
  for (const l of normalized.links) {
    await store.writeLink(l)
  }
  return normalized
}

function normalizeExtractionResult(
  result: ExtractionResult,
  namespace: string,
  episode: Omit<Episode, 'createdAt'>,
): ExtractionResult {
  return {
    assertions: result.assertions.map((a) => ({
      ...a,
      namespace,
      sourceEpisodeId: episode.id,
      validFrom: episode.position,
      validUntil: a.validUntil ?? null,
      supersedesId: a.supersedesId ?? null,
      entityId: a.entityId ?? null,
      entityType: a.entityType ?? null,
      citations: a.citations.map((c) => ({ ...c, episodeId: episode.id })),
    })),
    links: result.links.map((l) => ({
      ...l,
      namespace,
      sourceEpisodeId: episode.id,
      validFrom: episode.position,
      validUntil: l.validUntil ?? null,
    })),
  }
}

function validateExtractionResult(result: ExtractionResult, existingAssertions: readonly Assertion[]): void {
  const errors: string[] = []
  const assertionIds = new Set<string>()
  const knownIds = new Set(existingAssertions.map((a) => a.id))
  const citationIds = new Set<string>()
  const linkIds = new Set<string>()

  if (!Array.isArray(result.assertions)) errors.push('assertions must be an array')
  if (!Array.isArray(result.links)) errors.push('links must be an array')

  for (const a of result.assertions) {
    if (!nonEmpty(a.id)) errors.push('assertion.id is required')
    if (!nonEmpty(a.type)) errors.push(`assertion "${a.id}" type is required`)
    if (!nonEmpty(a.content)) errors.push(`assertion "${a.id}" content is required`)
    if (!Number.isFinite(a.confidence)) errors.push(`assertion "${a.id}" confidence must be numeric`)
    if (!Array.isArray(a.citations) || a.citations.length === 0) {
      errors.push(`assertion "${a.id}" citations must be a non-empty array`)
    } else {
      for (const c of a.citations) {
        if (!nonEmpty(c.id)) errors.push(`assertion "${a.id}" citation.id is required`)
        if (nonEmpty(c.id) && citationIds.has(c.id)) errors.push(`duplicate citation id "${c.id}"`)
        if (nonEmpty(c.id)) citationIds.add(c.id)
        if (!nonEmpty(c.sourceRef)) errors.push(`citation "${c.id}" sourceRef is required`)
        if (c.excerpt !== null && !nonEmpty(c.excerpt)) errors.push(`citation "${c.id}" excerpt is required`)
      }
    }
    if (nonEmpty(a.id)) {
      if (assertionIds.has(a.id)) errors.push(`duplicate assertion id "${a.id}"`)
      if (knownIds.has(a.id)) errors.push(`assertion id "${a.id}" already exists`)
      assertionIds.add(a.id)
    }
  }

  for (const l of result.links) {
    if (!nonEmpty(l.id)) errors.push('link.id is required')
    if (nonEmpty(l.id) && linkIds.has(l.id)) errors.push(`duplicate link id "${l.id}"`)
    if (nonEmpty(l.id)) linkIds.add(l.id)
    if (!nonEmpty(l.fromId)) errors.push(`link "${l.id}" fromId is required`)
    if (!nonEmpty(l.toId)) errors.push(`link "${l.id}" toId is required`)
    if (!nonEmpty(l.linkType)) errors.push(`link "${l.id}" linkType is required`)
    for (const endpoint of [l.fromId, l.toId]) {
      if (nonEmpty(endpoint) && !assertionIds.has(endpoint) && !knownIds.has(endpoint)) {
        errors.push(`link "${l.id}" endpoint "${endpoint}" does not reference a known assertion`)
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Extraction result failed validation:\n${errors.map((e) => `- ${e}`).join('\n')}`)
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
