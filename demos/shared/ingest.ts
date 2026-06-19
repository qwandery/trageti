// Reference ingestion: extract and validate via LLM -> write episode/assertions/links.
// Indexing (vector embedding into sqlite-vec) is left to the caller, who knows
// whether to supply pre-computed vectors or rely on a configured EmbeddingProvider.

import type { Assertion, NewAssertionInput, NewAssertionLinkInput, NewEpisodeInput, TragetiStore } from 'trageti';
import { buildExtractionPrompt } from './prompt.js';
import { parseExtraction } from './parse.js';
import type { ExtractionProvider, ExtractionImageInput } from './providers.js';

export interface IngestOptions {
  store: TragetiStore;
  episode: NewEpisodeInput;
  document: string;
  citationSources?: Record<string, string>;
  imageSources?: Record<string, ExtractionImageInput>;
  existingAssertions?: Assertion[];
  extractor: ExtractionProvider;
  namespace: string;
  /** Replaces the default extraction prompt entirely. */
  promptOverride?: string;
  sanitizeParsedExtractionResult?: (result: ExtractionResult) => ExtractionResult;
  sanitizeExtractionResult?: (result: ExtractionResult) => ExtractionResult;
  /**
   * Total extract+validate attempts. The default (1) keeps the strict
   * single-shot behavior. The demo runtime raises this so a model that returns
   * structurally-valid-but-semantically-invalid output (e.g. out-of-bounds
   * citation offsets) is re-prompted with corrective feedback before failing.
   */
  maxValidationAttempts?: number;
  /**
   * When every attempt fails on a repairable citation problem, salvage the
   * extraction (clamp offsets, then drop unrepairable citations/assertions)
   * instead of throwing. Off by default so the primitive stays strict.
   */
  degradeCitationsOnFailure?: boolean;
  /** Surfaces re-attempt and degradation warnings without aborting the run. */
  logger?: IngestWarnLogger;
}

export interface IngestWarnLogger {
  warn(message: string): void;
}

export interface ExtractionResult {
  assertions: NewAssertionInput[];
  links: Array<NewAssertionLinkInput>;
}

/** What the model did wrong, in a form both the runner and the model can use. */
export type ExtractionValidationKind = 'parse' | 'schema' | 'citation';

/**
 * Thrown when an LLM extraction response is structurally received but fails the
 * demo's validation contract. Carries `feedback` (a model-directed correction
 * note) so the re-attempt loop can re-prompt, and `repairable` so the runtime
 * knows whether graceful citation degradation is possible.
 */
export class ExtractionValidationError extends Error {
  readonly feedback: string;
  readonly kind: ExtractionValidationKind;
  readonly repairable: boolean;

  constructor(
    message: string,
    options: { feedback: string; kind: ExtractionValidationKind; repairable?: boolean; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ExtractionValidationError';
    this.feedback = options.feedback;
    this.kind = options.kind;
    this.repairable = options.repairable ?? options.kind === 'citation';
  }
}

type CitationInput = NewAssertionInput['citations'][number];

const DEFAULT_VALIDATION_ATTEMPTS = 1;

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
    logger,
  } = options;
  const existing = existingAssertions ?? [];
  const basePrompt =
    promptOverride ??
    buildExtractionPrompt(document, existing, episode, namespace, citationSources, imageSources);
  const extractOptions = {
    episodeId: episode.id,
    responseFormat: 'json' as const,
    ...(imageSources !== undefined ? { images: imageSources } : {}),
  };
  const maxAttempts = Math.max(1, options.maxValidationAttempts ?? DEFAULT_VALIDATION_ATTEMPTS);

  let cited: ExtractionResult | undefined;
  let lastError: ExtractionValidationError | undefined;
  let lastParsed: ExtractionResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1 && lastError) {
      logger?.warn(
        `extraction for episode "${episode.id}" re-attempt ${String(attempt)}/${String(maxAttempts)}: ${lastError.feedback}`,
      );
    }
    const prompt = attempt === 1 || !lastError ? basePrompt : appendCorrectiveFeedback(basePrompt, lastError.feedback);
    const raw = await extractor.extract(prompt, extractOptions);

    let parsed: ExtractionResult;
    try {
      const result = parseExtractionForEpisode(raw, episode.id);
      parsed = options.sanitizeParsedExtractionResult?.(result) ?? result;
    } catch (err) {
      if (err instanceof ExtractionValidationError) {
        lastError = err;
        lastParsed = undefined;
        continue;
      }
      throw err;
    }

    try {
      const resolved = resolveCitationExcerpts(parsed, document, citationSources, imageSources);
      const candidate = options.sanitizeExtractionResult?.(resolved) ?? resolved;
      validateExtractionResult(candidate, existing);
      cited = candidate;
      lastError = undefined;
      break;
    } catch (err) {
      if (err instanceof ExtractionValidationError) {
        lastError = err;
        lastParsed = parsed;
        continue;
      }
      throw err;
    }
  }

  if (cited === undefined) {
    if (options.degradeCitationsOnFailure && lastError?.repairable && lastParsed) {
      cited = degradeCitations(lastParsed, {
        episode,
        document,
        existing,
        ...(options.sanitizeExtractionResult ? { sanitize: options.sanitizeExtractionResult } : {}),
        ...(logger ? { logger } : {}),
        ...(citationSources !== undefined ? { citationSources } : {}),
        ...(imageSources !== undefined ? { imageSources } : {}),
      });
    } else {
      throw lastError ?? new Error(`Extraction for episode "${episode.id}" produced no result`);
    }
  }

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

