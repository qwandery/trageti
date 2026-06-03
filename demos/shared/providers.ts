import { createHash } from 'node:crypto';
import type { EmbeddingProvider, EmbedOptions } from 'trageti';
import { RawVectorProvider } from 'trageti';
import { parseExtraction } from './parse.js';

export type ProviderKind = 'fixture' | 'anthropic' | 'openai-compatible' | 'ollama-native';

export interface ProviderProvenance {
  kind: ProviderKind;
  model?: string;
  baseUrl?: string;
  dimension?: number;
  configHash: string;
}

export interface ExtractionProvider {
  name: string;
  label: string;
  provenance: ProviderProvenance;
  extract(prompt: string, options?: { episodeId?: string }): Promise<string>;
}

export interface DemoEmbeddingProvider {
  name: string;
  label: string;
  provenance: ProviderProvenance;
  provider: EmbeddingProvider;
}

export interface ResolvedDemoProviders {
  modeLabel: string;
  isLive: boolean;
  extractor: ExtractionProvider;
  embedder: DemoEmbeddingProvider;
  provenance: {
    extraction: ProviderProvenance;
    embedding: ProviderProvenance;
  };
}

export interface LlmTraceOptions {
  enabled: boolean;
  includePayloads: boolean;
  includeRawVectors: boolean;
  log(message: string): void;
}

export interface ProviderRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  rateLimitMs: number;
  traceTimings?: boolean;
  log?(message: string): void;
}

class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

export interface ResolveDemoProvidersOptions {
  fixtures: Record<string, string>;
  assertionEmbeddings: Record<string, number[]>;
  queryEmbeddings: Record<string, number[]>;
  queryTexts: readonly string[];
  embeddingDimension: number;
  env?: NodeJS.ProcessEnv;
  trace?: LlmTraceOptions;
}

export interface ResolveLiveProvidersOptions {
  embeddingDimension: number;
  env?: NodeJS.ProcessEnv;
  trace?: LlmTraceOptions;
}

export function createFixtureExtractionProvider(fixtures: Record<string, string>): ExtractionProvider {
  return {
    name: 'fixture',
    label: 'fixture',
    provenance: provenance({ kind: 'fixture', model: 'committed-fixtures' }),
    extract(_prompt, options) {
      const episodeId = options?.episodeId;
      if (!episodeId) return Promise.reject(new Error('fixture extractor requires episodeId'));
      const value = fixtures[episodeId];
      if (value === undefined) {
        return Promise.reject(new Error(`fixture extractor missing fixture for ${episodeId}`));
      }
      return Promise.resolve(value);
    },
  };
}

export function createRawVectorEmbeddingProvider(options: {
  fixtures: Record<string, string>;
  assertionEmbeddings: Record<string, number[]>;
  queryEmbeddings: Record<string, number[]>;
  queryTexts: readonly string[];
  dimension: number;
}): DemoEmbeddingProvider {
  const provider = new RawVectorProvider(options.dimension);
  for (const episodeId of Object.keys(options.fixtures)) {
    const raw = options.fixtures[episodeId];
    if (raw === undefined) throw new Error(`fixture missing for episode ${episodeId}`);
    for (const a of parseExtraction(raw).assertions) {
      const vec = options.assertionEmbeddings[a.id];
      if (!vec) throw new Error(`missing assertion embedding: ${a.id}`);
      provider.set(a.content, vec);
    }
  }
  for (const text of options.queryTexts) {
    const vec = options.queryEmbeddings[text];
    if (!vec) throw new Error(`missing query embedding: ${text}`);
    provider.set(text, vec);
  }
  return {
    name: provider.name,
    label: 'fixture / raw-vector',
    provenance: provenance({ kind: 'fixture', model: 'committed-vectors', dimension: options.dimension }),
    provider,
  };
}

