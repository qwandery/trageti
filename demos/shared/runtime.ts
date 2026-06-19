import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { TragetiStore, type Assertion, type EmbeddingProvider, type Episode, type NewEpisodeInput } from 'trageti';
import type { PreparedIngestionUnit } from './artifacts.js';
import { extractIngestionResult, type ExtractionResult } from './ingest.js';
import { parseExtraction } from './parse.js';
import { buildExtractionPrompt } from './prompt.js';
import type { LlmTraceOptions, ResolvedDemoProviders } from './providers.js';
import { sanitizeForTerminal } from './sanitize.js';
import { atomicWriteJson, hashFile, hashJson, hashText, readJsonOrNull } from './state.js';

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

type UnitStatus = 'extracted' | 'stored' | 'complete';

interface UnitContract {
  unitHash: string;
  assertionIds: string[];
  citationIds: string[];
  linkIds: string[];
}

interface UnitManifest {
  status: UnitStatus;
  extractionHash: string;
  expected: UnitContract;
}

interface DemoRunManifest {
  version: 1;
  demoName: string;
  runKey: string;
  dataVersion: string;
  providerHash: string;
  artifactPath?: string;
  database: string;
  units: Record<string, UnitManifest>;
  createdAt: string;
  updatedAt: string;
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

export function validateDemoMetadata(options: {
  database: string;
  demoName: string;
  dataVersion: string;
  providers: ResolvedDemoProviders;
}): void {
  const db = new Database(options.database, { readonly: true });
  try {
    const table = db
      .prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('demo_run_metadata');
    if (!table) throw new Error(`Demo database "${options.database}" has no demo_run_metadata table.`);
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
    if (!existing) throw new Error(`Demo database "${options.database}" has no metadata row for ${options.demoName}.`);
    const mismatches = Object.entries(expected).filter(([key, value]) => existing[key as keyof typeof expected] !== value);
    if (mismatches.length > 0) {
      throw new Error(`Demo database "${options.database}" was built with different provider/data provenance.`);
    }
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
    embeddingProvider: cachedEmbeddingProvider(options),
  });
  options.logger?.success('TragetiStore is ready');
  return store;
}

