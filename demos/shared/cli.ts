import type { RetrievalQuery } from 'trageti';
import type { DemoEmbeddingProvider } from './providers.js';

export interface DemoCliOptions {
  query: string | null;
}

export interface CustomQueryOptions {
  namespace: string;
  queryText: string;
  temporalAnchor: number;
}

export function parseDemoCliOptions(argv = process.argv): DemoCliOptions {
  let query: string | null = null;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--query') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--query requires a non-empty value');
      query = normalizeQueryArg(value);
      i += 1;
      continue;
    }
    if (arg.startsWith('--query=')) {
      query = normalizeQueryArg(arg.slice('--query='.length));
    }
  }
  return { query };
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

function normalizeQueryArg(value: string): string {
  const query = value.trim();
  if (!query) throw new Error('--query requires a non-empty value');
  return query;
}
