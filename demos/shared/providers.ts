import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { EmbeddingProvider, EmbedOptions } from 'trageti';
import { RawVectorProvider } from 'trageti';
import { parseExtraction } from './parse.js';

export type ProviderKind = 'fixture' | 'anthropic' | 'openai-compatible' | 'ollama-native';

export interface ProviderProvenance {
  kind: ProviderKind;
  model?: string;
  baseUrl?: string;
  dimension?: number;
  maxTokens?: number;
  configHash: string;
}

export interface ExtractionProvider {
  name: string;
  label: string;
  provenance: ProviderProvenance;
  extract(prompt: string, options?: ExtractionProviderOptions): Promise<string>;
}

export interface ExtractionProviderOptions {
  episodeId?: string;
  responseFormat?: 'json' | 'text';
  images?: Record<string, ExtractionImageInput>;
}

export interface ExtractionImageInput {
  path: string;
  mimeType: string;
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
  append?(message: string): void;
  status?(message: string): void;
}

export interface ProviderRetryOptions {
  maxAttempts: number;
  contentlessMaxAttempts?: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs?: number;
  rateLimitMs: number;
  retryHttpStatuses?: readonly number[];
  traceTimings?: boolean;
  tracePayloads?: boolean;
  log?(message: string): void;
  append?(message: string): void;
  status?(message: string): void;
}

const DEFAULT_EXTRACT_MAX_TOKENS = 8192;
const STREAM_PROGRESS_CHUNK_INTERVAL = 50;
const STREAM_PROGRESS_MIN_INTERVAL_MS = 1000;
const WHITESPACE_ONLY_STREAM_LIMIT = 64;

class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
    readonly rateLimitResetMs: number | null,
    readonly detail: string | null = null,
  ) {
    super(detail ? `${message}; ${detail}` : message);
  }
}

class ProviderTransportError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    cause: unknown,
  ) {
    super(`Provider transport failed (${code}): ${detail}`, { cause });
  }
}

class ProviderContentlessStreamError extends Error {
  constructor(readonly stats: OpenAIStreamStats) {
    super(
      `OpenAI-compatible extraction contentless stream: produced no content ` +
        `(HTTP ${String(stats.status)} ${stats.statusText || 'OK'}; ${String(stats.chunks)} chunk(s), ` +
        `${formatBytes(stats.totalBytes)}, ${String(stats.frames)} SSE frame(s), ${String(stats.deltas)} text delta(s))`,
    );
  }
}

interface OpenAIStreamStats {
  status: number;
  statusText: string;
  chunks: number;
  totalBytes: number;
  frames: number;
  deltas: number;
  contentLength: number;
}

export interface ResolveDemoProvidersOptions {
  fixtures: Record<string, string>;
  assertionEmbeddings: Record<string, number[]>;
  queryEmbeddings: Record<string, number[]>;
  queryTexts: readonly string[];
  embeddingDimension?: number;
  env?: NodeJS.ProcessEnv;
  trace?: LlmTraceOptions;
}

export interface ResolveLiveProvidersOptions {
  embeddingDimension?: number;
  env?: NodeJS.ProcessEnv;
  trace?: LlmTraceOptions;
}

export interface ResolveVisionProviderOptions {
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
  maxTokens = DEFAULT_EXTRACT_MAX_TOKENS,
): ExtractionProvider {
  const label = `anthropic:${model}`;
  const extractionRetry = extractionRetryOptions(retry);
  return {
    name: 'anthropic',
    label,
    provenance: provenance({ kind: 'anthropic', model, maxTokens }),
    async extract(prompt, extractOptions) {
      return withProviderRetry(extractionRetry, `${label} extraction`, async () => {
        const url = 'https://api.anthropic.com/v1/messages';
        const started = performance.now();
        traceProviderTiming(extractionRetry, `${label} extraction preparing HTTP POST -> ${url}`);
        const body = JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: anthropicMessageContent(prompt, extractOptions?.images) }],
        });
        traceProviderTiming(
          extractionRetry,
          `${label} extraction request body serialized: ${String(body.length)} byte(s) (${(
            performance.now() - started
          ).toFixed(1)} ms)`,
        );
        traceProviderTiming(extractionRetry, `${label} extraction fetch invoked -> ${url}`);
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body,
        });
        const receivedAt = performance.now();
        traceProviderTiming(
          extractionRetry,
          `${label} extraction HTTP response <- ${String(response.status)} ${response.statusText} (${(
            receivedAt - started
          ).toFixed(1)} ms)`,
        );
        const data = await readJsonResponse(response, 'Anthropic extraction', extractionRetry);
        const parsedAt = performance.now();
        traceProviderTiming(
          extractionRetry,
          `${label} extraction JSON parsed (${(parsedAt - receivedAt).toFixed(1)} ms)`,
        );
        const text = dataValue(data, ['content', 0, 'text']);
        if (typeof text !== 'string') throw new Error('Anthropic extraction response missing content[0].text');
        traceProviderTiming(
          extractionRetry,
          `${label} extraction content decoded: ${String(text.length)} character(s)`,
        );
        return text;
      });
    },
  };
}

