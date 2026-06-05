import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Assertion, Episode } from 'trageti';
import { RawVectorProvider } from 'trageti';
import {
  PREPARED_ARTIFACT_VERSION,
  type PreparedDemoArtifact,
  type PreparedIngestionUnit,
} from '../shared/artifacts.js';
import { envWithDemoRateLimit, isWarmupArg } from '../shared/cli.js';
import { resolveCitationExcerpts, validateExtractionResult, type ExtractionResult } from '../shared/ingest.js';
import { parseExtraction } from '../shared/parse.js';
import {
  createFixtureExtractionProvider,
  inferEmbeddingDimensionFromVectors,
  resolveLiveEmbeddingProvider,
  resolveLiveExtractionProvider,
  resolveVisionProvider,
  type ExtractionProvider,
  type LlmTraceOptions,
  type ProviderProvenance,
  type ResolvedDemoProviders,
} from '../shared/providers.js';

export const NAMESPACE = 'screen-activity';
export const EMBEDDING_DIMENSION = 768;
export const BIG_BROTHER_DATA_VERSION = 'big-brother-v1';
export const NARRATIVE_QUERY_TEXT =
  'What does the screen history suggest the user is working on and what should come next?';

export interface BigBrotherCliOptions {
  query: string | null;
  rateLimitSeconds: number | null;
  warmup: boolean;
  capture: boolean;
  captures: number;
  durationMinutes: number;
  multimodal: boolean;
}

export interface BigBrotherArtifactMetadata {
  mode: 'descriptions' | 'multimodal';
  captureCount: number;
  durationMinutes: number;
  latestPosition: number;
  queryTexts: string[];
  fixtureData?: ReturnType<typeof createSyntheticFixtureData>;
}

export interface CaptureRecord {
  id: string;
  path: string;
  mimeType: string;
  capturedAt: string;
  position: number;
}

export interface CaptureProgress {
  captureStart?(event: { index: number; total: number; path: string }): void;
  captureDone?(event: { index: number; total: number; path: string }): void;
  describeStart?(event: { id: string; path: string }): void;
  describeDone?(event: { id: string; path: string }): void;
}

const SYNTHETIC_DESCRIPTIONS: readonly string[] = [
  'The screenshot shows a desktop with VS Code focused on demos/big-brother/scenario.ts. The visible TypeScript work is about preparing the Big Brother demo by capturing screenshots, describing them, and documenting multimodal ingestion. A terminal panel is open with npm run typecheck, suggesting the user is implementing and validating demo code.',
  'The screenshot shows a browser on OpenAI API documentation about vision inputs and a notes pane listing DEMO_VISION_PROVIDER, direct image path citations, and prompting before capture. The user appears to be checking multimodal request format and translating that into demo configuration requirements.',
];

export function parseBigBrotherCliOptions(argv = process.argv): BigBrotherCliOptions {
  let query: string | null = null;
  let rateLimitSeconds: number | null = null;
  let warmup = false;
  let capture = false;
  let captures = 10;
  let durationMinutes = 5;
  let multimodal = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (isWarmupArg(arg)) {
      warmup = true;
      continue;
    }
    if (arg === '--capture') {
      capture = true;
      continue;
    }
    if (arg === '--multimodal') {
      multimodal = true;
      continue;
    }
    if (arg === '--query') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--query requires a non-empty value');
      query = normalizeNonEmpty(value, '--query');
      i += 1;
      continue;
    }
    if (arg.startsWith('--query=')) {
      query = normalizeNonEmpty(arg.slice('--query='.length), '--query');
      continue;
    }
    if (arg === '--limit') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--limit requires a non-negative number');
      rateLimitSeconds = normalizeNonNegative(value, '--limit');
      i += 1;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      rateLimitSeconds = normalizeNonNegative(arg.slice('--limit='.length), '--limit');
      continue;
    }
    if (arg === '--captures') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--captures requires a positive integer');
      captures = normalizePositiveInteger(value, '--captures');
      i += 1;
      continue;
    }
    if (arg.startsWith('--captures=')) {
      captures = normalizePositiveInteger(arg.slice('--captures='.length), '--captures');
      continue;
    }
    if (arg === '--duration-minutes') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new Error('--duration-minutes requires a non-negative number');
      durationMinutes = normalizeNonNegative(value, '--duration-minutes');
      i += 1;
      continue;
    }
    if (arg.startsWith('--duration-minutes=')) {
      durationMinutes = normalizeNonNegative(arg.slice('--duration-minutes='.length), '--duration-minutes');
    }
  }

  return { query, rateLimitSeconds, warmup, capture, captures, durationMinutes, multimodal };
}

