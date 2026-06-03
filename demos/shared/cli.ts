import type { RetrievalQuery } from 'trageti';
import type { DemoEmbeddingProvider, ResolvedDemoProviders } from './providers.js';
import type { DemoRunLogger } from './runtime.js';

export interface DemoCliOptions {
  query: string | null;
  rateLimitSeconds: number | null;
  warmup: boolean;
}

export interface CustomQueryOptions {
  namespace: string;
  queryText: string;
  temporalAnchor: number;
}

export function isWarmupArg(arg: string): boolean {
  return arg === '--warmup';
}

export function parseDemoCliOptions(argv = process.argv): DemoCliOptions {
  let query: string | null = null;
  let rateLimitSeconds: number | null = null;
  let warmup = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (isWarmupArg(arg)) {
      warmup = true;
      continue;
    }
    if (arg === '--query') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--query requires a non-empty value');
      query = normalizeQueryArg(value);
      i += 1;
      continue;
    }
    if (arg.startsWith('--query=')) {
      query = normalizeQueryArg(arg.slice('--query='.length));
      continue;
    }
    if (arg === '--limit') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--limit requires a non-negative number');
      rateLimitSeconds = normalizeLimitArg(value);
      i += 1;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      rateLimitSeconds = normalizeLimitArg(arg.slice('--limit='.length));
    }
  }
  return { query, rateLimitSeconds, warmup };
}

export function envWithDemoRateLimit(env: NodeJS.ProcessEnv, rateLimitSeconds: number | null): NodeJS.ProcessEnv {
  if (rateLimitSeconds === null) return env;
  return { ...env, DEMO_RATE_LIMIT: String(rateLimitSeconds) };
}

export function assertCustomQuerySupported(embedder: DemoEmbeddingProvider): void {
  if (embedder.provenance.kind !== 'fixture') return;
  throw new Error(
    'Custom --query is not supported in deterministic fixture/raw-vector mode because committed fixture vectors only cover the built-in demo queries.\n' +
      'Configure a live embedding provider with DEMO_EMBED_PROVIDER and its required model/base URL/key settings, then rerun the demo.',
  );
}

export function buildCustomRetrievalQuery(options: CustomQueryOptions): RetrievalQuery {
  return {
    namespace: options.namespace,
    queryText: options.queryText,
    temporalAnchor: options.temporalAnchor,
    retrievalStrategy: 'hybrid',
    mode: 'snapshot',
    expandLinks: true,
    maxDepth: 1,
    limit: 25,
  };
}

export async function warmupDemoProviders(options: {
  providers: ResolvedDemoProviders;
  logger: DemoRunLogger;
}): Promise<void> {
  const { providers, logger } = options;
  logger.step('Warming live providers');
  if (providers.extractor.provenance.kind === 'fixture') {
    logger.detail('Extraction warmup skipped for fixture provider');
  } else {
    const started = performance.now();
    await providers.extractor.extract('Warm up. Reply with: ok');
    logger.success(`Extraction provider warmed (${(performance.now() - started).toFixed(1)} ms)`);
  }

  if (providers.embedder.provenance.kind === 'fixture') {
    logger.detail('Embedding warmup skipped for fixture provider');
  } else {
    const started = performance.now();
    await providers.embedder.provider.embed(['warmup']);
    logger.success(`Embedding provider warmed (${(performance.now() - started).toFixed(1)} ms)`);
  }
}

function normalizeQueryArg(value: string): string {
  const query = value.trim();
  if (!query) throw new Error('--query requires a non-empty value');
  return query;
}

function normalizeLimitArg(value: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!trimmed || !Number.isFinite(parsed) || parsed < 0) throw new Error('--limit requires a non-negative number');
  return parsed;
}
