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
): ExtractionProvider {
  return {
    name: 'anthropic',
    label: `anthropic:${model}`,
    provenance: provenance({ kind: 'anthropic', model }),
    async extract(prompt) {
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
    },
  };
}

export function createOpenAICompatibleExtractionProvider(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  label?: string;
}): ExtractionProvider {
  return {
    name: 'openai-compatible',
    label: options.label ?? `openai-compatible:${options.model}`,
    provenance: provenance({ kind: 'openai-compatible', model: options.model, baseUrl: options.baseUrl }),
    async extract(prompt) {
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
    },
  };
}

export function createOpenAICompatibleEmbeddingProvider(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimension: number;
  label?: string;
}): DemoEmbeddingProvider {
  const provider: EmbeddingProvider = {
    name: options.label ?? 'openai-compatible',
    dimension: options.dimension,
    async embed(texts: readonly string[], embedOptions?: EmbedOptions): Promise<Float32Array[]> {
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
      const data = await readJsonResponse(response, `${options.label ?? 'OpenAI-compatible'} embedding`);
      const rows = dataValue(data, ['data']);
      if (!Array.isArray(rows)) throw new Error('OpenAI-compatible embedding response missing data[]');
      return rows.map((row, i) => {
        const embedding = dataValue(row, ['embedding']);
        if (!Array.isArray(embedding))
          throw new Error(`OpenAI-compatible embedding response missing data[${String(i)}].embedding`);
        return new Float32Array(embedding as number[]);
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
}): DemoEmbeddingProvider {
  const provider: EmbeddingProvider = {
    name: 'ollama-native',
    dimension: options.dimension,
    async embed(texts: readonly string[], embedOptions?: EmbedOptions): Promise<Float32Array[]> {
      return Promise.all(
        texts.map(async (text) => {
          const response = await fetch(`${trimSlash(options.host)}/api/embeddings`, {
            method: 'POST',
            ...(embedOptions?.signal ? { signal: embedOptions.signal } : {}),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: options.model, prompt: text }),
          });
          const data = await readJsonResponse(response, 'Ollama native embedding');
          const embedding = dataValue(data, ['embedding']);
          if (!Array.isArray(embedding)) throw new Error('Ollama native embedding response missing embedding');
          return new Float32Array(embedding as number[]);
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
      : resolveExtractionProvider(extractProvider, env);
  let embedder =
    embedProvider === 'fixture'
      ? createRawVectorEmbeddingProvider({
          fixtures: options.fixtures,
          assertionEmbeddings: options.assertionEmbeddings,
          queryEmbeddings: options.queryEmbeddings,
          queryTexts: options.queryTexts,
          dimension: options.embeddingDimension,
        })
      : resolveEmbeddingProvider(embedProvider, env, options.embeddingDimension);
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
  const extractor = resolveExtractionProvider(provider, env);
  return trace?.enabled ? traceExtractionProvider(extractor, trace) : extractor;
}

export function resolveLiveEmbeddingProvider(options: ResolveLiveProvidersOptions): DemoEmbeddingProvider {
  const env = options.env ?? process.env;
  const provider = env['DEMO_EMBED_PROVIDER'] ?? inferEmbeddingProvider(env, true);
  if (provider === 'fixture') throw new Error('A live embedding provider is required; set DEMO_EMBED_PROVIDER.');
  const embedder = resolveEmbeddingProvider(provider, env, options.embeddingDimension);
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

function resolveExtractionProvider(provider: string, env: NodeJS.ProcessEnv): ExtractionProvider {
  if (provider === 'fixture') return createFixtureExtractionProvider({});
  if (provider === 'anthropic') {
    const apiKey = required(
      env['DEMO_EXTRACT_API_KEY'] ?? env['ANTHROPIC_API_KEY'],
      'DEMO_EXTRACT_API_KEY or ANTHROPIC_API_KEY',
    );
    return createAnthropicExtractionProvider(apiKey, env['DEMO_EXTRACT_MODEL'] ?? 'claude-sonnet-4-20250514');
  }
  if (provider === 'openai-compatible') {
    const preset = openAICompatPreset(env, 'extract');
    return createOpenAICompatibleExtractionProvider({
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: env['DEMO_EXTRACT_MODEL'] ?? preset.defaultModel,
      label: preset.label,
    });
  }
  throw new Error(`Unsupported DEMO_EXTRACT_PROVIDER "${provider}". Use fixture, anthropic, or openai-compatible.`);
}

function resolveEmbeddingProvider(provider: string, env: NodeJS.ProcessEnv, dimension: number): DemoEmbeddingProvider {
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
    });
  }
  if (provider === 'ollama-native') {
    const host = required(env['DEMO_EMBED_BASE_URL'] ?? env['OLLAMA_HOST'], 'DEMO_EMBED_BASE_URL or OLLAMA_HOST');
    return createOllamaNativeEmbeddingProvider({
      host,
      model: env['DEMO_EMBED_MODEL'] ?? 'nomic-embed-text',
      dimension: resolvedDimension,
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
    throw new Error(`${label} failed HTTP ${String(response.status)} ${response.statusText}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} returned non-JSON response (${msg})`);
  }
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