export function createOpenAICompatibleExtractionProvider(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  label?: string;
  responseFormat?: OpenAICompatibleResponseFormat | null;
  extraBody?: Record<string, unknown>;
  streamJson?: boolean;
  retry?: ProviderRetryOptions;
}): ExtractionProvider {
  const label = options.label ?? `openai-compatible:${options.model}`;
  const maxTokens = options.maxTokens ?? DEFAULT_EXTRACT_MAX_TOKENS;
  const extractionRetry = extractionRetryOptions(options.retry);
  return {
    name: 'openai-compatible',
    label,
    provenance: provenance({ kind: 'openai-compatible', model: options.model, baseUrl: options.baseUrl, maxTokens }),
    async extract(prompt, extractOptions) {
      const responseFormat = extractOptions?.responseFormat === 'text' ? null : options.responseFormat;
      const requestBase = {
        model: options.model,
        messages: [{ role: 'user', content: openAIMessageContent(prompt, extractOptions?.images) }],
        temperature: 0.2,
        max_tokens: maxTokens,
        ...options.extraBody,
        ...openAICompatibleExtractionFormatBody(responseFormat),
      };
      if (extractOptions?.responseFormat === 'json' && options.streamJson !== true) {
        return await withProviderRetry(extractionRetry, `${label} extraction`, async () =>
          fetchOpenAIChatCompletionNonStream({
            url: `${trimSlash(options.baseUrl)}/chat/completions`,
            apiKey: options.apiKey,
            label,
            requestBase,
            retry: extractionRetry,
            skipRateLimit: true,
          }),
        );
      }
      try {
        return await withProviderRetry(extractionRetry, `${label} extraction`, async () => {
          const url = `${trimSlash(options.baseUrl)}/chat/completions`;
          const started = performance.now();
          traceProviderTiming(extractionRetry, `${label} extraction preparing HTTP POST -> ${url}`);
          const body = JSON.stringify({
            ...requestBase,
            stream: true,
          });
          traceProviderTiming(
            extractionRetry,
            `${label} extraction request body serialized: ${String(body.length)} byte(s) (${(
              performance.now() - started
            ).toFixed(1)} ms)`,
          );
          traceProviderTiming(extractionRetry, `${label} extraction fetch invoked -> ${url}`);
          const signal = abortSignal(extractionRetry);
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${options.apiKey}`,
            },
            body,
            ...(signal ? { signal } : {}),
          });
          const receivedAt = performance.now();
          traceProviderTiming(
            extractionRetry,
            `${label} extraction HTTP response <- ${String(response.status)} ${response.statusText} (${(
              receivedAt - started
            ).toFixed(1)} ms)`,
          );
          return await readOpenAIChatCompletionStream(response, label, extractionRetry, receivedAt, {
            stopWhenJsonComplete: extractOptions?.responseFormat === 'json',
          });
        });
      } catch (err) {
        if (!(err instanceof ProviderContentlessStreamError) || extractOptions?.responseFormat !== 'json') throw err;
        return await fetchOpenAIChatCompletionNonStream({
          url: `${trimSlash(options.baseUrl)}/chat/completions`,
          apiKey: options.apiKey,
          label,
          requestBase,
          retry: extractionRetry,
          streamError: err,
        });
      }
    },
  };
}

export function createOpenAICompatibleEmbeddingProvider(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimension: number;
  label?: string;
  extraBody?: Record<string, unknown>;
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
          `${label} embedding preparing HTTP POST -> ${url} (${String(texts.length)} text(s), requested dimension ${String(
            options.dimension,
          )})`,
        );
        const body = JSON.stringify({
          ...options.extraBody,
          model: options.model,
          input: texts,
          dimensions: options.dimension,
        });
        traceProviderTiming(
          options.retry,
          `${label} embedding request body serialized: ${String(body.length)} byte(s) (${(
            performance.now() - started
          ).toFixed(1)} ms)`,
        );
        traceProviderTiming(options.retry, `${label} embedding fetch invoked -> ${url}`);
        const response = await fetch(url, {
          method: 'POST',
          ...(embedOptions?.signal ? { signal: embedOptions.signal } : {}),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
          },
          body,
        });
        const receivedAt = performance.now();
        traceProviderTiming(
          options.retry,
          `${label} embedding HTTP response <- ${String(response.status)} ${response.statusText} (${(
            receivedAt - started
          ).toFixed(1)} ms)`,
        );
        const data = await readJsonResponse(
          response,
          `${options.label ?? 'OpenAI-compatible'} embedding`,
          options.retry,
        );
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
              `ollama-native:${options.model} embedding preparing HTTP POST ${String(index + 1)}/${String(
                texts.length,
              )} -> ${url}`,
            );
            const body = JSON.stringify({ model: options.model, prompt: text });
            traceProviderTiming(
              options.retry,
              `ollama-native:${options.model} embedding request body serialized ${String(index + 1)}/${String(
                texts.length,
              )}: ${String(body.length)} byte(s) (${(performance.now() - started).toFixed(1)} ms)`,
            );
            traceProviderTiming(
              options.retry,
              `ollama-native:${options.model} embedding fetch invoked ${String(index + 1)}/${String(
                texts.length,
              )} -> ${url}`,
            );
            const response = await fetch(url, {
              method: 'POST',
              ...(embedOptions?.signal ? { signal: embedOptions.signal } : {}),
              headers: { 'Content-Type': 'application/json' },
              body,
            });
            const receivedAt = performance.now();
            traceProviderTiming(
              options.retry,
              `ollama-native:${options.model} embedding HTTP response ${String(index + 1)}/${String(
                texts.length,
              )} <- ${String(response.status)} ${response.statusText} (${(receivedAt - started).toFixed(1)} ms)`,
            );
            const data = await readJsonResponse(response, 'Ollama native embedding', options.retry);
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
  const embeddingDimension = resolveDemoEmbeddingDimension(options);

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
          dimension: embeddingDimension,
        })
      : resolveEmbeddingProvider(embedProvider, env, embeddingDimension, retry);
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

export function resolveVisionProvider(options: ResolveVisionProviderOptions = {}): ExtractionProvider {
  const env = options.env ?? process.env;
  const retry = retryOptionsFromEnv(env, options.trace);
  const provider = env['DEMO_VISION_PROVIDER'] ?? inferVisionProvider(env);
  let resolved: ExtractionProvider;
  if (provider === 'fixture') {
    resolved = createFixtureExtractionProvider({});
  } else if (provider === 'anthropic') {
    resolved = createAnthropicExtractionProvider(
      required(env['DEMO_VISION_API_KEY'] ?? env['ANTHROPIC_API_KEY'], 'DEMO_VISION_API_KEY or ANTHROPIC_API_KEY'),
      env['DEMO_VISION_MODEL'] ?? 'claude-sonnet-4-20250514',
      retry,
      visionMaxTokensFromEnv(env),
    );
  } else if (provider === 'openai-compatible') {
    const preset = openAICompatPreset(env, 'vision');
    const extraBody = openAICompatibleVisionExtraBody(env);
    resolved = createOpenAICompatibleExtractionProvider({
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: env['DEMO_VISION_MODEL'] ?? preset.defaultModel,
      maxTokens: visionMaxTokensFromEnv(env),
      label: `${preset.label}:vision`,
      responseFormat: null,
      ...(extraBody ? { extraBody } : {}),
      ...(retry ? { retry } : {}),
    });
  } else {
    throw new Error(`Unsupported DEMO_VISION_PROVIDER "${provider}". Use fixture, anthropic, or openai-compatible.`);
  }
  return options.trace?.enabled ? traceExtractionProvider(resolved, options.trace) : resolved;
}

export function resolveLiveEmbeddingProvider(options: ResolveLiveProvidersOptions): DemoEmbeddingProvider {
  const env = options.env ?? process.env;
  const provider = env['DEMO_EMBED_PROVIDER'] ?? inferEmbeddingProvider(env, true);
  if (provider === 'fixture') throw new Error('A live embedding provider is required; set DEMO_EMBED_PROVIDER.');
  const embeddingDimension = options.embeddingDimension ?? embeddingDimensionFromEnv(env);
  if (embeddingDimension === null || embeddingDimension === undefined) {
    throw new Error('Live embedding provider resolution requires DEMO_EMBED_DIMENSION.');
  }
  const embedder = resolveEmbeddingProvider(provider, env, embeddingDimension, retryOptionsFromEnv(env, options.trace));
  return options.trace?.enabled ? traceEmbeddingProvider(embedder, options.trace) : embedder;
}

export function inferEmbeddingDimensionFromVectors(options: {
  assertionEmbeddings: Record<string, number[]>;
  queryEmbeddings: Record<string, number[]>;
  queryTexts?: readonly string[];
}): number {
  const vectors = [
    ...Object.entries(options.assertionEmbeddings).map(([id, vector]) => ({ id, vector })),
    ...Object.entries(options.queryEmbeddings).map(([id, vector]) => ({ id, vector })),
  ];
  const first = vectors[0];
  if (!first) {
    throw new Error('Unable to infer embedding dimension: no fixture embedding vectors are available.');
  }
  const dimension = first.vector.length;
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(`Embedding vector "${first.id}" has invalid dimension ${String(dimension)}.`);
  }
  for (const { id, vector } of vectors) {
    if (vector.length !== dimension) {
      throw new Error(
        `Embedding vector "${id}" has dimension ${String(vector.length)}; expected ${String(dimension)}.`,
      );
    }
  }
  if (options.queryTexts) {
    for (const text of options.queryTexts) {
      const vector = options.queryEmbeddings[text];
      if (!vector) throw new Error(`missing query embedding: ${text}`);
    }
  }
  return dimension;
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

function inferVisionProvider(env: NodeJS.ProcessEnv): string {
  if (env['DEMO_VISION_PROVIDER']) return env['DEMO_VISION_PROVIDER'];
  if (env['ANTHROPIC_API_KEY']) return 'anthropic';
  if (
    env['OPENROUTER_API_KEY'] ||
    env['OPENAI_API_KEY'] ||
    env['OLLAMA_HOST'] ||
    env['DEMO_VISION_BASE_URL'] ||
    env['DEMO_EXTRACT_BASE_URL']
  ) {
    return 'openai-compatible';
  }
  return 'fixture';
}

function resolveDemoEmbeddingDimension(options: ResolveDemoProvidersOptions): number {
  const fromEnv = embeddingDimensionFromEnv(options.env ?? process.env);
  const dimension = fromEnv ?? options.embeddingDimension ?? inferEmbeddingDimensionFromVectors(options);
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(`Embedding dimension must be a positive integer, got ${String(dimension)}.`);
  }
  return dimension;
}

function embeddingDimensionFromEnv(env: NodeJS.ProcessEnv): number | null {
  const envDim = env['DEMO_EMBED_DIMENSION'];
  if (!envDim) return null;
  const dimension = Number(envDim);
  if (!Number.isFinite(dimension)) throw new Error(`DEMO_EMBED_DIMENSION must be numeric, got ${envDim}`);
  return dimension;
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
    return createAnthropicExtractionProvider(
      apiKey,
      env['DEMO_EXTRACT_MODEL'] ?? 'claude-sonnet-4-20250514',
      retry,
      extractMaxTokensFromEnv(env),
    );
  }
  if (provider === 'openai-compatible') {
    const preset = openAICompatPreset(env, 'extract');
    const extraBody = openAICompatibleExtractionExtraBody(env);
    return createOpenAICompatibleExtractionProvider({
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: env['DEMO_EXTRACT_MODEL'] ?? preset.defaultModel,
      maxTokens: extractMaxTokensFromEnv(env),
      label: preset.label,
      responseFormat: openAICompatibleExtractionFormat(env),
      streamJson: truthyEnv(env['DEMO_EXTRACT_STREAM_JSON']),
      ...(extraBody ? { extraBody } : {}),
      ...(retry ? { retry } : {}),
    });
  }
  throw new Error(`Unsupported DEMO_EXTRACT_PROVIDER "${provider}". Use fixture, anthropic, or openai-compatible.`);
}

type OpenAICompatibleResponseFormat = Record<string, unknown>;

function openAICompatibleExtractionFormat(env: NodeJS.ProcessEnv): OpenAICompatibleResponseFormat | null {
  const raw = env['DEMO_EXTRACT_RESPONSE_FORMAT']?.trim();
  const preset = raw?.toLowerCase();
  if (preset === 'none' || preset === 'off' || preset === '0' || preset === 'false') return null;
  if (preset === 'json_schema' || preset === 'schema' || preset === 'strict')
    return extractionJsonSchemaResponseFormat();
  if (raw?.startsWith('{')) return parseJsonObjectEnv(raw, 'DEMO_EXTRACT_RESPONSE_FORMAT');
  return { type: 'json_object' };
}

function openAICompatibleExtractionFormatBody(responseFormat: OpenAICompatibleResponseFormat | null | undefined): {
  response_format?: OpenAICompatibleResponseFormat;
} {
  if (responseFormat === null) return {};
  return { response_format: responseFormat ?? { type: 'json_object' } };
}

function openAIMessageContent(prompt: string, images?: Record<string, ExtractionImageInput>): string | unknown[] {
  const entries = Object.entries(images ?? {});
  if (entries.length === 0) return prompt;
  return [
    { type: 'text', text: prompt },
    ...entries.map(([sourceRef, image]) => ({
      type: 'image_url',
      image_url: {
        url: imageDataUrl(image),
        detail: 'high',
      },
      source_ref: sourceRef,
    })),
  ];
}

function anthropicMessageContent(prompt: string, images?: Record<string, ExtractionImageInput>): string | unknown[] {
  const entries = Object.entries(images ?? {});
  if (entries.length === 0) return prompt;
  return [
    { type: 'text', text: prompt },
    ...entries.map(([sourceRef, image]) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mimeType,
        data: readFileSync(image.path).toString('base64'),
      },
      source_ref: sourceRef,
    })),
  ];
}

function imageDataUrl(image: ExtractionImageInput): string {
  return `data:${image.mimeType};base64,${readFileSync(image.path).toString('base64')}`;
}

function openAICompatibleExtractionExtraBody(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  const raw = env['DEMO_EXTRACT_EXTRA_BODY_JSON']?.trim();
  if (!raw) return undefined;
  const extraBody = parseJsonObjectEnv(raw, 'DEMO_EXTRACT_EXTRA_BODY_JSON');
  if (Object.prototype.hasOwnProperty.call(extraBody, 'response_format')) {
    throw new Error('DEMO_EXTRACT_EXTRA_BODY_JSON must not include response_format; use DEMO_EXTRACT_RESPONSE_FORMAT.');
  }
  return extraBody;
}

function openAICompatibleEmbeddingExtraBody(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  const raw = env['DEMO_EMBED_EXTRA_BODY_JSON']?.trim();
  if (!raw) return undefined;
  return parseJsonObjectEnv(raw, 'DEMO_EMBED_EXTRA_BODY_JSON');
}

function openAICompatibleVisionExtraBody(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  const name =
    env['DEMO_VISION_EXTRA_BODY_JSON'] === undefined ? 'DEMO_EXTRACT_EXTRA_BODY_JSON' : 'DEMO_VISION_EXTRA_BODY_JSON';
  const raw = env['DEMO_VISION_EXTRA_BODY_JSON']?.trim() ?? env['DEMO_EXTRACT_EXTRA_BODY_JSON']?.trim();
  if (!raw) return undefined;
  return parseJsonObjectEnv(raw, name);
}

function parseJsonObjectEnv(raw: string, name: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('value must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${name} must be a JSON object (${message})`);
  }
}

function extractionJsonSchemaResponseFormat(): OpenAICompatibleResponseFormat {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'trageti_extraction',
      strict: true,
      schema: extractionJsonSchema(),
    },
  };
}

function extractionJsonSchema(): Record<string, unknown> {
  const citation = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'episodeId', 'sourceRef', 'excerpt'],
    properties: {
      id: { type: 'string' },
      episodeId: { type: 'string' },
      sourceRef: { type: 'string' },
      excerpt: { type: 'null' },
      excerptStart: { type: 'string' },
      excerptEnd: { type: 'string' },
    },
  };
  const assertion = {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'namespace',
      'type',
      'content',
      'validFrom',
      'validUntil',
      'confidence',
      'sourceEpisodeId',
      'supersedesId',
      'entityId',
      'entityType',
      'citations',
    ],
    properties: {
      id: { type: 'string' },
      namespace: { type: 'string' },
      type: {
        type: 'string',
        enum: ['fact', 'update', 'recontextualization', 'resolution', 'regression', 'absence', 'pattern'],
      },
      content: { type: 'string' },
      validFrom: { type: 'number' },
      validUntil: { type: ['number', 'null'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      sourceEpisodeId: { type: 'string' },
      supersedesId: { type: ['string', 'null'] },
      entityId: { type: ['string', 'null'] },
      entityType: { type: ['string', 'null'] },
      citations: { type: 'array', minItems: 1, items: citation },
    },
  };
  const link = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'namespace', 'fromId', 'toId', 'linkType', 'validFrom', 'validUntil', 'sourceEpisodeId'],
    properties: {
      id: { type: 'string' },
      namespace: { type: 'string' },
      fromId: { type: 'string' },
      toId: { type: 'string' },
      linkType: {
        type: 'string',
        enum: ['deepens', 'qualifies', 'contradicts', 'contextualizes', 'measures', 'related'],
      },
      validFrom: { type: 'number' },
      validUntil: { type: ['number', 'null'] },
      sourceEpisodeId: { type: 'string' },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['assertions', 'links'],
    properties: {
      assertions: { type: 'array', items: assertion },
      links: { type: 'array', items: link },
    },
  };
}