export function createAnthropicExtractionProvider(
  apiKey: string,
  model = 'claude-sonnet-4-20250514',
  retry?: ProviderRetryOptions,
): ExtractionProvider {
  const label = `anthropic:${model}`;
  return {
    name: 'anthropic',
    label,
    provenance: provenance({ kind: 'anthropic', model }),
    async extract(prompt) {
      return withProviderRetry(retry, `${label} extraction`, async () => {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const data = await readJsonResponse(response, 'Anthropic extraction');
        const text = dataValue(data, ['content', 0, 'text']);
        if (typeof text !== 'string') throw new Error('Anthropic extraction response missing content[0].text');
        return text;
      });
    },
  };
}

export function createOpenAICompatibleExtractionProvider(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  label?: string;
  retry?: ProviderRetryOptions;
}): ExtractionProvider {
  const label = options.label ?? `openai-compatible:${options.model}`;
  return {
    name: 'openai-compatible',
    label,
    provenance: provenance({ kind: 'openai-compatible', model: options.model, baseUrl: options.baseUrl }),
    async extract(prompt) {
      return withProviderRetry(options.retry, `${label} extraction`, async () => {
        const response = await fetch(`${trimSlash(options.baseUrl)}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
          }),
        });
        const data = await readJsonResponse(response, `${options.label ?? 'OpenAI-compatible'} extraction`);
        const content = dataValue(data, ['choices', 0, 'message', 'content']);
        if (typeof content !== 'string')
          throw new Error('OpenAI-compatible extraction response missing choices[0].message.content');
        return content;
      });
    },
  };
}

export function createOpenAICompatibleEmbeddingProvider(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimension: number;
  label?: string;
  retry?: ProviderRetryOptions;
}): DemoEmbeddingProvider {
  const label = options.label ?? `openai-compatible:${options.model}`;
  const provider: EmbeddingProvider = {
    name: options.label ?? 'openai-compatible',
    dimension: options.dimension,
    async embed(texts: readonly string[], embedOptions?: EmbedOptions): Promise<Float32Array[]> {
      return withProviderRetry(options.retry, `${label} embedding`, async () => {
        const url = `${trimSlash(options.baseUrl)}/embeddings`;
        const started = performance.now();
        traceProviderTiming(
          options.retry,
          `${label} embedding HTTP request -> ${url} (${String(texts.length)} text(s), requested dimension ${String(
            options.dimension,
          )})`,
        );
        const response = await fetch(`${trimSlash(options.baseUrl)}/embeddings`, {
          method: 'POST',
          ...(embedOptions?.signal ? { signal: embedOptions.signal } : {}),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            input: texts,
            dimensions: options.dimension,
          }),
        });
        const receivedAt = performance.now();
        traceProviderTiming(
          options.retry,
          `${label} embedding HTTP response <- ${String(response.status)} ${response.statusText} (${(
            receivedAt - started
          ).toFixed(1)} ms)`,
        );
        const data = await readJsonResponse(response, `${options.label ?? 'OpenAI-compatible'} embedding`);
        const parsedAt = performance.now();
        traceProviderTiming(options.retry, `${label} embedding JSON parsed (${(parsedAt - receivedAt).toFixed(1)} ms)`);
        const rows = dataValue(data, ['data']);
        if (!Array.isArray(rows)) throw new Error('OpenAI-compatible embedding response missing data[]');
        const vectors = rows.map((row, i) => {
          const embedding = dataValue(row, ['embedding']);
          if (!Array.isArray(embedding))
            throw new Error(`OpenAI-compatible embedding response missing data[${String(i)}].embedding`);
          return new Float32Array(embedding as number[]);
        });
        traceProviderTiming(
          options.retry,
          `${label} embedding vectors decoded: ${String(vectors.length)} vector(s), ${String(
            vectors[0]?.length ?? 0,
          )} dimension(s)`,
        );
        return vectors;
      });
    },
  };
  return {
    name: provider.name,
    label: options.label ?? `openai-compatible:${options.model}`,
    provenance: provenance({
      kind: 'openai-compatible',
      model: options.model,
      baseUrl: options.baseUrl,
      dimension: options.dimension,
    }),
    provider,
  };
}

export function createOllamaNativeEmbeddingProvider(options: {
  host: string;
  model: string;
  dimension: number;
  retry?: ProviderRetryOptions;
}): DemoEmbeddingProvider {
  const provider: EmbeddingProvider = {
    name: 'ollama-native',
    dimension: options.dimension,
    async embed(texts: readonly string[], embedOptions?: EmbedOptions): Promise<Float32Array[]> {
      traceProviderTiming(
        options.retry,
        `ollama-native:${options.model} embedding will call /api/embeddings once per text (${String(
          texts.length,
        )} request(s))`,
      );
      return Promise.all(
        texts.map(async (text, index) => {
          return withProviderRetry(options.retry, `ollama-native:${options.model} embedding`, async () => {
            const url = `${trimSlash(options.host)}/api/embeddings`;
            const started = performance.now();
            traceProviderTiming(
              options.retry,
              `ollama-native:${options.model} embedding HTTP request ${String(index + 1)}/${String(
                texts.length,
              )} -> ${url}`,
            );
            const response = await fetch(url, {
              method: 'POST',
              ...(embedOptions?.signal ? { signal: embedOptions.signal } : {}),
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: options.model, prompt: text }),
            });
            const receivedAt = performance.now();
            traceProviderTiming(
              options.retry,
              `ollama-native:${options.model} embedding HTTP response ${String(index + 1)}/${String(
                texts.length,
              )} <- ${String(response.status)} ${response.statusText} (${(receivedAt - started).toFixed(1)} ms)`,
            );
            const data = await readJsonResponse(response, 'Ollama native embedding');
            const parsedAt = performance.now();
            traceProviderTiming(
              options.retry,
              `ollama-native:${options.model} embedding JSON parsed ${String(index + 1)}/${String(texts.length)} (${(
                parsedAt - receivedAt
              ).toFixed(1)} ms)`,
            );
            const embedding = dataValue(data, ['embedding']);
            if (!Array.isArray(embedding)) throw new Error('Ollama native embedding response missing embedding');
            const vector = new Float32Array(embedding as number[]);
            traceProviderTiming(
              options.retry,
              `ollama-native:${options.model} embedding vector decoded ${String(index + 1)}/${String(
                texts.length,
              )}: ${String(vector.length)} dimension(s)`,
            );
            return vector;
          });
        }),
      );
    },
  };
  return {
    name: provider.name,
    label: `ollama-native:${options.model}`,
    provenance: provenance({
      kind: 'ollama-native',
      model: options.model,
      baseUrl: options.host,
      dimension: options.dimension,
    }),
    provider,
  };
}

export function resolveDemoProviders(options: ResolveDemoProvidersOptions): ResolvedDemoProviders {
  const env = options.env ?? process.env;
  const retry = retryOptionsFromEnv(env, options.trace);
  const explicitExtract = env['DEMO_EXTRACT_PROVIDER'];
  const explicitEmbed = env['DEMO_EMBED_PROVIDER'];
  const hasAnyLiveHint = Boolean(
    explicitExtract ??
    explicitEmbed ??
    env['ANTHROPIC_API_KEY'] ??
    env['OPENAI_API_KEY'] ??
    env['OPENROUTER_API_KEY'] ??
    env['OLLAMA_HOST'] ??
    env['DEMO_EXTRACT_BASE_URL'] ??
    env['DEMO_EMBED_BASE_URL'],
  );

  const extractProvider = explicitExtract ?? inferExtractionProvider(env, hasAnyLiveHint);
  const embedProvider = explicitEmbed ?? inferEmbeddingProvider(env, hasAnyLiveHint);

  if (extractProvider !== 'fixture' && embedProvider === 'fixture') {
    throw new Error(
      'Live extraction requires a live embedding provider.\n' +
        'Set DEMO_EMBED_PROVIDER with its required config (DEMO_EMBED_BASE_URL, DEMO_EMBED_MODEL, key),\n' +
        'or unset the live extraction config to run in fixture mode.',
    );
  }

  let extractor =
    extractProvider === 'fixture'
      ? createFixtureExtractionProvider(options.fixtures)
      : resolveExtractionProvider(extractProvider, env, retry);
  let embedder =
    embedProvider === 'fixture'
      ? createRawVectorEmbeddingProvider({
          fixtures: options.fixtures,
          assertionEmbeddings: options.assertionEmbeddings,
          queryEmbeddings: options.queryEmbeddings,
          queryTexts: options.queryTexts,
          dimension: options.embeddingDimension,
        })
      : resolveEmbeddingProvider(embedProvider, env, options.embeddingDimension, retry);
  if (options.trace?.enabled) {
    extractor = traceExtractionProvider(extractor, options.trace);
    embedder = traceEmbeddingProvider(embedder, options.trace);
  }

  const isLive = extractor.provenance.kind !== 'fixture' || embedder.provenance.kind !== 'fixture';
  return {
    modeLabel: isLive ? `live (${extractor.label} + ${embedder.label})` : 'fixture / raw-vector',
    isLive,
    extractor,
    embedder,
    provenance: { extraction: extractor.provenance, embedding: embedder.provenance },
  };
}

export function resolveLiveExtractionProvider(
  envOrOptions: NodeJS.ProcessEnv | { env?: NodeJS.ProcessEnv; trace?: LlmTraceOptions } = process.env,
): ExtractionProvider {
  const options = isLiveExtractionOptions(envOrOptions) ? envOrOptions : undefined;
  const env: NodeJS.ProcessEnv = options?.env ?? (options ? process.env : (envOrOptions as NodeJS.ProcessEnv));
  const trace = options?.trace;
  const provider = env['DEMO_EXTRACT_PROVIDER'] ?? inferExtractionProvider(env, true);
  if (provider === 'fixture') throw new Error('A live extraction provider is required; set DEMO_EXTRACT_PROVIDER.');
  const extractor = resolveExtractionProvider(provider, env, retryOptionsFromEnv(env, trace));
  return trace?.enabled ? traceExtractionProvider(extractor, trace) : extractor;
}

export function resolveLiveEmbeddingProvider(options: ResolveLiveProvidersOptions): DemoEmbeddingProvider {
  const env = options.env ?? process.env;
  const provider = env['DEMO_EMBED_PROVIDER'] ?? inferEmbeddingProvider(env, true);
  if (provider === 'fixture') throw new Error('A live embedding provider is required; set DEMO_EMBED_PROVIDER.');
  const embedder = resolveEmbeddingProvider(
    provider,
    env,
    options.embeddingDimension,
    retryOptionsFromEnv(env, options.trace),
  );
  return options.trace?.enabled ? traceEmbeddingProvider(embedder, options.trace) : embedder;
}

export function traceExtractionProvider(provider: ExtractionProvider, trace: LlmTraceOptions): ExtractionProvider {
  return {
    ...provider,
    async extract(prompt, options) {
      const label = options?.episodeId ? `${provider.label} / ${options.episodeId}` : provider.label;
      trace.log(`LLM extraction request -> ${label}`);
      if (trace.includePayloads) trace.log(indentBlock('prompt', prompt));
      const started = performance.now();
      const response = await provider.extract(prompt, options);
      trace.log(`LLM extraction response <- ${label} (${(performance.now() - started).toFixed(1)} ms)`);
      if (trace.includePayloads) trace.log(indentBlock('response', response));
      return response;
    },
  };
}

export function traceEmbeddingProvider(embedder: DemoEmbeddingProvider, trace: LlmTraceOptions): DemoEmbeddingProvider {
  return {
    ...embedder,
    provider: {
      ...embedder.provider,
      async embed(texts, options) {
        trace.log(`Embedding request -> ${embedder.label}: ${String(texts.length)} text(s)`);
        if (trace.includePayloads)
          trace.log(indentBlock('input texts', texts.map((text, i) => `[${String(i + 1)}] ${text}`).join('\n\n')));
        const started = performance.now();
        const vectors = await embedder.provider.embed(texts, options);
        trace.log(
          `Embedding response <- ${embedder.label}: ${String(vectors.length)} vector(s), ` +
            `${vectors[0]?.length ?? 0} dimension(s) (${(performance.now() - started).toFixed(1)} ms)`,
        );
        if (trace.includePayloads) {
          trace.log(indentBlock('vector summary', summarizeVectors(vectors)));
        }
        if (trace.includeRawVectors) {
          trace.log(indentBlock('raw vectors', JSON.stringify(vectors.map((v) => Array.from(v)))));
        }
        return vectors;
      },
    },
  };
}

function inferExtractionProvider(env: NodeJS.ProcessEnv, hasAnyLiveHint: boolean): string {
  if (!hasAnyLiveHint) return 'fixture';
  if (env['ANTHROPIC_API_KEY']) return 'anthropic';
  if (env['OPENROUTER_API_KEY'] || env['OPENAI_API_KEY'] || env['OLLAMA_HOST'] || env['DEMO_EXTRACT_BASE_URL']) {
    return 'openai-compatible';
  }
  return 'fixture';
}

function isLiveExtractionOptions(
  value: NodeJS.ProcessEnv | { env?: NodeJS.ProcessEnv; trace?: LlmTraceOptions },
): value is { env?: NodeJS.ProcessEnv; trace?: LlmTraceOptions } {
  return Object.prototype.hasOwnProperty.call(value, 'env') || Object.prototype.hasOwnProperty.call(value, 'trace');
}

function inferEmbeddingProvider(env: NodeJS.ProcessEnv, hasAnyLiveHint: boolean): string {
  if (!hasAnyLiveHint) return 'fixture';
  if (env['DEMO_EMBED_BASE_URL'] || env['OPENAI_API_KEY']) return 'openai-compatible';
  if (env['OLLAMA_HOST']) return 'ollama-native';
  return 'fixture';
}

function resolveExtractionProvider(
  provider: string,
  env: NodeJS.ProcessEnv,
  retry?: ProviderRetryOptions,
): ExtractionProvider {
  if (provider === 'fixture') return createFixtureExtractionProvider({});
  if (provider === 'anthropic') {
    const apiKey = required(
      env['DEMO_EXTRACT_API_KEY'] ?? env['ANTHROPIC_API_KEY'],
      'DEMO_EXTRACT_API_KEY or ANTHROPIC_API_KEY',
    );
    return createAnthropicExtractionProvider(apiKey, env['DEMO_EXTRACT_MODEL'] ?? 'claude-sonnet-4-20250514', retry);
  }
  if (provider === 'openai-compatible') {
    const preset = openAICompatPreset(env, 'extract');
    return createOpenAICompatibleExtractionProvider({
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: env['DEMO_EXTRACT_MODEL'] ?? preset.defaultModel,
      label: preset.label,
      ...(retry ? { retry } : {}),
    });
  }
  throw new Error(`Unsupported DEMO_EXTRACT_PROVIDER "${provider}". Use fixture, anthropic, or openai-compatible.`);
}

function resolveEmbeddingProvider(
  provider: string,
  env: NodeJS.ProcessEnv,
  dimension: number,
  retry?: ProviderRetryOptions,
): DemoEmbeddingProvider {
  const envDim = env['DEMO_EMBED_DIMENSION'];
  const resolvedDimension = envDim ? Number(envDim) : dimension;
  if (!Number.isFinite(resolvedDimension))
    throw new Error(`DEMO_EMBED_DIMENSION must be numeric, got ${String(envDim)}`);
  if (provider === 'openai-compatible') {
    const preset = openAICompatPreset(env, 'embed');
    return createOpenAICompatibleEmbeddingProvider({
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: env['DEMO_EMBED_MODEL'] ?? preset.defaultModel,
      dimension: resolvedDimension,
      label: preset.label,
      ...(retry ? { retry } : {}),
    });
  }
  if (provider === 'ollama-native') {
    const host = required(env['DEMO_EMBED_BASE_URL'] ?? env['OLLAMA_HOST'], 'DEMO_EMBED_BASE_URL or OLLAMA_HOST');
    return createOllamaNativeEmbeddingProvider({
      host,
      model: env['DEMO_EMBED_MODEL'] ?? 'nomic-embed-text',
      dimension: resolvedDimension,
      ...(retry ? { retry } : {}),
    });
  }
  if (provider === 'fixture')
    throw new Error('Internal error: fixture embedding must be resolved with fixture vectors.');
  throw new Error(`Unsupported DEMO_EMBED_PROVIDER "${provider}". Use fixture, openai-compatible, or ollama-native.`);
}

function openAICompatPreset(
  env: NodeJS.ProcessEnv,
  purpose: 'extract' | 'embed',
): {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  label: string;
} {
  const explicitBase = env[purpose === 'extract' ? 'DEMO_EXTRACT_BASE_URL' : 'DEMO_EMBED_BASE_URL'];
  const explicitKey = env[purpose === 'extract' ? 'DEMO_EXTRACT_API_KEY' : 'DEMO_EMBED_API_KEY'];
  if (explicitBase) {
    return {
      baseUrl: explicitBase,
      apiKey: explicitKey ?? env['OPENAI_API_KEY'] ?? 'sk-no-key',
      defaultModel: purpose === 'extract' ? 'gpt-4o-mini' : 'text-embedding-3-small',
      label: 'openai-compatible',
    };
  }
  if (env['OPENROUTER_API_KEY']) {
    return {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: explicitKey ?? env['OPENROUTER_API_KEY'],
      defaultModel: purpose === 'extract' ? 'anthropic/claude-sonnet-4' : 'openai/text-embedding-3-small',
      label: 'openrouter',
    };
  }
  if (env['OLLAMA_HOST']) {
    return {
      baseUrl: `${trimSlash(env['OLLAMA_HOST'])}/v1`,
      apiKey: explicitKey ?? 'ollama',
      defaultModel: purpose === 'extract' ? 'llama3.1' : 'nomic-embed-text',
      label: 'ollama-openai-compatible',
    };
  }
  if (env['OPENAI_API_KEY']) {
    return {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: explicitKey ?? env['OPENAI_API_KEY'],
      defaultModel: purpose === 'extract' ? 'gpt-4o-mini' : 'text-embedding-3-small',
      label: 'openai',
    };
  }
  throw new Error(
    purpose === 'extract'
      ? 'Missing extraction config. Set DEMO_EXTRACT_BASE_URL + DEMO_EXTRACT_MODEL, or ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, or OLLAMA_HOST.'
      : 'Missing embedding config. Set DEMO_EMBED_BASE_URL + DEMO_EMBED_MODEL, OPENAI_API_KEY, OPENROUTER_API_KEY with DEMO_EMBED_PROVIDER=openai-compatible, or OLLAMA_HOST with DEMO_EMBED_PROVIDER=ollama-native.',
  );
}

async function readJsonResponse(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new ProviderHttpError(
      `${label} failed HTTP ${String(response.status)} ${response.statusText}`,
      response.status,
      retryAfterMs(response.headers.get('retry-after')),
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} returned non-JSON response (${msg})`);
  }
}

function retryOptionsFromEnv(env: NodeJS.ProcessEnv, trace?: LlmTraceOptions): ProviderRetryOptions {
  return {
    maxAttempts: positiveInt(env['DEMO_PROVIDER_MAX_ATTEMPTS'], 6, 'DEMO_PROVIDER_MAX_ATTEMPTS'),
    baseDelayMs: positiveInt(env['DEMO_PROVIDER_BASE_DELAY_MS'], 1000, 'DEMO_PROVIDER_BASE_DELAY_MS'),
    maxDelayMs: positiveInt(env['DEMO_PROVIDER_MAX_DELAY_MS'], 30000, 'DEMO_PROVIDER_MAX_DELAY_MS'),
    rateLimitMs: nonNegativeMs(env['DEMO_RATE_LIMIT']),
    traceTimings: trace?.enabled === true,
    log:
      trace?.enabled === true
        ? (message: string) => {
            trace.log(message);
          }
        : (message: string) => {
            console.log('');
            console.log('[provider]');
            console.log(`  ${message}`);
          },
  };
}

async function withProviderRetry<T>(
  options: ProviderRetryOptions | undefined,
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  const retry = options ?? retryOptionsFromEnv({});

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      await waitForProviderRateLimit(
        retry.rateLimitMs,
        label,
        (message) => retry.log?.(message),
        retry.traceTimings === true,
      );
      return await operation();
    } catch (err) {
      if (!(err instanceof ProviderHttpError) || !shouldRetryHttpStatus(err.status) || attempt >= retry.maxAttempts) {
        throw err;
      }
      const delay = err.retryAfterMs ?? backoffDelayMs(attempt, retry);
      retry.log?.(
        `${label} retry ${String(attempt + 1)}/${String(retry.maxAttempts)} after HTTP ${String(err.status)}; waiting ${String(delay)} ms`,
      );
      await sleep(delay);
    }
  }
  throw new Error(`Internal error: exhausted retry loop for ${label}`);
}

let lastLiveProviderCallAt = 0;
let providerRateLimitQueue = Promise.resolve();

async function waitForProviderRateLimit(
  rateLimitMs: number,
  label: string,
  log: ((message: string) => void) | undefined,
  traceTimings: boolean,
): Promise<void> {
  const previous = providerRateLimitQueue;
  let release!: () => void;
  providerRateLimitQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (traceTimings && rateLimitMs > 0) {
    log?.(`${label} rate limit: waiting for prior live provider request, if any`);
  }
  const queuedAt = performance.now();
  await previous;
  try {
    const queuedMs = performance.now() - queuedAt;
    if (traceTimings && queuedMs >= 1) {
      log?.(`${label} rate limit: queue wait complete (${queuedMs.toFixed(1)} ms)`);
    }
    const rawElapsedMs = Date.now() - lastLiveProviderCallAt;
    const elapsedMs = rawElapsedMs < 0 ? rateLimitMs : rawElapsedMs;
    const waitMs = Math.max(0, rateLimitMs - elapsedMs);
    if (waitMs > 0) {
      log?.(`${label} rate limit: waiting ${String(waitMs)} ms before next live provider request`);
      await sleep(waitMs);
    }
    lastLiveProviderCallAt = Date.now();
  } finally {
    release();
  }
}

function shouldRetryHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - Date.now());
}

