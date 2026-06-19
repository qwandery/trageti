import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { TragetiStore, type Assertion, type Episode, type NewEpisodeInput } from 'trageti';
import type { PreparedIngestionUnit } from './artifacts.js';
import { ingest, type ExtractionResult } from './ingest.js';
import { parseExtraction } from './parse.js';
import { buildExtractionPrompt } from './prompt.js';
import type { LlmTraceOptions, ResolvedDemoProviders } from './providers.js';
import { sanitizeForTerminal } from './sanitize.js';

export interface DemoRunLogger {
  step(message: string): void;
  detail(message: string): void;
  success(message: string): void;
  warn(message: string): void;
}

interface RuntimeSanitizerContext {
  episode: NewEpisodeInput;
  existingAssertions: readonly Assertion[];
  citationSources: Record<string, string>;
}

export function runtimeDbPath(demoName: string): string {
  const path = join('demos', '.local', `${demoName}.db`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function demoDataVersion(
  demoName: string,
  episodes: readonly NewEpisodeInput[],
  fixtures: Record<string, string>,
  assertionEmbeddings: Record<string, number[]>,
  queryEmbeddings: Record<string, number[]>,
  queryTexts: readonly string[],
): string {
  // assertionEmbeddings and queryEmbeddings are always hashed even in live-embed mode.
  // Changing committed vectors forces a DB rebuild that is conservative for demos.
  const payload = {
    demoName,
    episodes: episodes.map((e) => ({
      id: e.id,
      namespace: e.namespace,
      position: e.position,
      type: e.type,
      content: e.content,
      occurredAt: e.occurredAt,
    })),
    fixtures: sortRecordByKey(fixtures),
    assertionEmbeddings: sortRecordByKey(assertionEmbeddings),
    queryEmbeddings: sortRecordByKey(queryEmbeddings),
    queryTexts,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function sortRecordByKey<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

export function ensureDemoMetadata(options: {
  database: string;
  demoName: string;
  dataVersion: string;
  providers: ResolvedDemoProviders;
  logger?: DemoRunLogger;
}): void {
  options.logger?.step('Checking demo database provenance');
  options.logger?.detail(`Database path: ${options.database}`);
  options.logger?.detail(`Demo data version: ${options.dataVersion}`);
  options.logger?.detail(
    `Extraction: ${options.providers.provenance.extraction.kind} (${options.providers.extractor.label})`,
  );
  options.logger?.detail(
    `Embedding: ${options.providers.provenance.embedding.kind} (${options.providers.embedder.label})`,
  );
  const db = new Database(options.database);
  try {
    db.prepare(
      `CREATE TABLE IF NOT EXISTS demo_run_metadata (
        demo_name TEXT PRIMARY KEY,
        data_version TEXT NOT NULL,
        extraction_hash TEXT NOT NULL,
        embedding_hash TEXT NOT NULL,
        embedding_dimension INTEGER NOT NULL,
        mode TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    ).run();
    const expected = {
      demo_name: options.demoName,
      data_version: options.dataVersion,
      extraction_hash: options.providers.provenance.extraction.configHash,
      embedding_hash: options.providers.provenance.embedding.configHash,
      embedding_dimension: options.providers.provenance.embedding.dimension ?? 0,
      mode: options.providers.isLive ? 'live' : 'fixture',
    };
    const existing = db
      .prepare<
        [string],
        typeof expected
      >('SELECT demo_name, data_version, extraction_hash, embedding_hash, embedding_dimension, mode FROM demo_run_metadata WHERE demo_name = ?')
      .get(options.demoName);
    if (existing) {
      const mismatches = Object.entries(expected).filter(
        ([key, value]) => existing[key as keyof typeof expected] !== value,
      );
      if (mismatches.length > 0) {
        throw new Error(
          `Demo database "${options.database}" was built with different provider/data provenance.\n` +
            'Delete the demo DB or choose a different DB path before re-running.',
        );
      }
      options.logger?.success('Existing DB provenance matches this run');
      return;
    }
    db.prepare(
      `INSERT INTO demo_run_metadata
        (demo_name, data_version, extraction_hash, embedding_hash, embedding_dimension, mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      expected.demo_name,
      expected.data_version,
      expected.extraction_hash,
      expected.embedding_hash,
      expected.embedding_dimension,
      expected.mode,
      new Date().toISOString(),
    );
    options.logger?.success('Recorded DB provenance for this run');
  } finally {
    db.close();
  }
}

export async function prepareDemoStore(options: {
  database: string;
  demoName: string;
  dataVersion: string;
  namespace: string;
  providers: ResolvedDemoProviders;
  logger?: DemoRunLogger;
}): Promise<TragetiStore> {
  const metadataOptions = {
    database: options.database,
    demoName: options.demoName,
    dataVersion: options.dataVersion,
    providers: options.providers,
  };
  ensureDemoMetadata(options.logger ? { ...metadataOptions, logger: options.logger } : metadataOptions);

  options.logger?.step('Opening TragetiStore');
  const store = await TragetiStore.create({
    database: options.database,
    namespace: options.namespace,
    embeddingDimension: options.providers.embedder.provider.dimension,
    embeddingProvider: options.providers.embedder.provider,
  });
  options.logger?.success('TragetiStore is ready');
  return store;
}

export async function ingestEpisodes(options: {
  store: TragetiStore;
  namespace: string;
  episodes: readonly NewEpisodeInput[];
  citationSources?: Record<string, string>;
  providers: ResolvedDemoProviders;
  expectedFixtureAssertionIds?: readonly string[];
  sanitizeParsedExtractionResult?: (result: ExtractionResult, context: RuntimeSanitizerContext) => ExtractionResult;
  sanitizeExtractionResult?: (result: ExtractionResult, context: RuntimeSanitizerContext) => ExtractionResult;
  logger?: DemoRunLogger;
  trace?: LlmTraceOptions;
}): Promise<void> {
  const units = options.episodes.map((episode) => ({
    id: episode.id,
    episode,
    document: episode.content,
    citationSources: options.citationSources ? { ...options.citationSources } : {},
  }));
  await ingestPreparedUnits({
    ...options,
    units,
  });
}

export async function ingestPreparedUnits(options: {
  store: TragetiStore;
  namespace: string;
  units: readonly PreparedIngestionUnit[];
  providers: ResolvedDemoProviders;
  expectedFixtureAssertionIds?: readonly string[];
  sanitizeParsedExtractionResult?: (result: ExtractionResult, context: RuntimeSanitizerContext) => ExtractionResult;
  sanitizeExtractionResult?: (result: ExtractionResult, context: RuntimeSanitizerContext) => ExtractionResult;
  logger?: DemoRunLogger;
  trace?: LlmTraceOptions;
  artifactPath?: string;
  /** Total extract+validate attempts per episode. Defaults from env (2). */
  maxValidationAttempts?: number;
  /** Salvage repairable citation failures instead of aborting. Defaults true. */
  degradeCitationsOnFailure?: boolean;
}): Promise<void> {
  const maxValidationAttempts = options.maxValidationAttempts ?? validationAttemptsFromEnv();
  const degradeCitationsOnFailure = options.degradeCitationsOnFailure ?? true;
  options.logger?.step('Ingesting episodes into TragetiStore');
  if (options.artifactPath) options.logger?.detail(`Prepared artifact: ${options.artifactPath}`);
  options.logger?.detail(
    'Prepared ingestion units are converted into assertions and typed links, stored in SQLite, then assertion text is embedded for vector retrieval.',
  );
  const accumulated: Assertion[] = [];
  for (const unit of options.units) {
    const episode = unit.episode;
    const existing = await options.store.getEpisode(episode.id);
    if (existing !== null) {
      validateExistingEpisode(existing, episode);
      options.logger?.detail(formatEpisode(episode));
      await reloadAccumulated(options.store, options.namespace, accumulated);
      const existingAssertions = accumulated.filter((a) => a.sourceEpisodeId === episode.id);
      if (existingAssertions.length === 0) {
        throw new Error(
          `Demo database is partial: episode "${episode.id}" exists but has no assertions.\n` +
            'Delete this run-specific demo DB and re-run.',
        );
      }
      options.logger?.detail(
        `  Reused ${formatCount(existingAssertions.length, 'stored claim')} from SQLite after validating the episode metadata.`,
      );
      if (existingAssertions.length > 0) {
        options.logger?.detail('  Stored claims:');
        for (const claim of formatExistingClaimSummary(existingAssertions)) {
          options.logger?.detail(`    - ${claim}`);
        }
      }
      continue;
    }
    traceLog(
      options.trace,
      `Prepared unit -> ${unit.id}: ${String(unit.document.length)} document char(s), ` +
        `${String(Object.keys(unit.citationSources).length)} citation source(s), responseFormat=json`,
    );
    const sourceRefs = Object.keys(unit.citationSources);
    const imageRefs = Object.keys(unit.imageSources ?? {});
    const promptSize = buildExtractionPrompt(
      unit.document,
      accumulated,
      episode,
      options.namespace,
      sourceRefs.length > 0 ? unit.citationSources : undefined,
      unit.imageSources,
    ).length;
    options.logger?.detail(
      `  Extracting ${unit.id}: ${episode.type} position ${String(episode.position)} via ${
        options.providers.extractor.label
      } (json, prompt ~${String(promptSize)} chars)`,
    );
    options.logger?.detail(`    Document: "${truncate(sanitizeForTerminal(unit.document), 120)}"`);
    options.logger?.detail(`    Source refs: ${sourceRefs.length > 0 ? sourceRefs.join(', ') : 'episode document'}`);
    if (imageRefs.length > 0) options.logger?.detail(`    Image refs: ${imageRefs.join(', ')}`);
    const extractionStarted = performance.now();
    const ingestOptions = {
      store: options.store,
      namespace: options.namespace,
      episode,
      document: unit.document,
      existingAssertions: accumulated,
      extractor: options.providers.extractor,
      maxValidationAttempts,
      degradeCitationsOnFailure,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(Object.keys(unit.citationSources).length > 0 ? { citationSources: unit.citationSources } : {}),
      ...(unit.imageSources !== undefined && Object.keys(unit.imageSources).length > 0
        ? { imageSources: unit.imageSources }
        : {}),
      ...(options.sanitizeParsedExtractionResult !== undefined && {
        sanitizeParsedExtractionResult: (result: ExtractionResult) =>
          options.sanitizeParsedExtractionResult?.(result, {
            episode,
            existingAssertions: accumulated,
            citationSources: unit.citationSources,
          }) ?? result,
      }),
      ...(options.sanitizeExtractionResult !== undefined && {
        sanitizeExtractionResult: (result: ExtractionResult) =>
          options.sanitizeExtractionResult?.(result, {
            episode,
            existingAssertions: accumulated,
            citationSources: unit.citationSources,
          }) ?? result,
      }),
    };
    let result: ExtractionResult;
    try {
      result = await ingest(ingestOptions);
    } catch (err) {
      throw extractionFailureError(err, {
        unit,
        episode,
        providerLabel: options.providers.extractor.label,
        sourceRefs,
        elapsedMs: performance.now() - extractionStarted,
      });
    }
    options.logger?.detail(
      `    Extraction complete: ${formatCount(result.assertions.length, 'claim')}, ${formatLinkSummary(
        result.links,
      )} (${(performance.now() - extractionStarted).toFixed(1)} ms)`,
    );
    await indexResult(options.store, result, {
      episode,
      providerLabel: options.providers.embedder.label,
      embeddingDimension: options.providers.provenance.embedding.dimension,
      trace: options.trace,
    });
    options.logger?.detail(formatEpisode(episode));
    options.logger?.detail(
      `  Stored ${formatCount(result.assertions.length, 'claim')}; ` +
        `${formatLinkSummary(result.links)}; indexed ${formatCount(result.assertions.length, 'vector')}.`,
    );
    options.logger?.detail('  Main claims:');
    for (const claim of formatClaimSummary(result.assertions)) {
      options.logger?.detail(`    - ${claim}`);
    }
    await reloadAccumulated(options.store, options.namespace, accumulated);
  }
  await verifyComplete(options);
  options.logger?.success('Ingestion and indexing checks passed');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + '...';
}

const DEFAULT_VALIDATION_ATTEMPTS = 2;

function validationAttemptsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['DEMO_EXTRACT_VALIDATION_MAX_ATTEMPTS'];
  if (raw === undefined) return DEFAULT_VALIDATION_ATTEMPTS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_VALIDATION_ATTEMPTS;
}

function extractionFailureError(
  err: unknown,
  context: {
    unit: PreparedIngestionUnit;
    episode: NewEpisodeInput;
    providerLabel: string;
    sourceRefs: readonly string[];
    elapsedMs: number;
  },
): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(
    `Extraction failed for prepared unit "${context.unit.id}" / episode "${context.episode.id}" after ${context.elapsedMs.toFixed(
      1,
    )} ms.\n` +
      `Provider: ${context.providerLabel}; responseFormat=json.\n` +
      `Episode: ${context.episode.type} position ${String(context.episode.position)}.\n` +
      `Document: "${truncate(sanitizeForTerminal(context.unit.document), 160)}"\n` +
      `Source refs: ${context.sourceRefs.length > 0 ? context.sourceRefs.join(', ') : 'episode document'}\n` +
      `Cause: ${message}`,
    { cause: err },
  );
}

function formatEpisode(episode: NewEpisodeInput): string {
  return `${formatDateTime(episode.occurredAt)} - ${episode.type} episode, sequence ${String(episode.position)}`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(value));
}

function formatClaimSummary(assertions: readonly ExtractionResult['assertions'][number][]): string[] {
  if (assertions.length === 0) return ['none'];
  const shown = assertions.slice(0, 3).map((a) => truncate(sanitizeForTerminal(a.content), 72));
  if (assertions.length > shown.length) shown.push(`+${String(assertions.length - shown.length)} more stored claim(s)`);
  return shown;
}

function formatExistingClaimSummary(assertions: readonly Assertion[]): string[] {
  if (assertions.length === 0) return ['none'];
  const shown = assertions.slice(0, 3).map((a) => truncate(sanitizeForTerminal(a.content), 72));
  if (assertions.length > shown.length) shown.push(`+${String(assertions.length - shown.length)} more stored claim(s)`);
  return shown;
}

function formatLinkSummary(links: readonly ExtractionResult['links'][number][]): string {
  if (links.length === 0) return 'no links';
  const byType = new Map<string, number>();
  for (const link of links) byType.set(link.linkType, (byType.get(link.linkType) ?? 0) + 1);
  return [...byType.entries()].map(([type, count]) => formatCount(count, type + ' link')).join(', ');
}

function formatCount(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

export function expectedFixtureAssertionIds(fixtures: Record<string, string>): string[] {
  return Object.keys(fixtures)
    .flatMap((key) => parseExtraction(fixtures[key] ?? '{"assertions":[],"links":[]}').assertions.map((a) => a.id))
    .sort();
}

async function indexResult(
  store: TragetiStore,
  result: ExtractionResult,
  context: {
    episode: NewEpisodeInput;
    providerLabel: string;
    embeddingDimension: number | undefined;
    trace: LlmTraceOptions | undefined;
  },
): Promise<void> {
  const started = performance.now();
  traceLog(
    context.trace,
    `Embedding/indexing start -> ${context.episode.id}: ${String(result.assertions.length)} assertion(s), ` +
      `${context.providerLabel}, dimension ${String(context.embeddingDimension ?? 'unknown')}`,
  );
  const ib = await store.indexBatch(
    result.assertions.map((a) => ({ assertionId: a.id })),
    { onProviderError: 'skip' },
  );
  traceLog(
    context.trace,
    `Embedding/indexing complete <- ${context.episode.id}: indexed ${String(ib.indexed)}, skipped ${String(
      ib.skipped.length,
    )} (${(performance.now() - started).toFixed(1)} ms)`,
  );
  if (ib.skipped.length > 0) {
    const reason = ib.skipped[0]?.reason ?? 'UNKNOWN';
    throw new Error(`indexBatch skipped ${String(ib.skipped.length)} assertion(s): ${reason}`);
  }
}

function validateExistingEpisode(existing: Episode, expected: NewEpisodeInput): void {
  if (
    existing.namespace !== expected.namespace ||
    existing.position !== expected.position ||
    existing.type !== expected.type
  ) {
    throw new Error(
      `Existing episode "${expected.id}" does not match committed demo data. ` +
        'Delete the demo DB or use a different DB path.',
    );
  }
}

async function reloadAccumulated(store: TragetiStore, namespace: string, target: Assertion[]): Promise<void> {
  target.length = 0;
  target.push(...(await store.getAssertions(namespace, { includeSuperseded: true })));
}

async function verifyComplete(options: {
  store: TragetiStore;
  namespace: string;
  episodes?: readonly NewEpisodeInput[];
  units?: readonly PreparedIngestionUnit[];
  providers: ResolvedDemoProviders;
  expectedFixtureAssertionIds?: readonly string[];
  logger?: DemoRunLogger;
  trace?: LlmTraceOptions;
}): Promise<void> {
  options.logger?.step('Verifying demo DB completeness');
  const episodes = options.episodes ?? options.units?.map((unit) => unit.episode) ?? [];
  const assertions = await options.store.getAssertions(options.namespace, { includeSuperseded: true });
  const byEpisode = new Map<string, number>();
  for (const a of assertions) byEpisode.set(a.sourceEpisodeId, (byEpisode.get(a.sourceEpisodeId) ?? 0) + 1);
  const missingEpisodes = episodes.filter((e) => (byEpisode.get(e.id) ?? 0) === 0);
  if (missingEpisodes.length > 0) {
    throw new Error(
      `Demo database is partial: missing assertions for ${missingEpisodes.map((e) => e.id).join(', ')}.\n` +
        'Delete the demo DB and re-run.',
    );
  }

  const pending = await options.store.getPendingIndexing(options.namespace);
  if (pending.length > 0) {
    options.logger?.detail(`Re-indexing ${String(pending.length)} assertion(s) missing embeddings from a prior run`);
    const started = performance.now();
    traceLog(
      options.trace,
      `Pending embedding retry start -> ${String(pending.length)} assertion(s), ${options.providers.embedder.label}, ` +
        `dimension ${String(options.providers.provenance.embedding.dimension ?? 'unknown')}`,
    );
    const ib = await options.store.indexBatch(
      pending.map((row) => ({ assertionId: row.id })),
      { onProviderError: 'skip' },
    );
    traceLog(
      options.trace,
      `Pending embedding retry complete <- indexed ${String(ib.indexed)}, skipped ${String(ib.skipped.length)} (${(
        performance.now() - started
      ).toFixed(1)} ms)`,
    );
    if (ib.skipped.length > 0) {
      const reason = ib.skipped[0]?.reason ?? 'UNKNOWN';
      throw new Error(
        `Demo database is partial: ${String(ib.skipped.length)} assertion(s) still missing embeddings after retry (${reason}).\n` +
          'Re-run after the embedding provider is available or delete this run-specific demo DB.',
      );
    }
  }

  if (options.expectedFixtureAssertionIds) {
    const actual = assertions.map((a) => a.id).sort();
    const expected = [...options.expectedFixtureAssertionIds].sort();
    if (actual.join('\n') !== expected.join('\n')) {
      throw new Error(
        'Fixture demo database assertion IDs do not match committed fixture data.\n' + 'Delete the demo DB and re-run.',
      );
    }
    options.logger?.detail('Fixture assertion IDs match committed fixture data');
  }
  options.logger?.detail(
    `Verified ${String(episodes.length)} episode(s), ${String(assertions.length)} assertion(s), 0 pending embedding(s)`,
  );
}

function traceLog(trace: LlmTraceOptions | undefined, message: string): void {
  if (trace?.enabled) trace.log(message);
}
