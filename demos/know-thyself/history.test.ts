import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseExtraction } from '../shared/parse.js';
import {
  assertFixtureAllowedForOptions,
  createCachedLiveSummarizer,
  createDeterministicFixtures,
  createDeterministicSummarizer,
  createFixtureProviders,
  dataVersion,
  defaultQueryTexts,
  deriveHistoryData,
  parseKnowThyselfCliOptions,
  runHash,
  runtimeDatabasePath,
  sanitizeRepositoryExtractionResult,
} from './history.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseKnowThyselfCliOptions', () => {
  it('parses repo, keyframes, and query options', () => {
    expect(
      parseKnowThyselfCliOptions([
        'node',
        'index.ts',
        '--repo',
        ' ../repo ',
        '--keyframes=a,b,c',
        '--limit=30',
        '--warmup',
        '--query',
        ' what changed? ',
      ]),
    ).toMatchObject({
      repo: '../repo',
      keyframes: ['a', 'b', 'c'],
      query: 'what changed?',
      repoProvided: true,
      keyframesProvided: true,
      rateLimitSeconds: 30,
      warmup: true,
    });
  });

  it('rejects invalid repo/keyframe combinations', () => {
    expect(() => parseKnowThyselfCliOptions(['node', 'index.ts', '--repo', '../repo'])).toThrow(
      '--repo requires --keyframes',
    );
    expect(() => parseKnowThyselfCliOptions(['node', 'index.ts', '--keyframes= , '])).toThrow('--keyframes requires');
    expect(() => parseKnowThyselfCliOptions(['node', 'index.ts', '--limit=nope'])).toThrow('--limit requires');
  });
});