function appendCorrectiveFeedback(basePrompt: string, feedback: string): string {
  return (
    `${basePrompt}\n\n` +
    `---\n` +
    `CORRECTION REQUIRED. Your previous response was rejected by validation:\n` +
    `${feedback}\n` +
    `Return a corrected JSON object that fixes this. Every citation must set "excerpt" to null and ` +
    `provide integer "excerptStart"/"excerptEnd" offsets satisfying ` +
    `0 <= excerptStart < excerptEnd <= (source length) that select non-empty source text.`
  );
}

function parseExtractionForEpisode(raw: string, episodeId: string): ExtractionResult {
  try {
    return parseExtraction(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExtractionValidationError(
      `Extraction failed for episode "${episodeId}": provider returned text that does not match the required JSON extraction schema.\n` +
        `${message}\n` +
        'Use --llm-trace=full to inspect the streamed response frames, or switch to a model/provider that follows JSON object responses.',
      {
        kind: 'parse',
        feedback: `Your previous response was not a valid JSON extraction object (${message}). Respond with ONLY a single JSON object matching the required schema.`,
        cause: err,
      },
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
        ? a.citations.map((c) => resolveOneCitation(c, document, citationSources, imageSources))
        : a.citations,
    })),
    links: result.links,
  };
}

/** Resolve a single citation's excerpt, throwing ExtractionValidationError on any problem. */
function resolveOneCitation(
  c: CitationInput,
  document: string,
  citationSources?: Record<string, string>,
  imageSources?: Record<string, ExtractionImageInput>,
): CitationInput {
  if (c.excerpt !== null && c.excerpt !== undefined) {
    throw new ExtractionValidationError(
      `Extraction result failed citation validation:\n` +
        `- citation "${c.id}" supplied excerpt text directly; provide excerptStart/excerptEnd and set excerpt to null`,
      {
        kind: 'citation',
        feedback: `Citation "${c.id}" supplied excerpt text directly; set "excerpt" to null and provide integer excerptStart/excerptEnd offsets instead.`,
      },
    );
  }
  if (isImageCitation(c.sourceRef, imageSources)) {
    const imageCitation = { ...c, excerpt: c.excerpt ?? null };
    if (c.excerptStart !== undefined) imageCitation.excerptStart = c.excerptStart;
    if (c.excerptEnd !== undefined) imageCitation.excerptEnd = c.excerptEnd;
    return imageCitation;
  }
  const source = resolveCitationSource(c.sourceRef, document, citationSources);
  const start = parseOffset(c.excerptStart);
  const end = parseOffset(c.excerptEnd);
  if (start === null || end === null || start < 0 || end <= start || end > source.content.length) {
    throw new ExtractionValidationError(
      `Extraction result failed citation validation:\n` +
        `- citation "${c.id}" has invalid excerptStart/excerptEnd offsets for source "${source.id}" length ${String(source.content.length)}`,
      {
        kind: 'citation',
        feedback:
          `Citation "${c.id}" offsets (excerptStart=${String(c.excerptStart)}, excerptEnd=${String(c.excerptEnd)}) ` +
          `are invalid for source "${source.id}"; they must be integers satisfying ` +
          `0 <= excerptStart < excerptEnd <= ${String(source.content.length)}.`,
      },
    );
  }
  const excerpt = source.content.slice(start, end);
  if (excerpt.trim().length === 0) {
    throw new ExtractionValidationError(
      `Extraction result failed citation validation:\n` + `- citation "${c.id}" offsets resolve to empty source text`,
      {
        kind: 'citation',
        feedback: `Citation "${c.id}" offsets select only whitespace; choose offsets that span non-empty source text.`,
      },
    );
  }
  return { ...c, excerpt, excerptStart: String(start), excerptEnd: String(end) };
}

/**
 * Best-effort salvage of a single citation after re-attempts are exhausted:
 * clamp offsets to a valid, non-empty slice. Returns null when the citation
 * cannot be repaired (unknown source, excerpt supplied directly, no non-empty
 * slice), signalling the caller to drop it.
 */