function resolveEmbeddingProvider(
  provider: string,
  env: NodeJS.ProcessEnv,
  dimension: number,
  retry?: ProviderRetryOptions,
): DemoEmbeddingProvider {
  const resolvedDimension = embeddingDimensionFromEnv(env) ?? dimension;
  if (provider === 'openai-compatible') {
    const preset = openAICompatPreset(env, 'embed');
    const extraBody = openAICompatibleEmbeddingExtraBody(env);
    return createOpenAICompatibleEmbeddingProvider({
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: env['DEMO_EMBED_MODEL'] ?? preset.defaultModel,
      dimension: resolvedDimension,
      label: preset.label,
      ...(extraBody ? { extraBody } : {}),
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
  purpose: 'extract' | 'embed' | 'vision',
): {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  label: string;
} {
  const explicitBase =
    env[
      purpose === 'extract'
        ? 'DEMO_EXTRACT_BASE_URL'
        : purpose === 'embed'
          ? 'DEMO_EMBED_BASE_URL'
          : 'DEMO_VISION_BASE_URL'
    ] ?? (purpose === 'vision' ? env['DEMO_EXTRACT_BASE_URL'] : undefined);
  const explicitKey =
    env[
      purpose === 'extract'
        ? 'DEMO_EXTRACT_API_KEY'
        : purpose === 'embed'
          ? 'DEMO_EMBED_API_KEY'
          : 'DEMO_VISION_API_KEY'
    ] ?? (purpose === 'vision' ? env['DEMO_EXTRACT_API_KEY'] : undefined);
  if (explicitBase) {
    return {
      baseUrl: explicitBase,
      apiKey: explicitKey ?? env['OPENAI_API_KEY'] ?? 'sk-no-key',
      defaultModel: purpose === 'embed' ? 'text-embedding-3-small' : 'gpt-4o-mini',
      label: 'openai-compatible',
    };
  }
  if (env['OPENROUTER_API_KEY']) {
    return {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: explicitKey ?? env['OPENROUTER_API_KEY'],
      defaultModel: purpose === 'embed' ? 'openai/text-embedding-3-small' : 'anthropic/claude-sonnet-4',
      label: 'openrouter',
    };
  }
  if (env['OLLAMA_HOST']) {
    return {
      baseUrl: `${trimSlash(env['OLLAMA_HOST'])}/v1`,
      apiKey: explicitKey ?? 'ollama',
      defaultModel: purpose === 'embed' ? 'nomic-embed-text' : 'llama3.1',
      label: 'ollama-openai-compatible',
    };
  }
  if (env['OPENAI_API_KEY']) {
    return {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: explicitKey ?? env['OPENAI_API_KEY'],
      defaultModel: purpose === 'embed' ? 'text-embedding-3-small' : 'gpt-4o-mini',
      label: 'openai',
    };
  }
  throw new Error(
    purpose === 'extract'
      ? 'Missing extraction config. Set DEMO_EXTRACT_BASE_URL + DEMO_EXTRACT_MODEL, or ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, or OLLAMA_HOST.'
      : purpose === 'embed'
        ? 'Missing embedding config. Set DEMO_EMBED_BASE_URL + DEMO_EMBED_MODEL, OPENAI_API_KEY, OPENROUTER_API_KEY with DEMO_EMBED_PROVIDER=openai-compatible, or OLLAMA_HOST with DEMO_EMBED_PROVIDER=ollama-native.'
        : 'Missing vision config. Set DEMO_VISION_BASE_URL + DEMO_VISION_MODEL, or ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, or OLLAMA_HOST.',
  );
}

async function readJsonResponse(response: Response, label: string, retry?: ProviderRetryOptions): Promise<unknown> {
  const text = await readResponseText(response, label, retry);
  if (retry?.tracePayloads === true) {
    retry.log?.(`${label} raw response body:\n${text}`);
  }
  if (!response.ok) {
    const detail = providerHttpErrorDetail(response, text);
    throw new ProviderHttpError(
      `${label} failed HTTP ${String(response.status)} ${response.statusText}`,
      response.status,
      retryAfterMs(response.headers.get('retry-after')),
      rateLimitResetMs(response.headers),
      detail,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} returned non-JSON response (${msg})`);
  }
}

async function fetchOpenAIChatCompletionNonStream(options: {
  url: string;
  apiKey: string;
  label: string;
  requestBase: Record<string, unknown>;
  retry: ProviderRetryOptions | undefined;
  streamError?: ProviderContentlessStreamError;
  skipRateLimit?: boolean;
}): Promise<string> {
  if (options.skipRateLimit !== true) {
    return await withProviderRateLimit(
      options.retry?.rateLimitMs ?? retryOptionsFromEnv({}).rateLimitMs,
      `${options.label} extraction fallback`,
      (message) => options.retry?.log?.(message),
      options.retry?.traceTimings === true,
      () => fetchOpenAIChatCompletionNonStream({ ...options, skipRateLimit: true }),
    );
  }
  const started = performance.now();
  traceProviderTiming(options.retry, `${options.label} extraction fallback preparing HTTP POST -> ${options.url}`);
  const body = JSON.stringify({
    ...options.requestBase,
    stream: false,
  });
  traceProviderTiming(
    options.retry,
    `${options.label} extraction fallback request body serialized: ${String(body.length)} byte(s) (${(
      performance.now() - started
    ).toFixed(1)} ms)`,
  );
  traceProviderTiming(options.retry, `${options.label} extraction fallback fetch invoked -> ${options.url}`);
  const signal = abortSignal(options.retry);
  const response = await fetch(options.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body,
    ...(signal ? { signal } : {}),
  });
  const receivedAt = performance.now();
  traceProviderTiming(
    options.retry,
    `${options.label} extraction fallback HTTP response <- ${String(response.status)} ${response.statusText} (${(
      receivedAt - started
    ).toFixed(1)} ms)`,
  );
  let data: unknown;
  try {
    data = await readJsonResponse(response, `${options.label} extraction fallback`, options.retry);
  } catch (err) {
    if (err instanceof ProviderHttpError && err.status === 400 && hasResponseFormat(options.requestBase)) {
      options.retry?.log?.(`${options.label} extraction fallback retrying without response_format after HTTP 400`);
      return await fetchOpenAIChatCompletionNonStream({
        ...options,
        requestBase: withoutResponseFormat(options.requestBase),
        skipRateLimit: true,
      });
    }
    if (options.streamError) throw openAINonStreamFallbackError(err, options.streamError);
    throw err;
  }
  const content = openAIChatCompletionContent(data);
  if (content === null || content.length === 0) {
    const err = new Error(`${options.label} extraction fallback response missing choices[0].message.content`);
    if (options.streamError) throw openAINonStreamFallbackError(err, options.streamError);
    throw err;
  }
  traceProviderTiming(
    options.retry,
    `${options.label} extraction fallback content decoded: ${String(content.length)} character(s)`,
  );
  return content;
}

async function readOpenAIChatCompletionStream(
  response: Response,
  label: string,
  retry: ProviderRetryOptions | undefined,
  receivedAt: number,
  options: { stopWhenJsonComplete?: boolean } = {},
): Promise<string> {
  if (!response.ok) {
    const text = await readResponseText(response, `${label} extraction stream error`, retry);
    const detail = providerHttpErrorDetail(response, text);
    throw new ProviderHttpError(
      `${label} extraction failed HTTP ${String(response.status)} ${response.statusText}`,
      response.status,
      retryAfterMs(response.headers.get('retry-after')),
      rateLimitResetMs(response.headers),
      detail,
    );
  }
  if (!response.body) throw new Error(`${label} extraction streaming response missing body`);

  const decoder = new TextDecoder();
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  let buffer = '';
  let content = '';
  let totalBytes = 0;
  let chunks = 0;
  let frames = 0;
  let deltas = 0;
  let nonWhitespaceSeen = false;
  let lastProgressAt = receivedAt;

  const traceProgress = (): void => {
    if (retry?.traceTimings !== true) return;
    if (retry.tracePayloads === true) return;
    const now = performance.now();
    if (
      chunks !== 1 &&
      chunks % STREAM_PROGRESS_CHUNK_INTERVAL !== 0 &&
      now - lastProgressAt < STREAM_PROGRESS_MIN_INTERVAL_MS
    ) {
      return;
    }
    lastProgressAt = now;
    traceProviderStatus(
      retry,
      `${label} extraction stream: ${String(chunks)} chunks, ${formatBytes(totalBytes)}, ` +
        `${String(deltas)} deltas, ${String(content.length)} chars, ${(now - receivedAt).toFixed(0)} ms`,
    );
  };

  const appendDelta = (delta: string): void => {
    deltas += 1;
    content += delta;
    if (/\S/u.test(delta)) {
      nonWhitespaceSeen = true;
      return;
    }
    if (!nonWhitespaceSeen && content.length >= WHITESPACE_ONLY_STREAM_LIMIT) {
      throw new ProviderContentlessStreamError({
        status: response.status,
        statusText: response.statusText,
        chunks,
        totalBytes,
        frames,
        deltas,
        contentLength: content.length,
      });
    }
  };

  const handleSseData = (data: string): void => {
    frames += 1;
    if (retry?.tracePayloads === true && retry.append) {
      retry.append(`data: ${data}\n\n`);
    }
    if (data === '[DONE]') return;
    const delta = openAIStreamDelta(data);
    if (delta === null || delta.length === 0) return;
    appendDelta(delta);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks += 1;
    totalBytes += value.byteLength;
    buffer += decoder.decode(value, { stream: true });
    const parsed = consumeSseBuffer(buffer, handleSseData);
    buffer = parsed.remaining;
    const completedJson = options.stopWhenJsonComplete === true ? completeExtractionJson(content) : null;
    if (completedJson !== null) {
      traceProviderTiming(
        retry,
        `${label} extraction stream stopped after complete JSON object: ${String(chunks)} chunk(s), ` +
          `${formatBytes(totalBytes)}, ${String(frames)} SSE frame(s), ${String(deltas)} text delta(s), ` +
          `${String(completedJson.length)} character(s)`,
      );
      await reader.cancel();
      return completedJson;
    }
    traceProgress();
  }
  buffer += decoder.decode();
  consumeSseBuffer(buffer, handleSseData);
  traceProviderTiming(
    retry,
    `${label} extraction stream complete: ${String(chunks)} chunk(s), ${String(totalBytes)} byte(s), ` +
      `${String(frames)} SSE frame(s), ${String(deltas)} text delta(s), ${String(content.length)} character(s) (${(
        performance.now() - receivedAt
      ).toFixed(1)} ms)`,
  );
  if (retry?.traceTimings !== true) {
    retry?.log?.(
      `${label} extraction stream complete: ${String(chunks)} chunk(s), ${String(frames)} SSE frame(s), ` +
        `${String(deltas)} text delta(s), ${String(content.length)} character(s)`,
    );
  }
  if (content.trim().length === 0) {
    throw new ProviderContentlessStreamError({
      status: response.status,
      statusText: response.statusText,
      chunks,
      totalBytes,
      frames,
      deltas,
      contentLength: content.length,
    });
  }
  return content;
}

function consumeSseBuffer(buffer: string, onData: (data: string) => void): { remaining: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const remaining = parts.pop() ?? '';
  for (const part of parts) {
    const data = part
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n')
      .trim();
    if (data) onData(data);
  }
  return { remaining };
}

function completeExtractionJson(content: string): string | null {
  const end = firstJsonObjectEnd(content);
  if (end === null) return null;
  const start = content.indexOf('{');
  if (start < 0) return null;
  const slice = content.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as { assertions?: unknown; links?: unknown };
    return Array.isArray(parsed.assertions) && Array.isArray(parsed.links) ? slice : null;
  } catch {
    return null;
  }
}

function firstJsonObjectEnd(content: string): number | null {
  const start = content.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < content.length; i++) {
    const char = content[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

function openAIStreamDelta(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    const delta = dataValue(parsed, ['choices', 0, 'delta', 'content']);
    if (typeof delta === 'string') return delta;
    const content = dataValue(parsed, ['choices', 0, 'message', 'content']);
    return openAIContentText(content);
  } catch {
    return null;
  }
}

function openAIChatCompletionContent(data: unknown): string | null {
  return openAIContentText(dataValue(data, ['choices', 0, 'message', 'content']));
}

function openAIContentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const pieces = content
    .map((part) => {
      const text = dataValue(part, ['text']);
      if (typeof text === 'string') return text;
      const nestedText = dataValue(part, ['text', 'value']);
      if (typeof nestedText === 'string') return nestedText;
      return null;
    })
    .filter((part): part is string => part !== null);
  return pieces.length > 0 ? pieces.join('') : null;
}

function openAINonStreamFallbackError(err: unknown, streamError: ProviderContentlessStreamError): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${streamError.message}; non-streaming fallback also produced no usable content (${message})`, {
    cause: err,
  });
}

function hasResponseFormat(requestBase: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(requestBase, 'response_format');
}

function withoutResponseFormat(requestBase: Record<string, unknown>): Record<string, unknown> {
  const { response_format: _responseFormat, ...rest } = requestBase;
  return rest;
}

async function readResponseText(response: Response, label: string, retry?: ProviderRetryOptions): Promise<string> {
  if (retry?.traceTimings !== true || !response.body) return await response.text();

  const decoder = new TextDecoder();
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  let text = '';
  let totalBytes = 0;
  let chunks = 0;
  let lastProgressAt = performance.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks += 1;
    totalBytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    const now = performance.now();
    if (
      chunks === 1 ||
      chunks % STREAM_PROGRESS_CHUNK_INTERVAL === 0 ||
      now - lastProgressAt >= STREAM_PROGRESS_MIN_INTERVAL_MS
    ) {
      lastProgressAt = now;
      traceProviderStatus(retry, `${label} response body: ${String(chunks)} chunks, ${formatBytes(totalBytes)}`);
    }
  }
  text += decoder.decode();
  traceProviderTiming(
    retry,
    `${label} response body complete: ${String(chunks)} chunk(s), ${String(totalBytes)} byte(s)`,
  );
  return text;
}

function retryOptionsFromEnv(env: NodeJS.ProcessEnv, trace?: LlmTraceOptions): ProviderRetryOptions {
  const options: ProviderRetryOptions = {
    maxAttempts: positiveInt(env['DEMO_PROVIDER_MAX_ATTEMPTS'], 6, 'DEMO_PROVIDER_MAX_ATTEMPTS'),
    contentlessMaxAttempts: positiveInt(
      env['DEMO_PROVIDER_CONTENTLESS_MAX_ATTEMPTS'],
      2,
      'DEMO_PROVIDER_CONTENTLESS_MAX_ATTEMPTS',
    ),
    baseDelayMs: positiveInt(env['DEMO_PROVIDER_BASE_DELAY_MS'], 1000, 'DEMO_PROVIDER_BASE_DELAY_MS'),
    maxDelayMs: positiveInt(env['DEMO_PROVIDER_MAX_DELAY_MS'], 30000, 'DEMO_PROVIDER_MAX_DELAY_MS'),
    timeoutMs: positiveInt(env['DEMO_PROVIDER_TIMEOUT_MS'], 60000, 'DEMO_PROVIDER_TIMEOUT_MS'),
    rateLimitMs: nonNegativeMs(env['DEMO_RATE_LIMIT']),
    traceTimings: trace?.enabled === true,
    tracePayloads: trace?.includePayloads === true,
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
  if (trace?.append) {
    options.append = (message: string) => {
      trace.append?.(message);
    };
  }
  if (trace?.status) {
    options.status = (message: string) => {
      trace.status?.(message);
    };
  }
  return options;
}

function extractionRetryOptions(options: ProviderRetryOptions | undefined): ProviderRetryOptions | undefined {
  const retryHttpStatuses = [408, 429, 502, 503, 504] as const;
  if (options === undefined) return { ...retryOptionsFromEnv({}), retryHttpStatuses };
  return { ...options, retryHttpStatuses };
}

async function withProviderRetry<T>(
  options: ProviderRetryOptions | undefined,
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  const retry = options ?? retryOptionsFromEnv({});

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      return await withProviderRateLimit(
        retry.rateLimitMs,
        label,
        (message) => retry.log?.(message),
        retry.traceTimings === true,
        operation,
      );
    } catch (err) {
      const transportError = providerTransportError(err);
      if (transportError) {
        if (attempt >= retry.maxAttempts) throw transportError;
        const delay = backoffDelayMs(attempt, retry);
        retry.log?.(
          `${label} retry ${String(attempt + 1)}/${String(retry.maxAttempts)} after transport ${transportError.code}; waiting ${String(delay)} ms`,
        );
        await sleep(delay);
        continue;
      }
      if (err instanceof ProviderHttpError) {
        if (!shouldRetryHttpStatus(err.status, retry) || attempt >= retry.maxAttempts) throw err;
        const delay = retryDelayMs(err, attempt, retry);
        if (err.status === 429) postponeProviderRateLimit(delay);
        retry.log?.(
          `${label} retry ${String(attempt + 1)}/${String(retry.maxAttempts)} after HTTP ${String(err.status)}; waiting ${String(delay)} ms`,
        );
        await sleep(delay);
        continue;
      }
      if (err instanceof ProviderContentlessStreamError) {
        const contentlessMaxAttempts = Math.min(retry.maxAttempts, retry.contentlessMaxAttempts ?? retry.maxAttempts);
        if (attempt >= contentlessMaxAttempts) throw err;
        const delay = backoffDelayMs(attempt, retry);
        retry.log?.(
          `${label} retry ${String(attempt + 1)}/${String(contentlessMaxAttempts)} after contentless stream; waiting ${String(delay)} ms`,
        );
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Internal error: exhausted retry loop for ${label}`);
}

let nextLiveProviderRequestAt = 0;
let providerRateLimitQueue = Promise.resolve();

export function resetDemoProviderRateLimitForTests(): void {
  nextLiveProviderRequestAt = 0;
  providerRateLimitQueue = Promise.resolve();
}

async function withProviderRateLimit<T>(
  rateLimitMs: number,
  label: string,
  log: ((message: string) => void) | undefined,
  traceTimings: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = providerRateLimitQueue;
  let release!: () => void;
  providerRateLimitQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queuedAt = performance.now();
  await previous;
  try {
    const queuedMs = performance.now() - queuedAt;
    if (traceTimings && queuedMs >= 1) {
      log?.(`${label} rate limit: queue wait complete (${queuedMs.toFixed(1)} ms)`);
    }
    const rawWaitMs = nextLiveProviderRequestAt - performance.now();
    const waitMs = rawWaitMs < 0 ? 0 : rawWaitMs;
    if (waitMs > 0) {
      log?.(`${label} rate limit: waiting ${String(waitMs)} ms before next live provider request`);
      await sleep(waitMs);
    }
    return await operation();
  } finally {
    nextLiveProviderRequestAt = Math.max(nextLiveProviderRequestAt, performance.now() + rateLimitMs);
    release();
  }
}

function postponeProviderRateLimit(delayMs: number): void {
  nextLiveProviderRequestAt = Math.max(nextLiveProviderRequestAt, performance.now() + delayMs);
}

function shouldRetryHttpStatus(status: number, retry: ProviderRetryOptions): boolean {
  if (retry.retryHttpStatuses !== undefined) return retry.retryHttpStatuses.includes(status);
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

function retryDelayMs(err: ProviderHttpError, attempt: number, retry: ProviderRetryOptions): number {
  if (err.status !== 429) return err.retryAfterMs ?? backoffDelayMs(attempt, retry);
  const providerDelayMs = err.retryAfterMs ?? err.rateLimitResetMs;
  if (providerDelayMs !== null) return Math.max(providerDelayMs, retry.rateLimitMs);
  return Math.max(backoffDelayMs(attempt, retry), retry.rateLimitMs);
}

function rateLimitResetMs(headers: Headers): number | null {
  const requestReset = rateLimitResetHeaderMs(headers.get('x-ratelimit-reset-requests'));
  const tokenReset = rateLimitResetHeaderMs(headers.get('x-ratelimit-reset-tokens'));
  const values = [requestReset, tokenReset].filter((value): value is number => value !== null);
  return values.length === 0 ? null : Math.max(...values);
}

function rateLimitResetHeaderMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const durationMs = rateLimitDurationMs(trimmed);
  if (durationMs !== null) return durationMs;
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - Date.now());
}

function rateLimitDurationMs(value: string): number | null {
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/giu;
  let totalMs = 0;
  let matched = false;
  for (const match of value.matchAll(pattern)) {
    const amount = Number(match[1]);
    const unit = match[2]?.toLowerCase();
    if (!Number.isFinite(amount) || unit === undefined) return null;
    matched = true;
    totalMs +=
      unit === 'ms' ? amount : unit === 's' ? amount * 1000 : unit === 'm' ? amount * 60_000 : amount * 3_600_000;
  }
  return matched ? Math.round(totalMs) : null;
}

function providerHttpErrorDetail(response: Response, text: string): string | null {
  const parts = [rateLimitHeaderDetail(response.headers), providerErrorBodyDetail(text)].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  return parts.length === 0 ? null : parts.join('; ');
}

function rateLimitHeaderDetail(headers: Headers): string | null {
  const names = [
    'x-ratelimit-limit-requests',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-remaining-requests',
    'x-ratelimit-remaining-tokens',
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens',
    'retry-after',
  ] as const;
  const pairs = names
    .map((name) => {
      const value = headers.get(name);
      return value ? `${name}=${value}` : null;
    })
    .filter((pair): pair is string => pair !== null);
  return pairs.length === 0 ? null : `rate limit headers: ${pairs.join(', ')}`;
}

function providerErrorBodyDetail(text: string): string | null {
  const body = text.trim();
  if (body.length === 0) return null;
  const parsed = parseProviderErrorBody(body);
  if (parsed === null) return null;
  const normalized = parsed.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return null;
  return `response body: ${normalized.slice(0, 500)}`;
}

function parseProviderErrorBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    const message = dataValue(parsed, ['error', 'message']);
    const type = dataValue(parsed, ['error', 'type']);
    const code = dataValue(parsed, ['error', 'code']);
    const pieces = [
      typeof message === 'string' ? message : null,
      typeof type === 'string' ? `type=${type}` : null,
      typeof code === 'string' ? `code=${code}` : null,
    ].filter((piece): piece is string => piece !== null && piece.length > 0);
    return pieces.length === 0 ? null : pieces.join(' ');
  } catch {
    return null;
  }
}

function backoffDelayMs(attempt: number, options: ProviderRetryOptions): number {
  const raw = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
  const jitter = Math.round(raw * (0.8 + Math.random() * 0.4));
  return Math.max(0, jitter);
}

function traceProviderTiming(retry: ProviderRetryOptions | undefined, message: string): void {
  if (retry?.traceTimings === true) retry.log?.(message);
}

function traceProviderStatus(retry: ProviderRetryOptions | undefined, message: string): void {
  if (retry?.traceTimings === true) {
    if (retry.status) retry.status(message);
    else retry.log?.(message);
  }
}

function abortSignal(retry: ProviderRetryOptions | undefined): AbortSignal | undefined {
  const timeoutMs = retry?.timeoutMs;
  if (timeoutMs === undefined || timeoutMs <= 0) return undefined;
  return AbortSignal.timeout(timeoutMs);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function providerTransportError(err: unknown): ProviderTransportError | null {
  if (!(err instanceof Error)) return null;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') {
    return new ProviderTransportError('PROVIDER_TIMEOUT', err.message || 'provider request timed out', err);
  }
  if (err.name !== 'TypeError' || !/fetch failed/i.test(err.message)) return null;
  const cause = (err as { cause?: unknown }).cause;
  const code = transportCauseCode(cause);
  const detail = transportCauseDetail(cause);
  return new ProviderTransportError(code, detail, err);
}

function transportCauseCode(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) return code;
  }
  return 'FETCH_FAILED';
}

function transportCauseDetail(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return 'fetch failed before an HTTP response was available';
}

function positiveInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function truthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function extractMaxTokensFromEnv(env: NodeJS.ProcessEnv): number {
  return positiveInt(env['DEMO_EXTRACT_MAX_TOKENS'], DEFAULT_EXTRACT_MAX_TOKENS, 'DEMO_EXTRACT_MAX_TOKENS');
}

function visionMaxTokensFromEnv(env: NodeJS.ProcessEnv): number {
  return positiveInt(env['DEMO_VISION_MAX_TOKENS'], DEFAULT_EXTRACT_MAX_TOKENS, 'DEMO_VISION_MAX_TOKENS');
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