export async function prepareBigBrotherArtifact(options: {
  cli: BigBrotherCliOptions;
  env: NodeJS.ProcessEnv;
  trace: LlmTraceOptions;
  progress?: CaptureProgress;
}): Promise<PreparedDemoArtifact> {
  const queryTexts = options.cli.query
    ? [...defaultQueryTexts(), NARRATIVE_QUERY_TEXT, options.cli.query]
    : [...defaultQueryTexts(), NARRATIVE_QUERY_TEXT];
  if (!hasLiveProviderHints(options.env) && !options.cli.capture) {
    return syntheticArtifact(options.cli, queryTexts);
  }

  await confirmCapture(options.cli);
  const captureOptions = {
    count: options.cli.captures,
    durationMinutes: options.cli.durationMinutes,
    outputDir: runtimeDir(),
    ...(options.progress !== undefined ? { progress: options.progress } : {}),
  };
  const captures = await captureScreenshots(captureOptions);
  const vision = !options.cli.multimodal
    ? resolveVisionProvider({
        env: envWithDemoRateLimit(options.env, options.cli.rateLimitSeconds),
        trace: options.trace,
      })
    : null;
  const descriptions: string[] = [];
  if (vision) {
    for (const capture of captures) {
      options.progress?.describeStart?.({ id: capture.id, path: capture.path });
      descriptions.push(await describeCapture(vision, capture));
      options.progress?.describeDone?.({ id: capture.id, path: capture.path });
    }
  }
  return artifactFromCaptures({
    cli: options.cli,
    captures,
    descriptions,
    queryTexts,
    fixtureData: undefined,
  });
}

export function resolveBigBrotherProviders(options: {
  cli: BigBrotherCliOptions;
  artifact: PreparedDemoArtifact;
  env: NodeJS.ProcessEnv;
  trace: LlmTraceOptions;
}): ResolvedDemoProviders {
  const metadata = bigBrotherMetadata(options.artifact);
  if (metadata.fixtureData !== undefined) {
    return createFixtureProviders({ ...metadata.fixtureData, queryTexts: metadata.queryTexts });
  }
  const env = envWithDemoRateLimit(options.env, options.cli.rateLimitSeconds);
  const extractor = resolveLiveExtractionProvider({ env, trace: options.trace });
  const embedder = resolveLiveEmbeddingProvider({ env, trace: options.trace });
  return {
    modeLabel: `live (${metadata.mode}; ${extractor.label} + ${embedder.label})`,
    isLive: true,
    extractor,
    embedder,
    provenance: { extraction: extractor.provenance, embedding: embedder.provenance },
  };
}

export function bigBrotherMetadata(artifact: PreparedDemoArtifact): BigBrotherArtifactMetadata {
  return artifact.metadata as unknown as BigBrotherArtifactMetadata;
}