function repairCitation(
  c: CitationInput,
  document: string,
  citationSources?: Record<string, string>,
  imageSources?: Record<string, ExtractionImageInput>,
): CitationInput | null {
  if (isImageCitation(c.sourceRef, imageSources)) return c;
  if (c.excerpt !== null && c.excerpt !== undefined) return null;
  let source: { id: string; content: string };
  try {
    source = resolveCitationSource(c.sourceRef, document, citationSources);
  } catch {
    return null;
  }
  const len = source.content.length;
  if (len === 0) return null;
  let start = parseOffset(c.excerptStart) ?? 0;
  let end = parseOffset(c.excerptEnd) ?? len;
  start = Math.max(0, Math.min(start, len - 1));
  end = Math.max(start + 1, Math.min(end, len));
  if (end <= start || end > len) return null;
  const excerpt = source.content.slice(start, end);
  if (excerpt.trim().length === 0) return null;
  return { ...c, excerpt, excerptStart: String(start), excerptEnd: String(end) };
}

interface DegradeContext {
  episode: NewEpisodeInput;
  document: string;
  existing: readonly Assertion[];
  citationSources?: Record<string, string>;
  imageSources?: Record<string, ExtractionImageInput>;
  sanitize?: (result: ExtractionResult) => ExtractionResult;
  logger?: IngestWarnLogger;
}

/**
 * Repair-then-drop degradation: clamp salvageable citations, drop the rest, drop
 * assertions left with no citations, and drop links whose endpoints disappeared.
 * The returned result is re-validated by the caller so the invariant "every
 * stored assertion is backed by a real excerpt" still holds.
 */
function degradeCitations(parsed: ExtractionResult, ctx: DegradeContext): ExtractionResult {
  let repaired = 0;
  let droppedCitations = 0;
  let droppedAssertions = 0;

  const assertions: NewAssertionInput[] = [];
  for (const a of parsed.assertions) {
    if (!Array.isArray(a.citations)) {
      assertions.push(a);
      continue;
    }
    const kept: CitationInput[] = [];
    for (const c of a.citations) {
      try {
        kept.push(resolveOneCitation(c, ctx.document, ctx.citationSources, ctx.imageSources));
      } catch (err) {
        if (!(err instanceof ExtractionValidationError)) throw err;
        const fixed = repairCitation(c, ctx.document, ctx.citationSources, ctx.imageSources);
        if (fixed) {
          kept.push(fixed);
          repaired += 1;
          ctx.logger?.warn(
            `repaired citation "${c.id}" for episode "${ctx.episode.id}": clamped offsets to ${String(
              fixed.excerptStart,
            )}..${String(fixed.excerptEnd)}`,
          );
        } else {
          droppedCitations += 1;
          ctx.logger?.warn(`dropped citation "${c.id}" for episode "${ctx.episode.id}": ${err.feedback}`);
        }
      }
    }
    if (kept.length === 0) {
      droppedAssertions += 1;
      ctx.logger?.warn(
        `dropped assertion "${a.id}" for episode "${ctx.episode.id}": no citations could be salvaged`,
      );
      continue;
    }
    assertions.push({ ...a, citations: kept });
  }

  const knownIds = new Set<string>([...ctx.existing.map((x) => x.id), ...assertions.map((x) => x.id)]);
  const links = parsed.links.filter((l) => {
    const ok = knownIds.has(l.fromId) && knownIds.has(l.toId);
    if (!ok) ctx.logger?.warn(`dropped link "${l.id}" for episode "${ctx.episode.id}": endpoint assertion was dropped`);
    return ok;
  });

  ctx.logger?.warn(
    `degraded extraction for episode "${ctx.episode.id}": repaired ${String(repaired)}, dropped ${String(
      droppedCitations,
    )} citation(s), dropped ${String(droppedAssertions)} assertion(s), dropped ${String(
      parsed.links.length - links.length,
    )} link(s)`,
  );

  const degraded: ExtractionResult = { assertions, links };
  const sanitized = ctx.sanitize?.(degraded) ?? degraded;
  validateExtractionResult(sanitized, ctx.existing);
  return sanitized;
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
  throw new ExtractionValidationError(
    `Extraction result failed citation validation:\n` +
      `- citation sourceRef "${sourceRef}" does not match a registered source document`,
    {
      kind: 'citation',
      feedback: `Citation sourceRef "${sourceRef}" is not a registered source document; use one of the provided source refs.`,
    },
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
  episode: NewEpisodeInput,
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
    const detail = errors.map((e) => `- ${e}`).join('\n');
    throw new ExtractionValidationError(`Extraction result failed validation:\n${detail}`, {
      kind: 'schema',
      feedback: `Your previous response failed schema validation:\n${detail}\nFix every listed problem and return corrected JSON.`,
    });
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
