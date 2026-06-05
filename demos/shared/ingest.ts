// Reference ingestion: extract and validate via LLM -> write episode/assertions/links.
// Indexing (vector embedding into sqlite-vec) is left to the caller, who knows
// whether to supply pre-computed vectors or rely on a configured EmbeddingProvider.

import type { TemporalStore, Episode, Assertion, AssertionLink, NewAssertionInput } from 'trageti';
import { buildExtractionPrompt } from './prompt.js';
import { parseExtraction } from './parse.js';
import type { ExtractionProvider, ExtractionImageInput } from './providers.js';

export interface IngestOptions {
  store: TemporalStore;
  episode: Omit<Episode, 'createdAt'>;
  document: string;
  citationSources?: Record<string, string>;
  imageSources?: Record<string, ExtractionImageInput>;
  existingAssertions?: Assertion[];
  extractor: ExtractionProvider;
  namespace: string;
  /** Replaces the default extraction prompt entirely. */
  promptOverride?: string;
  sanitizeExtractionResult?: (result: ExtractionResult) => ExtractionResult;
}

export interface ExtractionResult {
  assertions: NewAssertionInput[];
  links: Array<Omit<AssertionLink, 'createdAt'>>;
}

export async function ingest(options: IngestOptions): Promise<ExtractionResult> {
  const {
    store,
    episode,
    document,
    citationSources,
    imageSources,
    existingAssertions,
    extractor,
    promptOverride,
    namespace,
  } = options;
  const prompt =
    promptOverride ??
    buildExtractionPrompt(document, existingAssertions ?? [], episode, namespace, citationSources, imageSources);
  const extractOptions = {
    episodeId: episode.id,
    responseFormat: 'json' as const,
    ...(imageSources !== undefined ? { images: imageSources } : {}),
  };
  const raw = await extractor.extract(prompt, extractOptions);
  const result = parseExtractionForEpisode(raw, episode.id);
  const resolved = resolveCitationExcerpts(result, document, citationSources, imageSources);
  const cited = options.sanitizeExtractionResult?.(resolved) ?? resolved;
  validateExtractionResult(cited, existingAssertions ?? []);

  const normalized = normalizeExtractionResult(cited, namespace, episode);
  await store.writeEpisode(episode);
  for (const a of normalized.assertions) {
    await store.writeAssertion(a);
  }
  for (const l of normalized.links) {
    await store.writeLink(l);
  }
  return normalized;
}

function parseExtractionForEpisode(raw: string, episodeId: string): ExtractionResult {
  try {
    return parseExtraction(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Extraction failed for episode "${episodeId}": provider returned text that does not match the required JSON extraction schema.\n` +
        `${message}\n` +
        'Use --llm-trace=full to inspect the streamed response frames, or switch to a model/provider that follows JSON object responses.',
      { cause: err },
    );
  }
}

export function resolveCitationExcerpts(
  result: ExtractionResult,
  document: string,
  citationSources?: Record<string, string>,
  imageSources?: Record<string, ExtractionImageInput>,
): ExtractionResult {
  return {
    assertions: result.assertions.map((a) => ({
      ...a,
      citations: Array.isArray(a.citations)
        ? a.citations.map((c) => {
            if (c.excerpt !== null && c.excerpt !== undefined) {
              throw new Error(
                `Extraction result failed citation validation:\n` +
                  `- citation "${c.id}" supplied excerpt text directly; provide excerptStart/excerptEnd and set excerpt to null`,
              );
            }
            if (isImageCitation(c.sourceRef, imageSources)) {
              const imageCitation = {
                ...c,
                excerpt: c.excerpt ?? null,
              };
              if (c.excerptStart !== undefined) imageCitation.excerptStart = c.excerptStart;
              if (c.excerptEnd !== undefined) imageCitation.excerptEnd = c.excerptEnd;
              return imageCitation;
            }
            const source = resolveCitationSource(c.sourceRef, document, citationSources);
            const start = parseOffset(c.excerptStart);
            const end = parseOffset(c.excerptEnd);
            if (start === null || end === null || start < 0 || end <= start || end > source.content.length) {
              throw new Error(
                `Extraction result failed citation validation:\n` +
                  `- citation "${c.id}" has invalid excerptStart/excerptEnd offsets for source "${source.id}" length ${String(source.content.length)}`,
              );
            }
            const excerpt = source.content.slice(start, end);
            if (excerpt.trim().length === 0) {
              throw new Error(
                `Extraction result failed citation validation:\n` +
                  `- citation "${c.id}" offsets resolve to empty source text`,
              );
            }
            return {
              ...c,
              excerpt,
              excerptStart: String(start),
              excerptEnd: String(end),
            };
          })
        : a.citations,
    })),
    links: result.links,
  };
}

function isImageCitation(sourceRef: string, imageSources?: Record<string, ExtractionImageInput>): boolean {
  return imageSources !== undefined && Object.prototype.hasOwnProperty.call(imageSources, sourceRef);
}

function resolveCitationSource(
  sourceRef: string,
  document: string,
  citationSources?: Record<string, string>,
): { id: string; content: string } {
  if (!citationSources) return { id: 'episode document', content: document };
  const direct = citationSources[sourceRef];
  if (direct !== undefined) return { id: sourceRef, content: direct };
  const [baseRef, anchor] = sourceRef.split('#');
  if (baseRef) {
    const base = citationSources[baseRef];
    if (base !== undefined) {
      if (anchor) {
        const section = resolveMarkdownSection(base, anchor);
        if (section !== null) return { id: sourceRef, content: section };
      }
      return { id: baseRef, content: base };
    }
  }
  throw new Error(
    `Extraction result failed citation validation:\n` +
      `- citation sourceRef "${sourceRef}" does not match a registered source document`,
  );
}

function resolveMarkdownSection(markdown: string, anchor: string): string | null {
  const decodedAnchor = decodeURIComponent(anchor).toLowerCase();
  const headingPattern = /^(#{1,6})\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(markdown)) !== null) {
    const level = match[1]?.length ?? 0;
    const heading = match[2]?.trim().toLowerCase() ?? '';
    if (!heading.includes(decodedAnchor)) continue;

    let start = headingPattern.lastIndex;
    while (markdown[start] === '\r' || markdown[start] === '\n') start++;

    const nextHeadingPattern = new RegExp(`^#{1,${String(level)}}\\s+`, 'gm');
    nextHeadingPattern.lastIndex = start;
    const next = nextHeadingPattern.exec(markdown);
    const end = next?.index ?? markdown.length;
    return markdown.slice(start, end).replace(/[\r\n]+$/u, '');
  }
  return null;
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
  };
}

