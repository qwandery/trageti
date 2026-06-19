// Terminal output for the demo runners. Keep flow logging and query rendering
// here so both demos explain trageti behavior consistently.

import { clearLine, cursorTo } from 'node:readline';
import type {
  Assertion,
  AssertionLink,
  RetrievalMeta,
  RetrievalQuery,
  RetrievalResult,
  RetrievedAssertion,
  NewEpisodeInput,
} from 'trageti';
import type { DemoRunLogger } from './runtime.js';
import type { LlmTraceOptions, ResolvedDemoProviders } from './providers.js';
import type { SynthesisResult } from './synthesis.js';
import { sanitizeForTerminal } from './sanitize.js';

const RULE = '-'.repeat(72);
const OUTPUT_STARTED_AT = performance.now();

interface RelevanceDisplayOptions {
  minResults: number;
  maxResults: number;
  relativeToBest: number;
  maxDropFromBest: number;
}

const DEFAULT_RELEVANCE_OPTIONS: RelevanceDisplayOptions = {
  minResults: 3,
  maxResults: 12,
  relativeToBest: 0.72,
  maxDropFromBest: 0.22,
};

export interface DemoTimeline {
  byPosition: ReadonlyMap<number, NewEpisodeInput>;
  byEpisodeId: ReadonlyMap<string, NewEpisodeInput>;
}

export function createDemoTimeline(episodes: readonly NewEpisodeInput[]): DemoTimeline {
  return {
    byPosition: new Map(episodes.map((episode) => [episode.position, episode])),
    byEpisodeId: new Map(episodes.map((episode) => [episode.id, episode])),
  };
}

export function printBanner(title: string): void {
  console.log(RULE);
  console.log(title);
  console.log(RULE);
}

export function createDemoLogger(): DemoRunLogger {
  let stepNumber = 0;
  return {
    step(message) {
      stepNumber += 1;
      console.log('');
      console.log(`${runPrefix()} [${String(stepNumber)}] ${message}`);
    },
    detail(message) {
      console.log(`    ${runPrefix()} ${message}`);
    },
    success(message) {
      console.log(`    ${runPrefix()} OK ${message}`);
    },
  };
}

export function createLlmTraceOptions(argv = process.argv, env: NodeJS.ProcessEnv = process.env): LlmTraceOptions {
  const arg = argv.find(
    (value) => value === '--llm-trace' || value === '--llm-trace-full' || value.startsWith('--llm-trace='),
  );
  const raw =
    arg === '--llm-trace-full'
      ? 'full'
      : arg?.includes('=')
        ? arg.split('=')[1]
        : arg
          ? 'summary'
          : env['DEMO_LLM_TRACE'];
  const normalized = raw?.toLowerCase();
  const rawVectors = env['DEMO_LLM_TRACE_RAW_VECTORS']?.toLowerCase();
  let statusLength = 0;
  const clearStatus = (): void => {
    if (statusLength === 0) return;
    if (process.stdout.isTTY) {
      cursorTo(process.stdout, 0);
      clearLine(process.stdout, 0);
    } else {
      process.stdout.write(`\r${' '.repeat(statusLength)}\r`);
    }
    statusLength = 0;
  };
  return {
    enabled: normalized === '1' || normalized === 'true' || normalized === 'summary' || normalized === 'full',
    includePayloads: normalized === 'full',
    includeRawVectors: rawVectors === '1' || rawVectors === 'true' || rawVectors === 'full',
    log(message) {
      clearStatus();
      console.log('');
      console.log(`[LLM ${runPrefix()}]`);
      console.log(
        message
          .split('\n')
          .map((line) => `  ${sanitizeForTerminal(line)}`)
          .join('\n'),
      );
    },
    append(message) {
      process.stdout.write(sanitizeStreamText(message));
    },
    status(message) {
      const rendered = fitStatusLine(sanitizeForTerminal(`[LLM ${runPrefix()}] ${message}`));
      const padding = statusLength > rendered.length ? ' '.repeat(statusLength - rendered.length) : '';
      if (process.stdout.isTTY) {
        cursorTo(process.stdout, 0);
        clearLine(process.stdout, 0);
        process.stdout.write(rendered);
      } else {
        process.stdout.write(`\r${rendered}${padding}`);
      }
      statusLength = rendered.length;
    },
  };
}