describe('deriveHistoryData', () => {
  it('derives keyframes, episodes, and citation sources from git', async () => {
    const repo = createRepo();
    const first = commit(repo, 'initial architecture', { 'README.md': '# Demo\n\nInitial architecture\n' });
    const second = commit(repo, 'add persistence', { 'src/store.ts': 'export const persistence = true;\n' });

    const data = await deriveHistoryData({
      repoPath: repo,
      keyframeRefs: [first, second],
      summarizer: createDeterministicSummarizer(),
      tokenBudget: 2048,
    });

    expect(data.keyframes.map((k) => k.position)).toEqual([1, 2]);
    expect(data.keyframes.map((k) => k.label)).toEqual(['initial architecture', 'add persistence']);
    expect(data.episodes.map((e) => e.id)).toEqual(['kf-1', 'kf-2']);
    expect(Object.keys(data.citationSources)).toEqual(['sources/kf-1.md', 'sources/kf-1..kf-2.md']);
    expect(data.citationSources['sources/kf-1..kf-2.md']).toContain('## git diff --stat');
  });

  it('summarizes selected repository content one file at a time', async () => {
    const repo = createRepo();
    const first = commit(repo, 'initial architecture', {
      'README.md': '# Demo\n\nInitial architecture\n',
      'src/store/TemporalStore.ts': 'export const store = true;\n',
    });
    const calls: string[] = [];

    await deriveHistoryData({
      repoPath: repo,
      keyframeRefs: [first],
      summarizer: {
        summarize(prompt) {
          calls.push(prompt);
          return Promise.resolve(`summary ${String(calls.length)}`);
        },
      },
      tokenBudget: 2048,
    });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((prompt) => prompt.includes('Write a focused source summary for one file'))).toBe(true);
    expect(calls[0]).not.toContain('### README.md');
    expect(calls.join('\n')).toContain('File: README.md');
    expect(calls.join('\n')).toContain('File: src/store/TemporalStore.ts');
  });

  it('creates deterministic fixtures with valid source-span citations', async () => {
    const repo = createRepo();
    const first = commit(repo, 'initial architecture', { 'README.md': '# Demo\n\nInitial architecture\n' });
    const second = commit(repo, 'add persistence', { 'src/store.ts': 'export const persistence = true;\n' });
    const data = await deriveHistoryData({
      repoPath: repo,
      keyframeRefs: [first, second],
      summarizer: createDeterministicSummarizer(),
      tokenBudget: 2048,
    });

    const fixtures = createDeterministicFixtures(data, [...defaultQueryTexts(), 'custom repository question']);
    const parsed = parseExtraction(fixtures.fixtures['kf-2'] ?? '');
    const assertion = parsed.assertions[0];
    const citation = assertion?.citations[0];

    expect(assertion?.content).toContain('add persistence');
    expect(citation?.sourceRef).toBe('sources/kf-1..kf-2.md');
    expect(citation?.excerpt).toBeNull();
    expect(citation?.excerptStart).toMatch(/^\d+$/);
    expect(citation?.excerptEnd).toMatch(/^\d+$/);
    expect(Object.keys(fixtures.assertionEmbeddings).length).toBe(4);
    expect(Object.keys(fixtures.queryEmbeddings)).toEqual([...defaultQueryTexts(), 'custom repository question']);
  });

  it('rejects fixture providers for custom repo/keyframe options', async () => {
    const repo = createRepo();
    const first = commit(repo, 'initial architecture', { 'README.md': '# Demo\n' });
    const data = await deriveHistoryData({
      repoPath: repo,
      keyframeRefs: [first],
      summarizer: createDeterministicSummarizer(),
      tokenBudget: 2048,
    });
    const generated = createDeterministicFixtures(data);
    const providers = createFixtureProviders({
      ...generated,
      queryTexts: defaultQueryTexts(),
    });

    expect(() => {
      assertFixtureAllowedForOptions(
        {
          query: null,
          repo,
          keyframes: [first],
          repoProvided: true,
          keyframesProvided: true,
          rateLimitSeconds: null,
          warmup: false,
        },
        providers,
      );
    }).toThrow('Custom --repo and --keyframes runs require live');
  });

  it('derives distinct database paths for distinct run hashes', async () => {
    const repo = createRepo();
    const first = commit(repo, 'initial architecture', { 'README.md': '# Demo\n' });
    const data = await deriveHistoryData({
      repoPath: repo,
      keyframeRefs: [first],
      summarizer: createDeterministicSummarizer(),
      tokenBudget: 2048,
    });
    const generated = createDeterministicFixtures(data);
    const providers = createFixtureProviders({
      ...generated,
      queryTexts: defaultQueryTexts(),
    });
    const hashA = runHash({
      repoPath: data.repoPath,
      keyframes: data.keyframes,
      providers,
      queryTexts: defaultQueryTexts(),
    });
    const hashB = runHash({
      repoPath: data.repoPath,
      keyframes: data.keyframes,
      providers,
      queryTexts: [...defaultQueryTexts(), 'custom query'],
    });

    expect(hashA).not.toBe(hashB);
    expect(runtimeDatabasePath(hashA)).not.toBe(runtimeDatabasePath(hashB));
    expect(
      dataVersion({
        repoPath: data.repoPath,
        keyframes: data.keyframes,
        episodes: data.episodes,
        citationSources: data.citationSources,
        queryTexts: defaultQueryTexts(),
      }),
    ).toHaveLength(16);
  });

  it('drops supersedes targets that are not prior assertions', () => {
    const result = sanitizeRepositoryExtractionResult(
      {
        assertions: [
          {
            id: 'a-kf-2-0',
            namespace: 'repository-history',
            type: 'update',
            content: 'Current assertion',
            validFrom: 2,
            confidence: 0.9,
            sourceEpisodeId: 'kf-2',
            supersedesId: 'a-kf-2-1',
            entityId: null,
            entityType: null,
            citations: [
              {
                id: 'c-a-kf-2-0-0',
                episodeId: 'kf-2',
                sourceRef: 'sources/kf-1..kf-2.md',
                excerpt: 'Current assertion',
                excerptStart: '0',
                excerptEnd: '17',
              },
            ],
          },
          {
            id: 'a-kf-2-1',
            namespace: 'repository-history',
            type: 'update',
            content: 'Another current assertion',
            validFrom: 2,
            confidence: 0.9,
            sourceEpisodeId: 'kf-2',
            supersedesId: 'a-kf-1-0',
            entityId: null,
            entityType: null,
            citations: [
              {
                id: 'c-a-kf-2-1-0',
                episodeId: 'kf-2',
                sourceRef: 'sources/kf-1..kf-2.md',
                excerpt: 'Another current assertion',
                excerptStart: '0',
                excerptEnd: '25',
              },
            ],
          },
        ],
        links: [],
      },
      [
        {
          id: 'a-kf-1-0',
          namespace: 'repository-history',
          type: 'update',
          content: 'Prior assertion',
          validFrom: 1,
          validUntil: null,
          confidence: 0.9,
          sourceEpisodeId: 'kf-1',
          supersedesId: null,
          entityId: null,
          entityType: null,
          citations: [],
          extensions: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    );

    expect(result.assertions.map((assertion) => assertion.supersedesId)).toEqual([null, 'a-kf-1-0']);
  });

  it('reuses cached live source summaries', async () => {
    const repo = createRepo();
    const first = commit(repo, 'initial architecture', { 'README.md': '# Demo\n\nInitial architecture\n' });
    const cacheDir = mkdtempSync(join(tmpdir(), 'trageti-history-cache-'));
    tempDirs.push(cacheDir);
    let calls = 0;
    const extractor = {
      name: 'test-live',
      label: 'test-live',
      provenance: { kind: 'openai-compatible' as const, model: 'm', configHash: 'provider-a' },
      extract() {
        calls += 1;
        return Promise.resolve(`summary ${String(calls)}`);
      },
    };

    const firstRun = await deriveHistoryData({
      repoPath: repo,
      keyframeRefs: [first],
      summarizer: createCachedLiveSummarizer({ extractor, repoPath: repo, cacheDir }),
      mode: 'live',
      tokenBudget: 2048,
    });
    const secondRun = await deriveHistoryData({
      repoPath: repo,
      keyframeRefs: [first],
      summarizer: createCachedLiveSummarizer({ extractor, repoPath: repo, cacheDir }),
      mode: 'live',
      tokenBudget: 2048,
    });

    expect(calls).toBe(1);
    expect(secondRun.sourceSummaries).toEqual(firstRun.sourceSummaries);
    expect(
      dataVersion({
        repoPath: firstRun.repoPath,
        keyframes: firstRun.keyframes,
        episodes: firstRun.episodes,
        citationSources: firstRun.citationSources,
        queryTexts: defaultQueryTexts(),
      }),
    ).toBe(
      dataVersion({
        repoPath: secondRun.repoPath,
        keyframes: secondRun.keyframes,
        episodes: secondRun.episodes,
        citationSources: secondRun.citationSources,
        queryTexts: defaultQueryTexts(),
      }),
    );
  });

  it('changes cached source summary key when provider provenance changes', async () => {
    const repo = createRepo();
    const first = commit(repo, 'initial architecture', { 'README.md': '# Demo\n\nInitial architecture\n' });
    const cacheDir = mkdtempSync(join(tmpdir(), 'trageti-history-cache-'));
    tempDirs.push(cacheDir);
    let calls = 0;
    const extractor = (configHash: string) => ({
      name: 'test-live',
      label: 'test-live',
      provenance: { kind: 'openai-compatible' as const, model: 'm', configHash },
      extract() {
        calls += 1;
        return Promise.resolve(`summary ${String(calls)}`);
      },
    });

    await deriveHistoryData({
      repoPath: repo,
      keyframeRefs: [first],
      summarizer: createCachedLiveSummarizer({ extractor: extractor('provider-a'), repoPath: repo, cacheDir }),
      mode: 'live',
      tokenBudget: 2048,
    });
    await deriveHistoryData({
      repoPath: repo,
      keyframeRefs: [first],
      summarizer: createCachedLiveSummarizer({ extractor: extractor('provider-b'), repoPath: repo, cacheDir }),
      mode: 'live',
      tokenBudget: 2048,
    });

    expect(calls).toBe(2);
  });
});

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'trageti-history-test-'));
  tempDirs.push(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  return repo;
}

function commit(repo: string, message: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, { flag: 'w' });
  }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}
