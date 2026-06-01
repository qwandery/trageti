// Build reviewable know-thyself source documents and episode summaries from
// the keyframe manifest. Source documents are written to demos/.local first;
// after review, copy them to demos/know-thyself/data/sources for fixture mode.
//
// Usage: npx tsx demos/know-thyself/generate-episodes.ts [--context-length N]

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtractionProvider } from '../shared/providers.js';
import { resolveLiveExtractionProvider } from '../shared/providers.js';
import { createLlmTraceOptions } from '../shared/output.js';
import { NAMESPACE } from './data/episodes.js';
import { keyframes, type Keyframe } from './data/keyframes.js';

interface SelectedFile {
  path: string;
  status: string;
  added: number;
  deleted: number;
  score: number;
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function truncateToTokenBudget(text: string, tokenBudget: number): string {
  const charBudget = Math.floor(tokenBudget / 0.25);
  return text.length <= charBudget ? text : text.slice(0, charBudget) + '\n... [truncated]';
}

function sourceRefFor(index: number, current: Keyframe, previous?: Keyframe): string {
  return previous
    ? `kf-${String(previous.position)}..kf-${String(current.position)}.md`
    : `kf-${String(current.position)}.md`;
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
    path.includes('/node_modules/')
  );
}

function selectedFiles(previous: Keyframe, current: Keyframe, maxFiles = 10): SelectedFile[] {
  const statusByPath = new Map<string, string>();
  for (const line of git(['diff', '--name-status', previous.hash, current.hash]).trim().split('\n')) {
    if (!line) continue;
    const [status, ...parts] = line.split('\t');
    const path = parts[parts.length - 1];
    if (status && path) statusByPath.set(path, status);
  }
  const rows: SelectedFile[] = [];
  for (const line of git(['diff', '--numstat', previous.hash, current.hash]).trim().split('\n')) {
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

function fileDiff(previous: Keyframe, current: Keyframe, path: string, tokenBudget: number): string {
  try {
    return truncateToTokenBudget(git(['diff', previous.hash, current.hash, '--', path]), tokenBudget);
  } catch {
    return '(diff unavailable)';
  }
}

function fileAt(commit: Keyframe, path: string, tokenBudget: number): string {
  try {
    return truncateToTokenBudget(git(['show', `${commit.hash}:${path}`]), tokenBudget);
  } catch {
    return '(file unavailable at this commit)';
  }
}

async function summarizeSource(extractor: ExtractionProvider, prompt: string): Promise<string> {
  return (await extractor.extract(prompt)).trim();
}

async function buildInitialSource(
  extractor: ExtractionProvider,
  current: Keyframe,
  tokenBudget: number,
): Promise<{ sourceRef: string; content: string; summary: string }> {
  const sourceRef = sourceRefFor(0, current);
  const message = git(['log', current.hash, '-1', '--format=%B']).trim();
  const keyFiles = [
    '_docs/specs/trageti-spec-v0.1.md',
    'src/domain/types.ts',
    'src/store/TemporalStore.ts',
    'README.md',
  ];
  const fileSections = keyFiles.map(
    (path) => `### ${path}\n\n\`\`\`txt\n${fileAt(current, path, tokenBudget / keyFiles.length)}\n\`\`\``,
  );
  const prompt = `Write a detailed source summary for trageti keyframe ${current.hash} (${current.label}). Focus on architecture, public concepts, retrieval behavior, temporal modeling, and data integrity. Use only the supplied commit message and source excerpts.\n\nCommit message:\n${message}\n\nSource excerpts:\n${fileSections.join('\n\n')}`;
  const summary = await summarizeSource(extractor, prompt);
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
  extractor: ExtractionProvider,
  previous: Keyframe,
  current: Keyframe,
  tokenBudget: number,
): Promise<{ sourceRef: string; content: string; summary: string }> {
  const sourceRef = sourceRefFor(previous.position, current, previous);
  const message = git(['log', current.hash, '-1', '--format=%B']).trim();
  const stat = git(['diff', '--stat', previous.hash, current.hash]).trim();
  const nameStatus = git(['diff', '--name-status', previous.hash, current.hash]).trim();
  const numstat = git(['diff', '--numstat', previous.hash, current.hash]).trim();
  const files = selectedFiles(previous, current);
  const fileSections = files.map((file) => {
    const diff = fileDiff(previous, current, file.path, Math.max(800, tokenBudget / files.length));
    return `### ${file.path} (${file.status}, +${String(file.added)}/-${String(file.deleted)})\n\n\`\`\`diff\n${diff}\n\`\`\``;
  });
  const prompt = `Write a detailed source summary for the trageti keyframe transition from ${previous.hash} (${previous.label}) to ${current.hash} (${current.label}). Focus on architectural, API, retrieval, citation, validation, and data-model changes. Use only the supplied git metadata and selected diffs.\n\nCommit message:\n${message}\n\nDiff stat:\n${stat}\n\nName status:\n${nameStatus}\n\nNumstat:\n${numstat}\n\nSelected diffs:\n${fileSections.join('\n\n')}`;
  const summary = await summarizeSource(extractor, prompt);
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

async function main(): Promise<void> {
  const tokenArg = process.argv.indexOf('--context-length');
  const tokenBudget = tokenArg >= 0 ? Number(process.argv[tokenArg + 1]) || 8192 : 8192;
  const trace = createLlmTraceOptions();
  const extractor = resolveLiveExtractionProvider({ trace });
  const outputDir = join('demos', '.local', 'know-thyself', 'sources');
  mkdirSync(outputDir, { recursive: true });

  const aggregations: Record<string, string> = {};
  const episodes: Array<{
    id: string;
    namespace: string;
    position: number;
    occurredAt: string;
    type: string;
    content: string;
  }> = [];

  for (let i = 0; i < keyframes.length; i++) {
    const current = keyframes[i];
    if (!current) continue;
    const previous = keyframes[i - 1];
    const built = previous
      ? await buildPairSource(extractor, previous, current, tokenBudget)
      : await buildInitialSource(extractor, current, tokenBudget);
    writeFileSync(join(outputDir, built.sourceRef), built.content);

    const id = `kf-${String(current.position)}`;
    episodes.push({
      id,
      namespace: NAMESPACE,
      position: current.position,
      occurredAt: `${current.date}T00:00:00Z`,
      type: 'keyframe',
      content: `${current.label}. Source document: sources/${built.sourceRef}. ${built.summary}`,
    });
    if (previous) aggregations[`kf-${String(previous.position)}..${id}`] = built.summary;
  }

  console.log(`wrote source documents to ${outputDir}`);
  console.log('episodes:', JSON.stringify(episodes, null, 2));
  console.log('aggregations:', JSON.stringify(aggregations, null, 2));
  console.log('');
  console.log(
    '(review .local source documents, copy accepted files into demos/know-thyself/data/sources, then regenerate fixtures)',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