function cachedEmbeddingProvider(options: {
  demoName: string;
  dataVersion: string;
  providers: ResolvedDemoProviders;
}): EmbeddingProvider {
  const provider = options.providers.embedder.provider;
  if (options.providers.embedder.provenance.kind === 'fixture') return provider;
  return {
    name: provider.name,
    dimension: provider.dimension,
    async embed(texts, embedOptions) {
      const vectors: Array<Float32Array | null> = texts.map((text) =>
        readCachedEmbedding({
          demoName: options.demoName,
          dataVersion: options.dataVersion,
          provenance: options.providers.embedder.provenance,
          purpose: embedOptions?.purpose,
          text,
        }),
      );
      const missing = texts
        .map((text, index) => ({ text, index }))
        .filter(({ index }) => vectors[index] === null);
      if (missing.length > 0) {
        const computed = await provider.embed(
          missing.map((item) => item.text),
          embedOptions,
        );
        for (let i = 0; i < missing.length; i++) {
          const item = missing[i];
          const vector = computed[i];
          if (!item || !vector) continue;
          vectors[item.index] = vector;
          writeCachedEmbedding({
            demoName: options.demoName,
            dataVersion: options.dataVersion,
            provenance: options.providers.embedder.provenance,
            purpose: embedOptions?.purpose,
            text: item.text,
            vector,
          });
        }
      }
      return vectors.map((vector) => {
        if (vector === null) throw new Error('embedding cache/provider returned no vector');
        return vector;
      });
    },
  };
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
  demoName?: string;
  dataVersion?: string;
  database?: string;
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
  const manifest =
    options.demoName && options.dataVersion && options.database
      ? loadRunManifest({
          demoName: options.demoName,
          dataVersion: options.dataVersion,
          providers: options.providers,
          ...(options.artifactPath ? { artifactPath: options.artifactPath } : {}),
          database: options.database,
        })
      : null;
  for (const unit of options.units) {
    const episode = unit.episode;
    const existing = await options.store.getEpisode(episode.id);
    if (existing !== null) {
      validateExistingEpisode(existing, episode);
      const contract = manifest?.units[unit.id];
      if (manifest !== null && contract?.expected) {
        const match = await unitMatchesContract(options.store, options.namespace, episode, contract.expected);
        if (!match.ok) {
          throw new Error(`Demo database diverges from run manifest for unit "${unit.id}": ${match.reason}`);
        }
        const missing = await missingExpectedIndexing(options.store, options.namespace, contract.expected.assertionIds);
        if (missing.length === 0) {
          contract.status = 'complete';
          writeRunManifest(manifest);
          options.logger?.detail(formatEpisode(episode));
          await reloadAccumulated(options.store, options.namespace, accumulated);
          const existingAssertions = accumulated.filter((a) => a.sourceEpisodeId === episode.id);
          options.logger?.detail(
            `  Reused complete checkpoint with ${formatCount(existingAssertions.length, 'stored claim')}.`,
          );
          continue;
        }
        options.logger?.detail(formatEpisode(episode));
        options.logger?.detail(`  Resuming indexing for ${String(missing.length)} stored claim(s).`);
        await indexExpectedAssertions(
          options.store,
          missing.map((row) => row.id),
          {
            episode,
            providerLabel: options.providers.embedder.label,
            embeddingDimension: options.providers.provenance.embedding.dimension,
            trace: options.trace,
          },
        );
        contract.status = 'complete';
        writeRunManifest(manifest);
        await reloadAccumulated(options.store, options.namespace, accumulated);
        continue;
      }
      if (manifest !== null) {
        throw new Error(
          `Demo database has episode "${episode.id}" but no checkpoint contract for unit "${unit.id}".\n` +
            'This run cannot safely infer whether the unit is complete; move the DB aside or change run inputs.',
        );
      }
      options.logger?.detail(formatEpisode(episode));
      await reloadAccumulated(options.store, options.namespace, accumulated);
      const existingAssertions = accumulated.filter((a) => a.sourceEpisodeId === episode.id);
      if (existingAssertions.length === 0) {
        throw new Error(`Demo database is partial: episode "${episode.id}" exists but has no assertions.`);
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
    const prompt = buildExtractionPrompt(
      unit.document,
      accumulated,
      episode,
      options.namespace,
      sourceRefs.length > 0 ? unit.citationSources : undefined,
      unit.imageSources,
    );
    const promptSize = prompt.length;
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
    const cached = readCachedExtraction({
      demoName: options.demoName,
      dataVersion: options.dataVersion,
      providers: options.providers,
      unit,
      prompt,
    });
    try {
      result =
        cached ??
        (await extractIngestionResult({
          ...ingestOptions,
          promptOverride: prompt,
        }));
    } catch (err) {
      throw extractionFailureError(err, {
        unit,
        episode,
        providerLabel: options.providers.extractor.label,
        sourceRefs,
        elapsedMs: performance.now() - extractionStarted,
      });
    }
    const expected = expectedContract(episode, result);
    const extractionHash = hashJson({ episode, result });
    if (manifest !== null) {
      manifest.units[unit.id] = { status: 'extracted', extractionHash, expected };
      writeRunManifest(manifest);
    }
    if (cached === null) {
      writeCachedExtraction({
        demoName: options.demoName,
        dataVersion: options.dataVersion,
        providers: options.providers,
        unit,
        prompt,
        result,
      });
    }
    options.logger?.detail(
      `    Extraction complete: ${formatCount(result.assertions.length, 'claim')}, ${formatLinkSummary(
        result.links,
      )} (${(performance.now() - extractionStarted).toFixed(1)} ms)`,
    );
    await writeResultBundle(options.store, episode, result);
    if (manifest !== null) {
      manifest.units[unit.id] = { status: 'stored', extractionHash, expected };
      writeRunManifest(manifest);
    }
    await indexExpectedAssertions(options.store, result.assertions.map((a) => a.id), {
      episode,
      providerLabel: options.providers.embedder.label,
      embeddingDimension: options.providers.provenance.embedding.dimension,
      trace: options.trace,
    });
    if (manifest !== null) {
      manifest.units[unit.id] = { status: 'complete', extractionHash, expected };
      writeRunManifest(manifest);
    }
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

function loadRunManifest(options: {
  demoName: string;
  dataVersion: string;
  providers: ResolvedDemoProviders;
  artifactPath?: string;
  database: string;
}): DemoRunManifest {
  const providerHash = hashJson(options.providers.provenance).slice(0, 16);
  const runKey = hashJson({
    demoName: options.demoName,
    dataVersion: options.dataVersion,
    providerHash,
    database: options.database,
  }).slice(0, 16);
  const path = runManifestPath(options.demoName, runKey);
  const existing = readJsonOrNull(path, (value, readPath) => validateRunManifest(value, readPath));
  if (existing !== null) return existing;
  const now = new Date().toISOString();
  const created: DemoRunManifest = {
    version: 1,
    demoName: options.demoName,
    runKey,
    dataVersion: options.dataVersion,
    providerHash,
    ...(options.artifactPath ? { artifactPath: options.artifactPath } : {}),
    database: options.database,
    units: {},
    createdAt: now,
    updatedAt: now,
  };
  writeRunManifest(created);
  return created;
}

function writeRunManifest(manifest: DemoRunManifest): void {
  manifest.updatedAt = new Date().toISOString();
  atomicWriteJson(runManifestPath(manifest.demoName, manifest.runKey), manifest);
}

function runManifestPath(demoName: string, runKey: string): string {
  return join('demos', '.local', 'runs', demoName, runKey, 'manifest.json');
}

function validateRunManifest(value: unknown, path: string): DemoRunManifest {
  if (value === null || typeof value !== 'object') throw new Error(`${path} is not a manifest object`);
  const row = value as Partial<DemoRunManifest>;
  if (row.version !== 1 || !row.demoName || !row.runKey || !row.dataVersion || !row.providerHash || !row.database) {
    throw new Error(`${path} is not a valid demo run manifest`);
  }
  return {
    version: 1,
    demoName: row.demoName,
    runKey: row.runKey,
    dataVersion: row.dataVersion,
    providerHash: row.providerHash,
    ...(row.artifactPath ? { artifactPath: row.artifactPath } : {}),
    database: row.database,
    units: row.units ?? {},
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? new Date().toISOString(),
  };
}

function extractionCachePath(key: string): string {
  return join('demos', '.local', 'cache', 'extractions', `${key}.json`);
}

function extractionCacheKey(options: {
  demoName: string | undefined;
  dataVersion: string | undefined;
  providers: ResolvedDemoProviders;
  unit: PreparedIngestionUnit;
  prompt: string;
}): string {
  return hashJson({
    version: 1,
    demoName: options.demoName,
    dataVersion: options.dataVersion,
    provider: options.providers.extractor.provenance,
    unitId: options.unit.id,
    promptHash: hashText(options.prompt),
    images: imageSourceHashes(options.unit.imageSources),
  });
}

function readCachedExtraction(options: {
  demoName: string | undefined;
  dataVersion: string | undefined;
  providers: ResolvedDemoProviders;
  unit: PreparedIngestionUnit;
  prompt: string;
}): ExtractionResult | null {
  const key = extractionCacheKey(options);
  return readJsonOrNull(extractionCachePath(key), validateCachedExtraction);
}

function writeCachedExtraction(options: {
  demoName: string | undefined;
  dataVersion: string | undefined;
  providers: ResolvedDemoProviders;
  unit: PreparedIngestionUnit;
  prompt: string;
  result: ExtractionResult;
}): void {
  const key = extractionCacheKey(options);
  atomicWriteJson(extractionCachePath(key), { result: options.result });
}

function validateCachedExtraction(value: unknown, path: string): ExtractionResult {
  if (value === null || typeof value !== 'object') throw new Error(`${path} is not an extraction cache entry`);
  const result = (value as { result?: unknown }).result;
  if (result === null || typeof result !== 'object') throw new Error(`${path} is missing result`);
  const candidate = result as Partial<ExtractionResult>;
  if (!Array.isArray(candidate.assertions) || !Array.isArray(candidate.links)) {
    throw new Error(`${path} has invalid extraction result`);
  }
  return { assertions: candidate.assertions, links: candidate.links };
}

function imageSourceHashes(imageSources: PreparedIngestionUnit['imageSources']): Record<string, string> {
  if (!imageSources) return {};
  return Object.fromEntries(
    Object.entries(imageSources)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ref, source]) => [ref, { mimeType: source.mimeType, hash: hashFile(source.path) }])
      .map(([ref, value]) => [ref, hashJson(value)]),
  );
}

function embeddingCachePath(key: string): string {
  return join('demos', '.local', 'cache', 'embeddings', `${key}.json`);
}

function embeddingCacheKey(options: {
  demoName: string;
  dataVersion: string;
  provenance: ResolvedDemoProviders['provenance']['embedding'];
  purpose: string | undefined;
  text: string;
}): string {
  return hashJson({
    version: 1,
    demoName: options.demoName,
    dataVersion: options.dataVersion,
    provenance: options.provenance,
    purpose: options.purpose ?? 'assertion',
    textHash: hashText(options.text),
  });
}

function readCachedEmbedding(options: {
  demoName: string;
  dataVersion: string;
  provenance: ResolvedDemoProviders['provenance']['embedding'];
  purpose: string | undefined;
  text: string;
}): Float32Array | null {
  const key = embeddingCacheKey(options);
  const cached = readJsonOrNull(embeddingCachePath(key), validateCachedEmbedding);
  return cached === null ? null : new Float32Array(cached.vector);
}

function writeCachedEmbedding(options: {
  demoName: string;
  dataVersion: string;
  provenance: ResolvedDemoProviders['provenance']['embedding'];
  purpose: string | undefined;
  text: string;
  vector: Float32Array | number[];
}): void {
  const key = embeddingCacheKey(options);
  atomicWriteJson(embeddingCachePath(key), { vector: Array.from(options.vector) });
}

function validateCachedEmbedding(value: unknown, path: string): { vector: number[] } {
  if (value === null || typeof value !== 'object') throw new Error(`${path} is not an embedding cache entry`);
  const vector = (value as { vector?: unknown }).vector;
  if (!Array.isArray(vector) || vector.some((item) => typeof item !== 'number')) {
    throw new Error(`${path} has invalid embedding vector`);
  }
  return { vector };
}

function expectedContract(episode: NewEpisodeInput, result: ExtractionResult): UnitContract {
  return {
    unitHash: unitHash(episode, result.assertions as Assertion[], result.links),
    assertionIds: result.assertions.map((assertion) => assertion.id).sort(),
    citationIds: result.assertions.flatMap((assertion) => assertion.citations.map((citation) => citation.id)).sort(),
    linkIds: result.links.map((link) => link.id).sort(),
  };
}

async function unitMatchesContract(
  store: TragetiStore,
  namespace: string,
  episode: NewEpisodeInput,
  expected: UnitContract,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const storedEpisode = await store.getEpisode(episode.id);
  if (storedEpisode === null) return { ok: false, reason: `episode "${episode.id}" is missing` };
  const assertions = (await store.getAssertions(namespace, { includeSuperseded: true })).filter(
    (assertion) => assertion.sourceEpisodeId === episode.id,
  );
  const assertionIds = assertions.map((assertion) => assertion.id).sort();
  if (assertionIds.join('\n') !== expected.assertionIds.join('\n')) {
    return { ok: false, reason: `assertion IDs differ for episode "${episode.id}"` };
  }
  const links = await store.getLinksByIds(expected.linkIds);
  if (links.length !== expected.linkIds.length) return { ok: false, reason: `link IDs differ for episode "${episode.id}"` };
  const actualHash = unitHash(episode, assertions, links);
  if (actualHash !== expected.unitHash) return { ok: false, reason: `stored row hash differs for episode "${episode.id}"` };
  return { ok: true };
}

function unitHash(
  episode: NewEpisodeInput,
  assertions: readonly Assertion[],
  links: readonly ExtractionResult['links'][number][],
): string {
  return hashJson({
    episode,
    assertions: assertions
      .map((assertion) => ({
        id: assertion.id,
        namespace: assertion.namespace,
        type: assertion.type,
        content: assertion.content,
        validFrom: assertion.validFrom,
        validUntil: assertion.validUntil ?? null,
        confidence: assertion.confidence,
        sourceEpisodeId: assertion.sourceEpisodeId,
        supersedesId: assertion.supersedesId ?? null,
        entityId: assertion.entityId ?? null,
        entityType: assertion.entityType ?? null,
        citations: assertion.citations
          .map((citation) => ({
            id: citation.id,
            episodeId: citation.episodeId,
            sourceRef: citation.sourceRef,
            excerpt: citation.excerpt,
            excerptStart: citation.excerptStart,
            excerptEnd: citation.excerptEnd,
            metadata: citation.metadata,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    links: links
      .map((link) => ({
        id: link.id,
        namespace: link.namespace,
        fromId: link.fromId,
        toId: link.toId,
        linkType: link.linkType,
        validFrom: link.validFrom,
        validUntil: link.validUntil ?? null,
        sourceEpisodeId: link.sourceEpisodeId,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }).slice(0, 32);
}

async function writeResultBundle(store: TragetiStore, episode: NewEpisodeInput, result: ExtractionResult): Promise<void> {
  if ('writeEpisodeBundle' in store && typeof store.writeEpisodeBundle === 'function') {
    await store.writeEpisodeBundle({ episode, assertions: result.assertions, links: result.links });
    return;
  }
  await store.writeEpisode(episode);
  for (const assertion of result.assertions) await store.writeAssertion(assertion);
  for (const link of result.links) await store.writeLink(link);
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

async function indexExpectedAssertions(
  store: TragetiStore,
  assertionIds: readonly string[],
  context: {
    episode: NewEpisodeInput;
    providerLabel: string;
    embeddingDimension: number | undefined;
    trace: LlmTraceOptions | undefined;
  },
): Promise<void> {
  const started = performance.now();
  const missing = await missingExpectedIndexing(store, context.episode.namespace, assertionIds);
  traceLog(
    context.trace,
    `Embedding/indexing start -> ${context.episode.id}: ${String(missing.length)} assertion(s), ` +
      `${context.providerLabel}, dimension ${String(context.embeddingDimension ?? 'unknown')}`,
  );
  if (missing.length === 0) {
    traceLog(
      context.trace,
      `Embedding/indexing complete <- ${context.episode.id}: indexed 0, skipped 0 (${(
        performance.now() - started
      ).toFixed(1)} ms)`,
    );
    return;
  }
  const ib = await store.indexBatch(
    missing.map((row) => ({ assertionId: row.id })),
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

async function missingExpectedIndexing(
  store: TragetiStore,
  namespace: string,
  assertionIds: readonly string[],
): Promise<Array<{ id: string; content: string }>> {
  if ('getMissingIndexing' in store && typeof store.getMissingIndexing === 'function') {
    return await store.getMissingIndexing(namespace, assertionIds);
  }
  return assertionIds.map((id) => ({ id, content: '' }));
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