function backoffDelayMs(attempt: number, options: ProviderRetryOptions): number {
  const raw = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
  const jitter = Math.round(raw * (0.8 + Math.random() * 0.4));
  return Math.max(0, jitter);
}

function traceProviderTiming(retry: ProviderRetryOptions | undefined, message: string): void {
  if (retry?.traceTimings === true) retry.log?.(message);
}

function positiveInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function nonNegativeMs(rateLimitSeconds: string | undefined): number {
  if (rateLimitSeconds !== undefined && rateLimitSeconds.trim() !== '') {
    const parsed = Number(rateLimitSeconds);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error('DEMO_RATE_LIMIT must be a non-negative number');
    return Math.round(parsed * 1000);
  }
  return 5000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dataValue(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const part of path) {
    if (typeof part === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
    } else {
      if (current === null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing required provider config: ${label}`);
  return value;
}

function provenance(input: Omit<ProviderProvenance, 'configHash'>): ProviderProvenance {
  return {
    ...input,
    configHash: createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16),
  };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function indentBlock(label: string, value: string): string {
  return `${label}:\n${value
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')}`;
}

function summarizeVectors(vectors: readonly Float32Array[]): string {
  if (vectors.length === 0) return 'none';
  return vectors
    .map((vector, i) => {
      const preview = Array.from(vector.slice(0, 6))
        .map((n) => n.toFixed(4))
        .join(', ');
      return `[${String(i + 1)}] dimensions=${String(vector.length)} preview=[${preview}${vector.length > 6 ? ', ...' : ''}]`;
    })
    .join('\n');
}
