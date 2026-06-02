import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Assertion, Episode } from 'trageti';
import { RawVectorProvider } from 'trageti';
import { parseExtraction } from '../shared/parse.js';
import type {
  DemoEmbeddingProvider,
  ExtractionProvider,
  ProviderProvenance,
  ResolvedDemoProviders,
} from '../shared/providers.js';
import { createFixtureExtractionProvider } from '../shared/providers.js';
import type { ExtractionResult } from '../shared/ingest.js';
import { resolveCitationExcerpts, validateExtractionResult } from '../shared/ingest.js';
import { defaultKeyframes } from './data/keyframes.js';

export const NAMESPACE = 'repository-history';
export const EMBEDDING_DIMENSION = 768;

export interface Keyframe {
  hash: string;
  position: number;
  label: string;
  date: string;
}

export interface KnowThyselfCliOptions {
  query: string | null;
  repo: string;
  keyframes: readonly string[];
  repoProvided: boolean;
  keyframesProvided: boolean;
}

export interface DerivedHistoryData {
  repoPath: string;
  keyframes: readonly Keyframe[];
  episodes: ReadonlyArray<Omit<Episode, 'createdAt'>>;
  citationSources: Readonly<Record<string, string>>;
  sourceSummaries: Readonly<Record<string, string>>;
  latestPosition: number;
  initialPosition: number;
}

interface SelectedFile {
  path: string;
  status: string;
  added: number;
  deleted: number;
  score: number;
}

export interface SourceSummarizer {
  summarize(prompt: string): Promise<string>;
}

export function parseKnowThyselfCliOptions(argv = process.argv): KnowThyselfCliOptions {
  let query: string | null = null;
  let repo = '.';
  let repoProvided = false;
  let keyframes: string[] | null = null;
  let keyframesProvided = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
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
    if (arg === '--repo') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--repo requires a non-empty value');
      repo = normalizeNonEmpty(value, '--repo');
      repoProvided = true;
      i += 1;
      continue;
    }
    if (arg.startsWith('--repo=')) {
      repo = normalizeNonEmpty(arg.slice('--repo='.length), '--repo');
      repoProvided = true;
      continue;
    }
    if (arg === '--keyframes') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--keyframes requires a comma-separated list');
      keyframes = parseKeyframeList(value);
      keyframesProvided = true;
      i += 1;
      continue;
    }
    if (arg.startsWith('--keyframes=')) {
      keyframes = parseKeyframeList(arg.slice('--keyframes='.length));
      keyframesProvided = true;
    }
  }

  if (repoProvided && !keyframesProvided) {
    throw new Error('--repo requires --keyframes so the demo knows which commits to ingest');
  }

  return {
    query,
    repo,
    keyframes: keyframes ?? defaultKeyframes,
    repoProvided,
    keyframesProvided,
  };
}