export function runtimeDatabasePath(hash: string): string {
  const dir = runtimeDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}.db`);
}

export function runHash(options: { artifact: PreparedDemoArtifact; providers: ResolvedDemoProviders }): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        dataVersion: options.artifact.dataVersion,
        extraction: options.providers.provenance.extraction,
        embedding: options.providers.provenance.embedding,
        mode: bigBrotherMetadata(options.artifact).mode,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

export function defaultQueryTexts(): readonly string[] {
  return [
    'What applications has the user been using?',
    'What has the user been trying to accomplish?',
    'What work pattern or goal appears across the screenshots?',
    'What might the user want to work on next?',
  ];
}

function syntheticArtifact(cli: BigBrotherCliOptions, queryTexts: readonly string[]): PreparedDemoArtifact {
  const captures = SYNTHETIC_DESCRIPTIONS.map(
    (_, index): CaptureRecord => ({
      id: `screen-${String(index + 1)}`,
      path: join('demos', 'big-brother', 'data', `synthetic-screen-${String(index + 1)}.svg`),
      mimeType: 'image/svg+xml',
      capturedAt: new Date(Date.UTC(2026, 0, 1, 16, index * 2, 0)).toISOString(),
      position: index + 1,
    }),
  );
  const fixtureData = createSyntheticFixtureData(captures, queryTexts);
  return artifactFromCaptures({
    cli,
    captures,
    descriptions: cli.multimodal ? [] : [...SYNTHETIC_DESCRIPTIONS],
    queryTexts,
    fixtureData,
  });
}

function artifactFromCaptures(options: {
  cli: BigBrotherCliOptions;
  captures: readonly CaptureRecord[];
  descriptions: readonly string[];
  queryTexts: readonly string[];
  fixtureData: ReturnType<typeof createSyntheticFixtureData> | undefined;
}): PreparedDemoArtifact {
  const mode = options.cli.multimodal ? 'multimodal' : 'descriptions';
  const units = options.captures.map((capture, index): PreparedIngestionUnit => {
    const description = options.descriptions[index];
    const sourceRef = mode === 'multimodal' ? capture.path : `descriptions/${capture.id}.md`;
    const document =
      mode === 'multimodal'
        ? `Screenshot ${capture.id} captured at ${capture.capturedAt}. Source image: ${capture.path}.`
        : `Screenshot ${capture.id} captured at ${capture.capturedAt}.\n\n${description ?? ''}`;
    const episode: Omit<Episode, 'createdAt'> = {
      id: capture.id,
      namespace: NAMESPACE,
      position: capture.position,
      occurredAt: capture.capturedAt,
      type: 'screen-observation',
      content: document,
    };
    return {
      id: capture.id,
      episode,
      document,
      citationSources: mode === 'multimodal' ? {} : { [sourceRef]: document },
      ...(mode === 'multimodal'
        ? { imageSources: { [sourceRef]: { path: capture.path, mimeType: capture.mimeType } } }
        : {}),
      metadata: { sourceRef, screenshotPath: capture.path, mimeType: capture.mimeType, mode },
    };
  });
  const metadata: BigBrotherArtifactMetadata = {
    mode,
    captureCount: options.captures.length,
    durationMinutes: options.cli.durationMinutes,
    latestPosition: options.captures[options.captures.length - 1]?.position ?? 1,
    queryTexts: [...options.queryTexts],
    ...(options.fixtureData ? { fixtureData: options.fixtureData } : {}),
  };
  return {
    artifactVersion: PREPARED_ARTIFACT_VERSION,
    scenario: 'big-brother',
    namespace: NAMESPACE,
    preparedAt: new Date().toISOString(),
    dataVersion: dataVersion(units, metadata),
    units,
    metadata: metadata as unknown as Record<string, unknown>,
  };
}

async function captureScreenshots(options: {
  count: number;
  durationMinutes: number;
  outputDir: string;
  progress?: CaptureProgress;
}): Promise<CaptureRecord[]> {
  mkdirSync(options.outputDir, { recursive: true });
  const screenshot = await import('screenshot-desktop');
  const capture = screenshot.default ?? screenshot;
  const intervalMs = options.count <= 1 ? 0 : (options.durationMinutes * 60_000) / (options.count - 1);
  const records: CaptureRecord[] = [];
  for (let i = 0; i < options.count; i++) {
    if (i > 0 && intervalMs > 0) await sleep(intervalMs);
    const capturedAt = new Date().toISOString();
    const id = `screen-${String(i + 1).padStart(2, '0')}`;
    const path = join(options.outputDir, `${id}-${capturedAt.replace(/[:.]/g, '-')}.png`);
    options.progress?.captureStart?.({ index: i + 1, total: options.count, path });
    await capture({ filename: path });
    records.push({ id, path, mimeType: 'image/png', capturedAt, position: i + 1 });
    options.progress?.captureDone?.({ index: i + 1, total: options.count, path });
  }
  return records;
}

async function describeCapture(provider: ExtractionProvider, capture: CaptureRecord): Promise<string> {
  const prompt = [
    'Describe this desktop screenshot in as much useful detail as possible for later temporal RAG ingestion.',
    'Focus on visible applications, documents, UI state, text, apparent user goals, work progress, blockers, and likely next steps.',
    'Do not invent hidden information. Preserve uncertainty when an item is unclear.',
    `Screenshot sourceRef: ${capture.path}`,
    `Captured at: ${capture.capturedAt}`,
  ].join('\n');
  return (
    await provider.extract(prompt, {
      episodeId: capture.id,
      responseFormat: 'text',
      images: { [capture.path]: { path: capture.path, mimeType: capture.mimeType } },
    })
  ).trim();
}

async function confirmCapture(cli: BigBrotherCliOptions): Promise<void> {
  if (cli.capture) return;
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Screen capture requires confirmation. Re-run with --capture to confirm in non-interactive mode.');
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Big Brother will capture ${String(cli.captures)} desktop screenshot(s) over ${String(
        cli.durationMinutes,
      )} minute(s). Continue? y/N `,
    );
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error('Screen capture cancelled.');
  } finally {
    rl.close();
  }
}