export function validateExtractionResult(result: ExtractionResult, existingAssertions: readonly Assertion[]): void {
  const errors: string[] = [];
  const assertionIds = new Set<string>();
  const knownIds = new Set(existingAssertions.map((a) => a.id));
  const citationIds = new Set<string>();
  const linkIds = new Set<string>();

  if (!Array.isArray(result.assertions)) errors.push('assertions must be an array');
  if (!Array.isArray(result.links)) errors.push('links must be an array');

  for (const a of result.assertions) {
    if (!nonEmpty(a.id)) errors.push('assertion.id is required');
    if (!nonEmpty(a.type)) errors.push(`assertion "${a.id}" type is required`);
    if (!nonEmpty(a.content)) errors.push(`assertion "${a.id}" content is required`);
    if (!Number.isFinite(a.confidence)) errors.push(`assertion "${a.id}" confidence must be numeric`);
    if (!Array.isArray(a.citations) || a.citations.length === 0) {
      errors.push(`assertion "${a.id}" citations must be a non-empty array`);
    } else {
      for (const c of a.citations) {
        if (!nonEmpty(c.id)) errors.push(`assertion "${a.id}" citation.id is required`);
        if (nonEmpty(c.id) && citationIds.has(c.id)) errors.push(`duplicate citation id "${c.id}"`);
        if (nonEmpty(c.id)) citationIds.add(c.id);
        if (!nonEmpty(c.sourceRef)) errors.push(`citation "${c.id}" sourceRef is required`);
        if (c.excerpt !== null && !nonEmpty(c.excerpt)) errors.push(`citation "${c.id}" excerpt is required`);
      }
    }
    if (nonEmpty(a.id)) {
      if (assertionIds.has(a.id)) errors.push(`duplicate assertion id "${a.id}"`);
      if (knownIds.has(a.id)) errors.push(`assertion id "${a.id}" already exists`);
      assertionIds.add(a.id);
    }
  }

  for (const l of result.links) {
    if (!nonEmpty(l.id)) errors.push('link.id is required');
    if (nonEmpty(l.id) && linkIds.has(l.id)) errors.push(`duplicate link id "${l.id}"`);
    if (nonEmpty(l.id)) linkIds.add(l.id);
    if (!nonEmpty(l.fromId)) errors.push(`link "${l.id}" fromId is required`);
    if (!nonEmpty(l.toId)) errors.push(`link "${l.id}" toId is required`);
    if (!nonEmpty(l.linkType)) errors.push(`link "${l.id}" linkType is required`);
    for (const endpoint of [l.fromId, l.toId]) {
      if (nonEmpty(endpoint) && !assertionIds.has(endpoint) && !knownIds.has(endpoint)) {
        errors.push(`link "${l.id}" endpoint "${endpoint}" does not reference a known assertion`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Extraction result failed validation:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseOffset(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  return Number.parseInt(value, 10);
}