function normalizeNonEmpty(value: string, flag: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${flag} requires a non-empty value`);
  return normalized;
}

function parseKeyframeList(value: string): string[] {
  const refs = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (refs.length === 0) throw new Error('--keyframes requires a comma-separated list');
  return refs;
}

export function isDefaultFixtureEligible(options: KnowThyselfCliOptions): boolean {
  return !options.repoProvided && !options.keyframesProvided;
}

export function assertFixtureAllowedForOptions(options: KnowThyselfCliOptions, providers: ResolvedDemoProviders): void {
  if (isDefaultFixtureEligible(options)) return;
  if (providers.extractor.provenance.kind !== 'fixture' && providers.embedder.provenance.kind !== 'fixture') return;
  throw new Error(
    'Custom --repo and --keyframes runs require live extraction and live embedding providers.\n' +
      'Fixture mode is only supported for the default Know Thyself run with repo "." and the built-in keyframes.',
  );
}

export function createDeterministicSummarizer(): SourceSummarizer {
  return {
    summarize(prompt) {
      const lines = prompt
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const commit = lines.find((line) => line.startsWith('Commit message:')) ?? '';
      const selected = lines.filter((line) => line.startsWith('### ')).slice(0, 4);
      const parts = [commit.replace(/^Commit message:\s*/, '') || 'This keyframe records repository changes.'];
      if (selected.length > 0)
        parts.push(`Important files: ${selected.map((line) => line.slice(4).split(' ')[0]).join(', ')}.`);
      parts.push('The source bundle is generated deterministically from git metadata and selected repository content.');
      return Promise.resolve(parts.join(' '));
    },
  };
}

export function createLiveSummarizer(extractor: ExtractionProvider): SourceSummarizer {
  return {
    summarize(prompt) {
      return extractor.extract(prompt);
    },
  };
}

export async function deriveHistoryData(options: {
  repoPath: string;
  keyframeRefs: readonly string[];
  summarizer: SourceSummarizer;
  tokenBudget?: number;
}): Promise<DerivedHistoryData> {
  const repoPath = resolve(options.repoPath);
  verifyGitRepo(repoPath);
  const keyframes = options.keyframeRefs.map((ref, index) => resolveKeyframe(repoPath, ref, index + 1));
  if (keyframes.length === 0) throw new Error('At least one keyframe commit is required');

  const citationSources: Record<string, string> = {};
  const sourceSummaries: Record<string, string> = {};
  const episodes: Array<Omit<Episode, 'createdAt'>> = [];
  const tokenBudget = options.tokenBudget ?? 8192;

  for (let i = 0; i < keyframes.length; i++) {
    const current = keyframes[i];
    if (!current) continue;
    const previous = keyframes[i - 1];
    const built = previous
      ? await buildPairSource(repoPath, options.summarizer, previous, current, tokenBudget)
      : await buildInitialSource(repoPath, options.summarizer, current, tokenBudget);
    const sourceKey = `sources/${built.sourceRef}`;
    citationSources[sourceKey] = built.content;
    sourceSummaries[sourceKey] = built.summary;
    episodes.push({
      id: `kf-${String(current.position)}`,
      namespace: NAMESPACE,
      position: current.position,
      occurredAt: `${current.date}T00:00:00Z`,
      type: 'keyframe',
      content: `${current.label}. Source document: ${sourceKey}. ${built.summary}`,
    });
  }

  return {
    repoPath,
    keyframes,
    episodes,
    citationSources,
    sourceSummaries,
    latestPosition: keyframes[keyframes.length - 1]?.position ?? 1,
    initialPosition: keyframes[0]?.position ?? 1,
  };
}

export function createDeterministicFixtures(
  data: DerivedHistoryData,
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

  for (const episode of data.episodes) {
    const result = deterministicExtractionForEpisode(episode, data.citationSources, prior);
    const cited = resolveCitationExcerpts(result, episode.content, data.citationSources);
    validateExtractionResult(cited, prior);
    fixtures[episode.id] = JSON.stringify(result, null, 2);
    for (const assertion of cited.assertions) {
      assertionEmbeddings[assertion.id] = hashEmbed(assertion.content);
      prior.push(toPromptAssertion(assertion, episode));
    }
  }

  for (const text of queryTexts) {
    queryEmbeddings[text] = hashEmbed(text);
  }

  return { fixtures, assertionEmbeddings, queryEmbeddings };
}

export function sanitizeRepositoryExtractionResult(
  result: ExtractionResult,
  existingAssertions: readonly Assertion[],
): ExtractionResult {
  const knownIds = new Set(existingAssertions.map((assertion) => assertion.id));
  return {
    assertions: result.assertions.map((assertion) => ({
      ...assertion,
      supersedesId:
        assertion.supersedesId !== null && assertion.supersedesId !== undefined && knownIds.has(assertion.supersedesId)
          ? assertion.supersedesId
          : null,
    })),
    links: result.links,
  };
}

export function createFixtureProviders(options: {
  fixtures: Record<string, string>;
  assertionEmbeddings: Record<string, number[]>;
  queryEmbeddings: Record<string, number[]>;
  queryTexts: readonly string[];
}): ResolvedDemoProviders {
  const extractor = createFixtureExtractionProvider(options.fixtures);
  const raw = new RawVectorProvider(EMBEDDING_DIMENSION);
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
  const embedder: DemoEmbeddingProvider = {
    name: raw.name,
    label: 'fixture / derived hash-vector',
    provenance: provenance({ kind: 'fixture', model: 'derived-hash-vectors', dimension: EMBEDDING_DIMENSION }),
    provider: raw,
  };
  return {
    modeLabel: 'fixture / derived raw-vector',
    isLive: false,
    extractor,
    embedder,
    provenance: { extraction: extractor.provenance, embedding: embedder.provenance },
  };
}

export function defaultQueryTexts(): readonly string[] {
  return [
    'What are the most important changes across these keyframes?',
    'How did the repository architecture evolve?',
    'What data model or persistence changes appear in the history?',
    'What retrieval, query, or interface behavior changed?',
    'What risks, regressions, or reversals appear in the history?',
    'How did testing, validation, or release readiness evolve?',
  ];
}

export function runHash(options: {
  repoPath: string;
  keyframes: readonly Keyframe[];
  providers: ResolvedDemoProviders;
  queryTexts: readonly string[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        repoPath: options.repoPath,
        commits: options.keyframes.map((k) => k.hash),
        extraction: options.providers.provenance.extraction,
        embedding: options.providers.provenance.embedding,
        mode: options.providers.isLive ? 'live' : 'fixture',
        queryTexts: options.queryTexts,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

export function runtimeDatabasePath(hash: string): string {
  const dir = join('demos', '.local', 'know-thyself');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}.db`);
}