function createSyntheticFixtureData(
  captures: readonly CaptureRecord[],
  queryTexts: readonly string[] = defaultQueryTexts(),
): {
  fixtures: Record<string, string>;
  assertionEmbeddings: Record<string, number[]>;
  queryEmbeddings: Record<string, number[]>;
} {
  const fixtures: Record<string, string> = {};
  const assertionEmbeddings: Record<string, number[]> = {};
  const queryEmbeddings: Record<string, number[]> = {};
  const prior: Assertion[] = [];
  for (const [index, capture] of captures.entries()) {
    const sourceRef = `descriptions/${capture.id}.md`;
    const description = SYNTHETIC_DESCRIPTIONS[index] ?? '';
    const result = deterministicExtraction(capture, description, sourceRef, prior);
    const cited = resolveCitationExcerpts(result, description, { [sourceRef]: description });
    validateExtractionResult(cited, prior);
    fixtures[capture.id] = JSON.stringify(result, null, 2);
    for (const assertion of cited.assertions) {
      assertionEmbeddings[assertion.id] = hashEmbed(assertion.content);
      prior.push(toPromptAssertion(assertion, capture));
    }
  }
  for (const text of queryTexts) queryEmbeddings[text] = hashEmbed(text);
  return { fixtures, assertionEmbeddings, queryEmbeddings };
}

function deterministicExtraction(
  capture: CaptureRecord,
  description: string,
  sourceRef: string,
  prior: readonly Assertion[],
): ExtractionResult {
  const range = { start: 0, end: description.length };
  const app = capture.position === 1 ? 'VS Code and a terminal' : 'a browser and notes pane';
  const goal =
    capture.position === 1
      ? 'implementing the Big Brother demo and validating TypeScript changes'
      : 'checking vision API formatting and writing configuration notes for multimodal ingestion';
  const assertions = [
    {
      id: `a-${capture.id}-activity`,
      namespace: NAMESPACE,
      type: 'fact',
      content: `At ${capture.capturedAt}, the desktop showed ${app}, indicating the user was ${goal}.`,
      validFrom: capture.position,
      validUntil: null,
      confidence: 0.86,
      sourceEpisodeId: capture.id,
      supersedesId: null,
      entityId: 'current-work',
      entityType: 'workstream',
      citations: [
        {
          id: `c-a-${capture.id}-activity-0`,
          episodeId: capture.id,
          sourceRef,
          excerpt: null,
          excerptStart: String(range.start),
          excerptEnd: String(range.end),
        },
      ],
    },
  ];
  const previous = prior.find((assertion) => assertion.entityId === 'current-work');
  return {
    assertions,
    links: previous
      ? [
          {
            id: `link-${capture.id}-previous`,
            namespace: NAMESPACE,
            fromId: assertions[0]?.id ?? `a-${capture.id}-activity`,
            toId: previous.id,
            linkType: 'contextualizes',
            validFrom: capture.position,
            validUntil: null,
            sourceEpisodeId: capture.id,
          },
        ]
      : [],
  };
}

