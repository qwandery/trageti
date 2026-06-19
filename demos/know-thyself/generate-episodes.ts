// Build reviewable know-thyself source documents from a git repo/keyframe set.
// Runtime no longer depends on committed source docs, but this remains useful
// for inspecting the generated citation-grade source bundles.
//
// Usage:
//   npx tsx demos/know-thyself/generate-episodes.ts [--repo PATH] [--keyframes a,b,c] [--context-length N]

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createLlmTraceOptions } from '../shared/output.js';
import { hasConfiguredLiveDemoProvider, resolveLiveExtractionProvider } from '../shared/providers.js';
import {
  createDeterministicSummarizer,
  createLiveSummarizer,
  deriveHistoryData,
  parseKnowThyselfCliOptions,
  writeReviewSources,
} from './history.js';

async function main(): Promise<void> {
  const cli = parseKnowThyselfCliOptions();
  const tokenArg = process.argv.indexOf('--context-length');
  const tokenBudget = tokenArg >= 0 ? Number(process.argv[tokenArg + 1]) || 8192 : 8192;
  const trace = createLlmTraceOptions();
  const hasLive = hasLiveProviderHints(process.env);
  const summarizer = hasLive
    ? createLiveSummarizer(resolveLiveExtractionProvider({ trace }))
    : createDeterministicSummarizer();

  const data = await deriveHistoryData({
    repoPath: cli.repo,
    keyframeRefs: cli.keyframes,
    summarizer,
    tokenBudget,
  });
  const outputDir = join('demos', '.local', 'know-thyself', 'sources', reviewHash(data.repoPath, cli.keyframes));
  writeReviewSources(data, outputDir);

  console.log(`wrote source documents to ${outputDir}`);
  console.log('episodes:', JSON.stringify(data.episodes, null, 2));
  console.log('source summaries:', JSON.stringify(data.sourceSummaries, null, 2));
}

function reviewHash(repoPath: string, keyframes: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ repoPath, keyframes })).digest('hex').slice(0, 12);
}

function hasLiveProviderHints(env: NodeJS.ProcessEnv): boolean {
  return (
    Boolean(env['DEMO_EXTRACT_PROVIDER'] ?? env['OLLAMA_HOST'] ?? env['DEMO_EXTRACT_BASE_URL']) ||
    hasConfiguredLiveDemoProvider(['extract'], env)
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