export function dataVersion(options: {
  repoPath: string;
  keyframes: readonly Keyframe[];
  episodes: ReadonlyArray<Omit<Episode, 'createdAt'>>;
  citationSources: Readonly<Record<string, string>>;
  queryTexts: readonly string[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        repoPath: options.repoPath,
        keyframes: options.keyframes,
        episodes: options.episodes,
        citationSources: sortRecord(options.citationSources),
        queryTexts: options.queryTexts,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

export function writeReviewSources(data: DerivedHistoryData, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  for (const [sourceRef, content] of Object.entries(data.citationSources)) {
    writeFileSync(join(outputDir, sourceRef.replace(/^sources\//, '')), content);
  }
}

function verifyGitRepo(repoPath: string): void {
  git(repoPath, ['rev-parse', '--git-dir']);
}

function resolveKeyframe(repoPath: string, ref: string, position: number): Keyframe {
  const hash = git(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const label = git(repoPath, ['log', hash, '-1', '--format=%s']).trim() || hash.slice(0, 12);
  const date = git(repoPath, ['log', hash, '-1', '--format=%cs']).trim() || '1970-01-01';
  return { hash, position, label, date };
}

function git(repoPath: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function sourceRefFor(current: Keyframe, previous?: Keyframe): string {
  return previous
    ? `kf-${String(previous.position)}..kf-${String(current.position)}.md`
    : `kf-${String(current.position)}.md`;
}

async function buildInitialSource(
  repoPath: string,
  summarizer: SourceSummarizer,
  current: Keyframe,
  tokenBudget: number,
): Promise<{ sourceRef: string; content: string; summary: string }> {
  const sourceRef = sourceRefFor(current);
  const message = git(repoPath, ['log', current.hash, '-1', '--format=%B']).trim();
  const files = initialFiles(repoPath, current).slice(0, 8);
  const fileSections = files.map(
    (path) =>
      `### ${path}\n\n\`\`\`txt\n${fileAt(repoPath, current, path, tokenBudget / Math.max(1, files.length))}\n\`\`\``,
  );
  const prompt = [
    `Write a detailed source summary for repository keyframe ${current.hash} (${current.label}).`,
    'Focus on architecture, public concepts, behavior, and data integrity. Use only the supplied commit message and source excerpts.',
    '',
    `Commit message: ${message}`,
    '',
    'Source excerpts:',
    fileSections.join('\n\n'),
  ].join('\n');
  const summary = (await summarizer.summarize(prompt)).trim();
  return {
    sourceRef,
    summary,
    content: [
      `# ${sourceRef}: ${current.label}`,
      '',
      'Source kind: initial keyframe source bundle',
      `Commit: ${current.hash}`,
      `Date: ${current.date}`,
      '',
      '## Commit message',
      '',
      message,
      '',
      '## Material change summary',
      '',
      summary,
      '',
      '## Selected source context',
      '',
      fileSections.join('\n\n'),
      '',
    ].join('\n'),
  };
}

async function buildPairSource(
  repoPath: string,
  summarizer: SourceSummarizer,
  previous: Keyframe,
  current: Keyframe,
  tokenBudget: number,
): Promise<{ sourceRef: string; content: string; summary: string }> {
  const sourceRef = sourceRefFor(current, previous);
  const message = git(repoPath, ['log', current.hash, '-1', '--format=%B']).trim();
  const stat = git(repoPath, ['diff', '--stat', previous.hash, current.hash]).trim();
  const nameStatus = git(repoPath, ['diff', '--name-status', previous.hash, current.hash]).trim();
  const numstat = git(repoPath, ['diff', '--numstat', previous.hash, current.hash]).trim();
  const files = selectedFiles(repoPath, previous, current);
  const fileSections = files.map((file) => {
    const diff = fileDiff(
      repoPath,
      previous,
      current,
      file.path,
      Math.max(800, tokenBudget / Math.max(1, files.length)),
    );
    return `### ${file.path} (${file.status}, +${String(file.added)}/-${String(file.deleted)})\n\n\`\`\`diff\n${diff}\n\`\`\``;
  });
  const prompt = [
    `Write a detailed source summary for the repository keyframe transition from ${previous.hash} (${previous.label}) to ${current.hash} (${current.label}).`,
    'Focus on architectural, API, retrieval, validation, data-model, and operational changes. Use only the supplied git metadata and selected diffs.',
    '',
    `Commit message: ${message}`,
    '',
    `Diff stat:\n${stat}`,
    '',
    `Name status:\n${nameStatus}`,
    '',
    `Numstat:\n${numstat}`,
    '',
    `Selected diffs:\n${fileSections.join('\n\n')}`,
  ].join('\n');
  const summary = (await summarizer.summarize(prompt)).trim();
  return {
    sourceRef,
    summary,
    content: [
      `# ${sourceRef}: ${previous.label} -> ${current.label}`,
      '',
      'Source kind: keyframe-pair source bundle',
      `Previous commit: ${previous.hash} (${previous.label})`,
      `Current commit: ${current.hash} (${current.label})`,
      `Date: ${current.date}`,
      '',
      '## Commit message',
      '',
      message,
      '',
      '## git diff --stat',
      '',
      '```txt',
      stat,
      '```',
      '',
      '## git diff --name-status',
      '',
      '```txt',
      nameStatus,
      '```',
      '',
      '## git diff --numstat',
      '',
      '```txt',
      numstat,
      '```',
      '',
      '## Material change summary',
      '',
      summary,
      '',
      '## Selected important file diffs',
      '',
      fileSections.join('\n\n'),
      '',
    ].join('\n'),
  };
}

function initialFiles(repoPath: string, current: Keyframe): string[] {
  return git(repoPath, ['ls-tree', '-r', '--name-only', current.hash])
    .split('\n')
    .filter(Boolean)
    .filter((path) => !isIgnored(path))
    .map((path) => ({ path, score: scorePath(path, 50, 0) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((row) => row.path);
}

function selectedFiles(repoPath: string, previous: Keyframe, current: Keyframe, maxFiles = 10): SelectedFile[] {
  const statusByPath = new Map<string, string>();
  for (const line of git(repoPath, ['diff', '--name-status', previous.hash, current.hash]).trim().split('\n')) {
    if (!line) continue;
    const [status, ...parts] = line.split('\t');
    const path = parts[parts.length - 1];
    if (status && path) statusByPath.set(path, status);
  }
  const rows: SelectedFile[] = [];
  for (const line of git(repoPath, ['diff', '--numstat', previous.hash, current.hash]).trim().split('\n')) {
    if (!line) continue;
    const [addedRaw, deletedRaw, path] = line.split('\t');
    if (!path) continue;
    const added = Number.parseInt(addedRaw ?? '0', 10) || 0;
    const deleted = Number.parseInt(deletedRaw ?? '0', 10) || 0;
    const score = scorePath(path, added, deleted);
    if (score === Number.NEGATIVE_INFINITY) continue;
    rows.push({ path, status: statusByPath.get(path) ?? 'M', added, deleted, score });
  }
  return rows.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, maxFiles);
}

function scorePath(path: string, added: number, deleted: number): number {
  if (isIgnored(path)) return Number.NEGATIVE_INFINITY;
  let score = Math.min(added + deleted, 600);
  if (path.startsWith('_docs/specs/')) score += 800;
  if (path === 'README.md' || path === 'CHANGELOG.md') score += 250;
  if (path === 'src/domain/types.ts' || path === 'src/store/TemporalStore.ts') score += 700;
  if (path.includes('/pipeline/') || path.includes('/defaults/scoring/')) score += 550;
  if (path.includes('/defaults/graph/') || path.includes('/db/migrations/')) score += 400;
  if (path.startsWith('test/') && (path.includes('trajectory') || path.includes('semantic') || path.includes('graph')))
    score += 250;
  if (path.endsWith('.md')) score += 100;
  if (path.endsWith('.ts')) score += 80;
  return score;
}

function isIgnored(path: string): boolean {
  return (
    path.endsWith('package-lock.json') ||
    path.endsWith('.db') ||
    path.includes('/embeddings.ts') ||
    path.includes('/fixtures.ts') ||
    path.includes('/.local/') ||
    path.includes('/dist/') ||
    path.includes('/node_modules/') ||
    path.includes('/coverage/')
  );
}

function fileDiff(repoPath: string, previous: Keyframe, current: Keyframe, path: string, tokenBudget: number): string {
  try {
    return truncateToTokenBudget(git(repoPath, ['diff', previous.hash, current.hash, '--', path]), tokenBudget);
  } catch {
    return '(diff unavailable)';
  }
}

function fileAt(repoPath: string, commit: Keyframe, path: string, tokenBudget: number): string {
  try {
    return truncateToTokenBudget(git(repoPath, ['show', `${commit.hash}:${path}`]), tokenBudget);
  } catch {
    return '(file unavailable at this commit)';
  }
}

function truncateToTokenBudget(text: string, tokenBudget: number): string {
  const charBudget = Math.floor(tokenBudget / 0.25);
  return text.length <= charBudget ? text : text.slice(0, charBudget) + '\n... [truncated]';
}

function deterministicExtractionForEpisode(
  episode: Omit<Episode, 'createdAt'>,
  citationSources: Readonly<Record<string, string>>,
  prior: readonly Assertion[],
): ExtractionResult {
  const sourceRef = sourceRefFromEpisode(episode);
  const source = citationSources[sourceRef];
  if (!source) throw new Error(`missing citation source for ${episode.id}: ${sourceRef}`);
  const summaryRange = sourceRange(source, '## Material change summary');
  const messageRange = sourceRange(source, '## Commit message');
  const assertions = [
    {
      id: `a-${episode.id}-summary`,
      namespace: episode.namespace,
      type: episode.position === 1 ? 'fact' : 'update',
      content: cleanAssertionContent(sliceRange(source, summaryRange)),
      validFrom: episode.position,
      validUntil: null,
      confidence: 0.82,
      sourceEpisodeId: episode.id,
      supersedesId: null,
      entityId: 'repository-history',
      entityType: 'repository',
      citations: [
        {
          id: `c-${episode.id}-summary`,
          episodeId: episode.id,
          sourceRef,
          excerpt: null,
          excerptStart: String(summaryRange.start),
          excerptEnd: String(summaryRange.end),
        },
      ],
    },
    {
      id: `a-${episode.id}-commit`,
      namespace: episode.namespace,
      type: 'fact',
      content: `Keyframe ${String(episode.position)} records commit context: ${cleanAssertionContent(sliceRange(source, messageRange))}`,
      validFrom: episode.position,
      validUntil: null,
      confidence: 0.78,
      sourceEpisodeId: episode.id,
      supersedesId: null,
      entityId: `keyframe-${String(episode.position)}`,
      entityType: 'commit',
      citations: [
        {
          id: `c-${episode.id}-commit`,
          episodeId: episode.id,
          sourceRef,
          excerpt: null,
          excerptStart: String(messageRange.start),
          excerptEnd: String(messageRange.end),
        },
      ],
    },
  ];
  const previous = prior.find((a) => a.entityId === 'repository-history' && a.validFrom === episode.position - 1);
  return {
    assertions,
    links: previous
      ? [
          {
            id: `link-${episode.id}-previous`,
            namespace: episode.namespace,
            fromId: assertions[0]?.id ?? `a-${episode.id}-summary`,
            toId: previous.id,
            linkType: 'deepens',
            validFrom: episode.position,
            validUntil: null,
            sourceEpisodeId: episode.id,
          },
        ]
      : [],
  };
}

function sourceRefFromEpisode(episode: Omit<Episode, 'createdAt'>): string {
  const match = /Source document:\s+(sources\/\S+?\.md)/.exec(episode.content);
  if (!match?.[1]) throw new Error(`episode ${episode.id} does not name a source document`);
  return match[1];
}

function sourceRange(source: string, heading: string): { start: number; end: number } {
  const headingIndex = source.indexOf(heading);
  if (headingIndex < 0) return firstNonEmptyRange(source);
  const bodyStart = source.indexOf('\n', headingIndex);
  const start = skipWhitespace(source, bodyStart < 0 ? headingIndex + heading.length : bodyStart);
  const next = source.indexOf('\n## ', start);
  const end = trimEnd(source, next < 0 ? source.length : next);
  return end > start ? { start, end } : firstNonEmptyRange(source);
}

function firstNonEmptyRange(source: string): { start: number; end: number } {
  const start = skipWhitespace(source, 0);
  const end = Math.min(source.length, start + 400);
  return { start, end: trimEnd(source, end) };
}

function skipWhitespace(source: string, index: number): number {
  let i = Math.max(0, index);
  while (i < source.length && /\s/.test(source[i] ?? '')) i += 1;
  return i;
}

function trimEnd(source: string, index: number): number {
  let i = Math.max(0, index);
  while (i > 0 && /\s/.test(source[i - 1] ?? '')) i -= 1;
  return i;
}

function sliceRange(source: string, range: { start: number; end: number }): string {
  return source.slice(range.start, range.end);
}

function cleanAssertionContent(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
}

function toPromptAssertion(
  assertion: ExtractionResult['assertions'][number],
  episode: Omit<Episode, 'createdAt'>,
): Assertion {
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
      episodeId: citation.episodeId ?? episode.id,
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
  const idx = Math.abs(hash) % EMBEDDING_DIMENSION;
  out[idx] = (out[idx] ?? 0) + weight;
}

function provenance(input: Omit<ProviderProvenance, 'configHash'>): ProviderProvenance {
  const configHash = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 12);
  return { ...input, configHash };
}

function sortRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

export function resolveRepoPath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}
