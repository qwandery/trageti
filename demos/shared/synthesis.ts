import type {
  AssembledContext,
  ContextAssemblyOptions,
  RetrievalQuery,
  RetrievedAssertion,
  TemporalStore,
} from 'trageti';
import type { ExtractionProvider } from './providers.js';

export const DEFAULT_SYNTHESIS_TOKEN_BUDGET = 1000;

export interface SynthesisContextMeta {
  includedAssertions: number;
  totalAssertions: number;
  tokenEstimate: number;
  truncated: boolean;
  positionRange: { from: number; to: number };
}

export interface SynthesisResult {
  text: string;
  mode: 'live' | 'template';
  context: SynthesisContextMeta;
}

export interface GenerateAssembledAnswerOptions {
  store: Pick<TemporalStore, 'assembleContext'>;
  extractor: ExtractionProvider;
  query: RetrievalQuery;
  annotation: string;
  tokenBudget?: number;
  live?: boolean;
}

export interface GenerateNarrativeSynthesisOptions {
  store: Pick<TemporalStore, 'assembleContext'>;
  extractor: ExtractionProvider;
  namespace: string;
  queryText: string;
  temporalAnchor: number;
  tokenBudget?: number;
  retrievalStrategy?: RetrievalQuery['retrievalStrategy'];
  live?: boolean;
  liveInstruction: string;
  fixtureText?: string;
}

export async function generateAssembledAnswer(options: GenerateAssembledAnswerOptions): Promise<SynthesisResult> {
  const ctx = await options.store.assembleContext(contextOptionsFromQuery(options.query, options.tokenBudget));
  const live = shouldUseLiveExtractor(options.extractor, options.live);
  if (live) {
    return {
      text: await options.extractor.extract(answerPrompt(options.annotation, options.query, ctx)),
      mode: 'live',
      context: contextMeta(ctx),
    };
  }
  return {
    text: templateAnswer(options.query, ctx),
    mode: 'template',
    context: contextMeta(ctx),
  };
}

export async function generateNarrativeSynthesis(options: GenerateNarrativeSynthesisOptions): Promise<SynthesisResult> {
  const ctx = await options.store.assembleContext({
    namespace: options.namespace,
    queryText: options.queryText,
    temporalAnchor: options.temporalAnchor,
    tokenBudget: options.tokenBudget ?? DEFAULT_SYNTHESIS_TOKEN_BUDGET,
    ...(options.retrievalStrategy ? { retrievalStrategy: options.retrievalStrategy } : {}),
  });
  const live = shouldUseLiveExtractor(options.extractor, options.live);
  if (live) {
    return {
      text: await options.extractor.extract(narrativePrompt(options.liveInstruction, ctx)),
      mode: 'live',
      context: contextMeta(ctx),
    };
  }
  return {
    text: options.fixtureText ?? templateAnswer({ queryText: options.queryText }, ctx),
    mode: 'template',
    context: contextMeta(ctx),
  };
}

function contextOptionsFromQuery(query: RetrievalQuery, tokenBudget?: number): ContextAssemblyOptions {
  const options: ContextAssemblyOptions = {
    namespace: query.namespace,
    temporalAnchor: query.temporalAnchor,
    tokenBudget: tokenBudget ?? DEFAULT_SYNTHESIS_TOKEN_BUDGET,
  };
  if (query.queryEmbedding !== undefined) options.queryEmbedding = query.queryEmbedding;
  if (query.queryText !== undefined) options.queryText = query.queryText;
  if (query.queryTextMode !== undefined) options.queryTextMode = query.queryTextMode;
  if (query.expandLinks !== undefined) options.expandLinks = query.expandLinks;
  if (query.maxDepth !== undefined) options.maxDepth = query.maxDepth;
  if (query.mode !== undefined) options.mode = query.mode;
  if (query.retrievalStrategy !== undefined) options.retrievalStrategy = query.retrievalStrategy;
  if (query.scorer !== undefined) options.scorer = query.scorer;
  if (query.middleware !== undefined) options.middleware = query.middleware;
  if (query.debug !== undefined) options.debug = query.debug;
  if (query.signal !== undefined) options.signal = query.signal;
  return options;
}

function shouldUseLiveExtractor(extractor: ExtractionProvider, live?: boolean): boolean {
  return live ?? extractor.provenance.kind !== 'fixture';
}

function contextMeta(ctx: AssembledContext): SynthesisContextMeta {
  return {
    includedAssertions: ctx.coverage.includedAssertions,
    totalAssertions: ctx.coverage.totalAssertions,
    tokenEstimate: ctx.tokenEstimate,
    truncated: ctx.truncated,
    positionRange: ctx.coverage.positionRange,
  };
}

function answerPrompt(annotation: string, query: RetrievalQuery, ctx: AssembledContext): string {
  return `Answer the demo query using only the assembled context below.

Query label: ${annotation}
Query text: ${query.queryText ?? '(query embedding only)'}
Temporal anchor: ${String(query.temporalAnchor)}
Retrieval mode: ${query.mode ?? 'snapshot'}

Rules:
- Write one concise grounded paragraph.
- Do not use outside knowledge.
- If the context is insufficient, say what is missing.
- Preserve temporal uncertainty and supersession when the context shows a change over time.

Context:
${ctx.text}`;
}

function narrativePrompt(instruction: string, ctx: AssembledContext): string {
  return `${instruction}

Use only the assembled context below. Be specific, avoid lists, and do not invent facts that are not directly supported. If the context is insufficient, preserve that uncertainty.

Context:
${ctx.text}`;
}

function templateAnswer(query: Pick<RetrievalQuery, 'queryText' | 'mode'>, ctx: AssembledContext): string {
  if (ctx.assertions.length === 0) {
    return 'The assembled context did not include any assertions for this query, so the demo cannot synthesize a supported answer.';
  }
  const selected = highestSignalAssertions(ctx.assertions, 4);
  const topic = query.queryText ? ` for "${query.queryText}"` : '';
  const trajectoryNote =
    query.mode === 'trajectory'
      ? ' Because this is trajectory context, the answer reflects how the stored picture changes over time.'
      : '';
  const truncationNote = ctx.truncated
    ? ' The context was truncated, so lower-priority supporting assertions may be omitted.'
    : '';
  return (
    `Based on ${String(ctx.coverage.includedAssertions)} assembled assertion(s)${topic}, the supported answer is: ` +
    sentenceList(selected.map((assertion) => assertion.content)) +
    `.${trajectoryNote}${truncationNote}`
  );
}

function highestSignalAssertions(assertions: readonly RetrievedAssertion[], limit: number): RetrievedAssertion[] {
  return [...assertions]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.validFrom !== b.validFrom) return a.validFrom - b.validFrom;
      return a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}

function sentenceList(parts: readonly string[]): string {
  const cleaned = parts.map((part) => stripTrailingPunctuation(part.trim())).filter((part) => part.length > 0);
  if (cleaned.length === 0) return 'no assertion text was available';
  if (cleaned.length === 1) return cleaned[0] ?? '';
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`;
  return `${cleaned.slice(0, -1).join('; ')}; and ${cleaned[cleaned.length - 1]}`;
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.!?]+$/u, '');
}