function fitStatusLine(value: string): string {
  const columns = process.stdout.columns ?? 100;
  const max = Math.max(40, columns - 1);
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function sanitizeStreamText(value: string): string {
  return sanitizeForTerminal(value).replace(/\r/g, '');
}

function runPrefix(): string {
  return `[${formatWallTime(new Date())} +${formatElapsed(performance.now() - OUTPUT_STARTED_AT)}]`;
}

function formatWallTime(value: Date): string {
  const hours = value.getHours().toString().padStart(2, '0');
  const minutes = value.getMinutes().toString().padStart(2, '0');
  const seconds = value.getSeconds().toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatElapsed(ms: number): string {
  const totalTenths = Math.max(0, Math.floor(ms / 100));
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) {
    return `${String(hours)}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${String(
      tenths,
    )}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${String(tenths)}`;
}

export function printProviderSummary(options: {
  modeLabel: string;
  namespace: string;
  database: string;
  extractionLabel: string;
  embeddingLabel: string;
  embeddingDimension: number;
  rateLimitSeconds?: number | null;
}): void {
  console.log('');
  console.log('Run configuration');
  console.log(`  Mode: ${options.modeLabel}`);
  console.log(`  Namespace: ${options.namespace}`);
  console.log(`  SQLite DB: ${options.database}`);
  console.log(`  Extraction provider: ${options.extractionLabel}`);
  console.log(`  Embedding provider: ${options.embeddingLabel}`);
  console.log(`  Embedding dimension: ${String(options.embeddingDimension)}`);
  if (options.rateLimitSeconds !== undefined && options.rateLimitSeconds !== null) {
    console.log(`  Live provider rate limit: 1 request per ${String(options.rateLimitSeconds)}s`);
  } else if (process.env['DEMO_RATE_LIMIT']) {
    console.log(`  Live provider rate limit: 1 request per ${process.env['DEMO_RATE_LIMIT']}s`);
  } else {
    console.log('  Live provider rate limit: 1 request per 5s');
  }
  console.log(
    '  LLM trace: --llm-trace or DEMO_LLM_TRACE=summary shows call timing; DEMO_LLM_TRACE=full shows prompts and raw responses',
  );
}

export function printResolvedProviderSummary(options: {
  providers: ResolvedDemoProviders;
  namespace: string;
  database: string;
  rateLimitSeconds?: number | null;
}): void {
  const summary = {
    modeLabel: options.providers.modeLabel,
    namespace: options.namespace,
    database: options.database,
    extractionLabel: options.providers.extractor.label,
    embeddingLabel: options.providers.embedder.label,
    embeddingDimension: options.providers.embedder.provider.dimension,
  };
  printProviderSummary(
    options.rateLimitSeconds === undefined ? summary : { ...summary, rateLimitSeconds: options.rateLimitSeconds },
  );
}

export function printRetrievalResult(
  annotation: string,
  query: RetrievalQuery,
  result: RetrievalResult,
  timeline?: DemoTimeline,
  options?: {
    headerPrinted?: boolean;
    order?: 'ranked' | 'temporal';
    relevance?: Partial<RelevanceDisplayOptions>;
  },
): void {
  if (!options?.headerPrinted) printQueryHeader(annotation, query, result.meta, timeline);
  else printRetrievalMeta(result.meta);
  if (result.results.length === 0) {
    console.log('  No matching assertions returned.');
    return;
  }
  const selected = selectRelevantResults(result.results, options?.relevance);
  const ordered = options?.order === 'temporal' ? orderByTimeThenRank(selected.results) : selected.results;
  printRelevanceSummary(result.results.length, selected, options?.order ?? 'ranked');
  let currentPosition: number | null = null;
  for (const [i, r] of ordered.entries()) {
    if (options?.order === 'temporal' && r.validFrom !== currentPosition) {
      currentPosition = r.validFrom;
      console.log('');
      console.log(`  ${formatPosition(r.validFrom, timeline)}`);
    }
    printAssertion(r, i, timeline);
  }
}

export function printQueryPlan(annotation: string, query: RetrievalQuery, timeline?: DemoTimeline): void {
  console.log('');
  console.log(RULE);
  console.log(`Query ${sanitizeForTerminal(annotation)}`);
  console.log(RULE);
  console.log(`  Text: ${sanitizeForTerminal(query.queryText ?? '(query embedding only)')}`);
  console.log(`  Namespace: ${query.namespace}`);
  console.log(`  Time view: ${describePlannedTemporalScope(query, timeline)}; mode=${query.mode ?? 'snapshot'}`);
  const plannedLimit = query.limit === undefined ? 'default result cap' : `up to ${String(query.limit)} ranked results`;
  console.log(`  Retrieval plan: ${query.retrievalStrategy ?? 'hybrid'}; ` + plannedLimit);
}

export function printQueryHeader(
  annotation: string,
  query: RetrievalQuery,
  meta: RetrievalMeta,
  timeline?: DemoTimeline,
): void {
  console.log('');
  console.log(RULE);
  console.log(`Query ${sanitizeForTerminal(annotation)}`);
  console.log(RULE);
  console.log(`  Text: ${sanitizeForTerminal(query.queryText ?? '(query embedding only)')}`);
  console.log(`  Namespace: ${meta.namespace}`);
  console.log(`  Time view: ${describeTemporalScope(query, meta, timeline)}; mode=${query.mode ?? 'snapshot'}`);
  printRetrievalMeta(meta);
}

function printRetrievalMeta(meta: RetrievalMeta): void {
  console.log(
    `  Retrieval: ${meta.retrievalStrategy}; vector ${applied(meta.vectorApplied)}, ` +
      `BM25 ${applied(meta.bm25Applied)}; ${String(meta.candidateCount)} candidates, ` +
      `result cap ${String(meta.limit)}`,
  );
  if (meta.queryTextMode) console.log(`  Text search mode: ${meta.queryTextMode}`);
  if (meta.tookMs !== undefined) console.log(`  Runtime: ${meta.tookMs.toFixed(1)} ms`);
  if (meta.warnings.length > 0) {
    for (const warning of meta.warnings) {
      console.log(`  Warning: ${warning.code} - ${sanitizeForTerminal(warning.message)}`);
    }
  }
}

function selectRelevantResults(
  results: readonly RetrievedAssertion[],
  options?: Partial<RelevanceDisplayOptions>,
): {
  results: RetrievedAssertion[];
  hiddenCount: number;
  threshold: number;
  bestScore: number;
} {
  const config = { ...DEFAULT_RELEVANCE_OPTIONS, ...options };
  if (results.length === 0) {
    return { results: [], hiddenCount: 0, threshold: 0, bestScore: 0 };
  }
  const ranked = [...results].sort((a, b) => b.score - a.score);
  const bestScore = ranked[0]?.score ?? 0;
  const relativeFloor = bestScore * config.relativeToBest;
  const dropFloor = bestScore - config.maxDropFromBest;
  const threshold = Math.max(relativeFloor, dropFloor);
  const selected = ranked
    .filter((result, index) => {
      if (index < config.minResults) return true;
      return result.score >= threshold;
    })
    .slice(0, config.maxResults);
  return {
    results: selected,
    hiddenCount: Math.max(0, results.length - selected.length),
    threshold,
    bestScore,
  };
}

function orderByTimeThenRank(results: readonly RetrievedAssertion[]): RetrievedAssertion[] {
  return [...results].sort((a, b) => {
    if (a.validFrom !== b.validFrom) return a.validFrom - b.validFrom;
    return b.score - a.score;
  });
}

function printRelevanceSummary(
  retrievedCount: number,
  selected: ReturnType<typeof selectRelevantResults>,
  order: 'ranked' | 'temporal',
): void {
  console.log(
    `  Showing ${String(selected.results.length)} of ${String(retrievedCount)} retrieved assertion(s): ` +
      `kept results near the best score (${selected.bestScore.toFixed(3)}; cutoff ${selected.threshold.toFixed(3)}).`,
  );
  console.log(
    order === 'temporal'
      ? '  Display order: time first, then rank within the same time.'
      : '  Display order: rank first.',
  );
  if (selected.hiddenCount > 0) {
    console.log(`  Hidden: ${String(selected.hiddenCount)} lower-ranked result(s) below the demo relevance cutoff.`);
  }
}

export function printAssertion(a: RetrievedAssertion, index: number, timeline?: DemoTimeline): void {
  console.log('');
  console.log(`  Result ${String(index + 1)}: ${sanitizeForTerminal(a.content)}`);
  console.log(`    Time: ${describeAssertionValidity(a, timeline)}`);
  console.log(
    `    Source: ${describeEpisode(a.sourceEpisodeId, timeline)}; ` +
      `${a.type}, confidence ${a.confidence.toFixed(2)}`,
  );
  console.log(`    Rank: ${a.score.toFixed(3)} (${describeRankingSignals(a)})`);
  for (const citation of a.citations.slice(0, 2)) {
    if (citation.excerpt) {
      console.log(
        `    Citation (${sanitizeForTerminal(citation.sourceRef)}): "${truncate(sanitizeForTerminal(citation.excerpt), 120)}"`,
      );
    } else {
      console.log(`    Citation (${citation.sourceRef}): no excerpt recorded`);
    }
  }
  if (a.supersedesId) console.log('    Supersedes an earlier stored claim.');
  if (a.entityId) {
    console.log(`    Entity: ${a.entityId}${a.entityType ? ` (${a.entityType})` : ''}`);
  }
  if (a.linkedAssertions && a.linkedAssertions.length > 0) {
    console.log('    Linked assertions:');
    for (const linked of a.linkedAssertions) {
      console.log(`      - ${truncate(sanitizeForTerminal(linked.content), 100)}`);
    }
  }
  if (a.supersessionChain && a.supersessionChain.length > 0) {
    console.log('    Earlier versions:');
    for (const prior of a.supersessionChain) {
      console.log(
        `      - ${formatPosition(prior.validFrom, timeline)}: ${truncate(sanitizeForTerminal(prior.content), 100)}`,
      );
    }
  }
}

export function printSnapshot(
  title: string,
  assertions: readonly Assertion[],
  options?: { emptyMessage?: string; timeline?: DemoTimeline },
): void {
  console.log('');
  console.log(RULE);
  console.log(title);
  console.log(RULE);
  if (assertions.length === 0) {
    console.log(`  ${options?.emptyMessage ?? 'No assertions matched this request.'}`);
    return;
  }
  for (const [i, a] of assertions.entries()) {
    console.log('');
    console.log(`  Snapshot item ${String(i + 1)}: ${truncate(sanitizeForTerminal(a.content), 120)}`);
    console.log(`    Time: ${describeAssertionValidity(a, options?.timeline)}`);
    console.log(
      `    Source: ${describeEpisode(a.sourceEpisodeId, options?.timeline)}; ` +
        `${a.type}, confidence ${a.confidence.toFixed(2)}`,
    );
  }
}

export function printPathHops(
  title: string,
  links: readonly AssertionLink[],
  options?: {
    fromAssertionId?: string;
    toAssertionId?: string;
    temporalAnchor?: number;
    maxDepth?: number;
    liveMode?: boolean;
    timeline?: DemoTimeline;
    staleFixtureAdvice?: boolean;
  },
): void {
  console.log('');
  console.log(RULE);
  console.log(title);
  console.log(RULE);
  if (links.length === 0) {
    console.log('  No graph path was returned.');
    console.log(
      '  This query does not run semantic search. It asks SQLite for stored typed links that connect two known assertions.',
    );
    if (options?.fromAssertionId && options.toAssertionId) {
      console.log(
        `  Requested path: ${options.fromAssertionId} -> ${options.toAssertionId}` +
          (options.maxDepth === undefined ? '' : ` within ${String(options.maxDepth)} hop(s)`) +
          `${
            options.temporalAnchor === undefined
              ? ''
              : ` at ${formatPosition(options.temporalAnchor, options.timeline)}`
          }.`,
      );
    }
    console.log('  Meaning: the current DB does not contain active stored links connecting those assertion IDs.');
    if (options?.liveMode) {
      console.log(
        '  The live extraction stored both endpoint claims, but it did not store an active typed link connecting them.',
      );
    }
    if (options?.staleFixtureAdvice) {
      console.log('  If this fixture DB predates the current fixtures, delete demos/.local/alex-place.db and rerun.');
    }
    return;
  }
  console.log('  Typed assertion-link path:');
  for (const [i, l] of links.entries()) {
    console.log('');
    console.log(`  Hop ${String(i + 1)}: ${l.linkType}`);
    console.log(
      `    Time: valid from ${formatPosition(l.validFrom, options?.timeline)}` +
        (l.validUntil === null ? '; active' : ` until ${formatPosition(l.validUntil, options?.timeline)}`),
    );
    console.log(`    Source: ${describeEpisode(l.sourceEpisodeId, options?.timeline)}`);
  }
}

export function printNarrative(text: string): void {
  console.log('');
  console.log(RULE);
  console.log('Assembled-context narrative synthesis');
  console.log(RULE);
  console.log('  ' + sanitizeForTerminal(text).split('\n').join('\n  '));
}

export function printAssembledAnswer(answer: SynthesisResult): void {
  console.log('');
  console.log('  Assembled-context answer');
  console.log(
    `  Context: ${String(answer.context.includedAssertions)} of ${String(answer.context.totalAssertions)} assertion(s), ` +
      `${String(answer.context.tokenEstimate)} estimated token(s), ` +
      `positions ${String(answer.context.positionRange.from)}..${String(answer.context.positionRange.to)}, ` +
      `${answer.context.truncated ? 'truncated' : 'not truncated'}, ${answer.mode} synthesis.`,
  );
  console.log('  ' + sanitizeForTerminal(answer.text).split('\n').join('\n  '));
}

function describePlannedTemporalScope(query: RetrievalQuery, timeline?: DemoTimeline): string {
  const anchor = query.temporalAnchor ?? 'latest';
  const anchorLabel = typeof anchor === 'number' ? formatPosition(anchor, timeline) : String(anchor);
  const window = query.temporalWindow;
  if (!window) return anchorLabel;
  const from = window.from === undefined ? 'the beginning' : formatPosition(window.from, timeline);
  const to = window.to === undefined ? 'now' : formatPosition(window.to, timeline);
  return `${anchorLabel}, window ${from}..${to}`;
}

function describeTemporalScope(query: RetrievalQuery, meta: RetrievalMeta, timeline?: DemoTimeline): string {
  const window = query.temporalWindow;
  if (window) {
    const from = window.from === undefined ? 'the beginning' : formatPosition(window.from, timeline);
    const to = window.to === undefined ? 'now' : formatPosition(window.to, timeline);
    return `${formatPosition(meta.temporalAnchor, timeline)}, window ${from}..${to}`;
  }
  return formatPosition(meta.temporalAnchor, timeline);
}

function describeAssertionValidity(a: Assertion, timeline?: DemoTimeline): string {
  return (
    `valid from ${formatPosition(a.validFrom, timeline)}` +
    (a.validUntil === null ? '; active at the query time' : ` until ${formatPosition(a.validUntil, timeline)}`)
  );
}

function describeEpisode(episodeId: string, timeline?: DemoTimeline): string {
  const episode = timeline?.byEpisodeId.get(episodeId);
  if (!episode) return episodeId;
  return `${formatDateTime(episode.occurredAt)} ${episode.type} episode`;
}

function formatPosition(position: number, timeline?: DemoTimeline): string {
  const episode = timeline?.byPosition.get(position);
  if (!episode) return `position ${String(position)}`;
  return formatDateTime(episode.occurredAt);
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

function applied(value: boolean): string {
  return value ? 'on' : 'off';
}

function describeRankingSignals(a: RetrievedAssertion): string {
  const semantic = a.scoreComponents.semanticDistance;
  const bm25 = a.scoreComponents.bm25Score;
  const parts = [
    semantic === null ? 'semantic unused' : `semantic distance ${semantic.toFixed(3)}`,
    bm25 === null ? 'BM25 unused' : `BM25 ${bm25.toFixed(3)}`,
    `position signal ${String(a.scoreComponents.position)}`,
  ];
  return parts.join('; ');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '...';
}