function createFixtureProviders(options: {
  fixtures: Record<string, string>;
  assertionEmbeddings: Record<string, number[]>;
  queryEmbeddings: Record<string, number[]>;
  queryTexts: readonly string[];
}): ResolvedDemoProviders {
  const extractor = createFixtureExtractionProvider(options.fixtures);
  const dimension = inferEmbeddingDimensionFromVectors(options);
  const raw = new RawVectorProvider(dimension);
  for (const rawFixture of Object.values(options.fixtures)) {
    for (const assertion of parseExtraction(rawFixture).assertions) {
      const vector = options.assertionEmbeddings[assertion.id];
      if (!vector) throw new Error(`missing deterministic assertion embedding for ${assertion.id}`);
      raw.set(assertion.content, vector);
    }
  }
  for (const text of options.queryTexts) {
    const vector = options.queryEmbeddings[text];
    if (!vector) throw new Error(`missing deterministic query embedding for ${text}`);
    raw.set(text, vector);
  }
  const embedder = {
    name: raw.name,
    label: 'fixture / derived hash-vector',
    provenance: provenance({ kind: 'fixture', model: 'derived-hash-vectors', dimension }),
    provider: raw,
  };
  return {
    modeLabel: 'fixture / synthetic screenshots',
    isLive: false,
    extractor,
    embedder,
    provenance: { extraction: extractor.provenance, embedding: embedder.provenance },
  };
}

function hasLiveProviderHints(env: NodeJS.ProcessEnv): boolean {
  const explicitVision = env['DEMO_VISION_PROVIDER']?.trim();
  const explicitExtract = env['DEMO_EXTRACT_PROVIDER']?.trim();
  const explicitEmbed = env['DEMO_EMBED_PROVIDER']?.trim();
  if (explicitVision === 'fixture' && explicitExtract === 'fixture' && explicitEmbed === 'fixture') return false;
  if (explicitVision && explicitVision !== 'fixture') return true;
  if (explicitExtract && explicitExtract !== 'fixture') return true;
  if (explicitEmbed && explicitEmbed !== 'fixture') return true;
  return Boolean(
    env['ANTHROPIC_API_KEY'] ??
    env['OPENAI_API_KEY'] ??
    env['OPENROUTER_API_KEY'] ??
    env['OLLAMA_HOST'] ??
    env['DEMO_VISION_BASE_URL'] ??
    env['DEMO_EXTRACT_BASE_URL'] ??
    env['DEMO_EMBED_BASE_URL'],
  );
}

function runtimeDir(): string {
  const dir = join('demos', '.local', 'big-brother');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function dataVersion(units: readonly PreparedIngestionUnit[], metadata: BigBrotherArtifactMetadata): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ version: BIG_BROTHER_DATA_VERSION, units, metadata: { ...metadata, fixtureData: undefined } }),
    )
    .digest('hex')
    .slice(0, 16);
}

function toPromptAssertion(assertion: ExtractionResult['assertions'][number], capture: CaptureRecord): Assertion {
  return {
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
    citations: assertion.citations.map((citation) => ({
      ...citation,
      assertionId: assertion.id,
      episodeId: citation.episodeId ?? capture.id,
      createdAt: '',
    })),
    createdAt: '',
    extensions: {},
  };
}

function hashEmbed(text: string): number[] {
  const out = new Array(EMBEDDING_DIMENSION).fill(0) as number[];
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    addFeature(out, tokens[i] ?? '', 1);
    if (i + 1 < tokens.length) addFeature(out, `${tokens[i]} ${tokens[i + 1]}`, 0.5);
  }
  let mag = 0;
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) mag += (out[i] ?? 0) * (out[i] ?? 0);
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) out[i] = (out[i] ?? 0) / mag;
  return out;
}

function addFeature(out: number[], feature: string, weight: number): void {
  let hash = 2166136261;
  for (let i = 0; i < feature.length; i++) {
    hash ^= feature.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const index = Math.abs(hash) % EMBEDDING_DIMENSION;
  out[index] = (out[index] ?? 0) + weight;
}

function provenance(input: Omit<ProviderProvenance, 'configHash'>): ProviderProvenance {
  const configHash = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 12);
  return { ...input, configHash };
}

function normalizeNonEmpty(value: string, flag: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${flag} requires a non-empty value`);
  return normalized;
}

function normalizeNonNegative(value: string, flag: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!trimmed || !Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} requires a non-negative number`);
  return parsed;
}

function normalizePositiveInteger(value: string, flag: string): number {
  const parsed = normalizeNonNegative(value, flag);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
