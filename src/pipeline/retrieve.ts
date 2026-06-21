import type { Database } from 'better-sqlite3';
import type {
  RetrievalQuery,
  RetrievalResult,
  RetrievalMeta,
  RetrievedAssertion,
  Assertion,
  IRetrievalScorer,
  RetrievalMiddleware,
  GraphQueryAdapter,
  ScoredCandidate,
  QueryTextMode,
  RetrievalStrategy,
  RetrievalStep,
  RetrievalStepInfo,
} from '../domain/types.js';
import type { AssertionRepository } from '../db/repositories/AssertionRepository.js';
import type { EmbeddingRepository } from '../db/repositories/EmbeddingRepository.js';
import { buildCandidateJson } from '../db/candidates.js';
import { quoteIdent } from '../internal/sql-ident.js';
import { applyAfterHooks, applyMiddleware } from './middleware.js';
import { ErrorCode, RetrievalInputError, errorCodeOf } from '../errors/index.js';
import type { Logger, Metrics } from '../internal/logger.js';
import { observe } from '../internal/logger.js';
import { DEFAULT_RETRIEVAL_LIMIT, OVERSAMPLE_MULTIPLIER } from '../internal/retrieval-defaults.js';
import {
  finiteNumberError,
  literalOptionError,
  nonNegativeIntegerOptionError,
  positiveIntegerOptionError,
  stringArrayOptionError,
} from '../internal/validate.js';

interface RetrieveContext {
  assertionRepo: AssertionRepository;
  embeddingRepo: EmbeddingRepository;
  getEmbeddingTable: (namespace: string) => string | null;
  getPositionRange: (namespace: string) => { min: number | null; max: number | null };
  /** Configured embedding dimension for a namespace, or null if vectorless. */
  getDimension: (namespace: string) => number | null;
  globalScorer: IRetrievalScorer;
  globalMiddleware: readonly RetrievalMiddleware[];
  graphAdapter: GraphQueryAdapter;
  logger: Logger;
  metrics: Metrics | null;
}

/**
 * Invoke a `RetrievalDebug.onStep` hook safely. The hook is synchronous and
 * must not throw; a throwing handler is wrapped, swallowed, and logged once
 * as `TRGT_RETRIEVAL_DEBUG_HOOK_ERROR` so a broken hook never breaks retrieval.
 */
function debugStep(
  query: RetrievalQuery,
  logger: Logger,
  step: RetrievalStep,
  info: Omit<RetrievalStepInfo, 'step'>,
): void {
  const hook = query.debug?.onStep;
  if (!hook) return;
  try {
    hook(step, { step, ...info });
  } catch (err) {
    // Never log the raw error — it may carry caller content, query text, or
    // secrets. Only the thrown error's stable code (or 'UNKNOWN') is recorded.
    logger.warn('TRGT_RETRIEVAL_DEBUG_HOOK_ERROR', { step, errorCode: errorCodeOf(err) });
  }
}

interface Step1Row {
  id: string;
  content: string;
  valid_from: number;
  confidence: number;
  entity_type: string | null;
  created_at: string;
}

interface Step2Row {
  assertion_id: string;
  semantic_distance: number;
}

interface Step3Row {
  assertion_id: string;
  bm25_score: number;
}

const RETRIEVAL_STRATEGIES = ['hybrid', 'vector', 'bm25'] as const;
const RETRIEVAL_MODES = ['snapshot', 'trajectory'] as const;
const QUERY_TEXT_MODES = ['phrase', 'fts5'] as const;

export function validateRetrievalQuery(query: RetrievalQuery): void {
  const limit = query.limit ?? DEFAULT_RETRIEVAL_LIMIT;
  const limitError = positiveIntegerOptionError(limit, 'limit');
  if (limitError) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_LIMIT, limitError);

  const anchorError = finiteNumberError(query.temporalAnchor, 'temporalAnchor');
  if (anchorError) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_TEMPORAL_ANCHOR, anchorError);

  if (query.retrievalStrategy !== undefined) {
    const err = literalOptionError(query.retrievalStrategy, 'retrievalStrategy', RETRIEVAL_STRATEGIES);
    if (err) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_STRATEGY, err);
  }
  if (query.mode !== undefined) {
    const err = literalOptionError(query.mode, 'mode', RETRIEVAL_MODES);
    if (err) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_MODE, err);
  }
  if (query.queryTextMode !== undefined) {
    const err = literalOptionError(query.queryTextMode, 'queryTextMode', QUERY_TEXT_MODES);
    if (err) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_QUERY_TEXT_MODE, err);
  }
  if (query.maxDepth !== undefined) {
    const err = nonNegativeIntegerOptionError(query.maxDepth, 'maxDepth');
    if (err) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_MAX_DEPTH, err);
  }

  const tw = query.temporalWindow;
  if (tw?.from !== undefined) {
    const err = finiteNumberError(tw.from, 'temporalWindow.from');
    if (err) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_TEMPORAL_WINDOW, err);
  }
  if (tw?.to !== undefined) {
    const err = finiteNumberError(tw.to, 'temporalWindow.to');
    if (err) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_TEMPORAL_WINDOW, err);
  }
  if (tw?.from !== undefined && tw.to !== undefined && tw.from > tw.to) {
    throw new RetrievalInputError(
      ErrorCode.RETRIEVAL_INVALID_TEMPORAL_WINDOW,
      `temporalWindow.from (${String(tw.from)}) must not exceed temporalWindow.to (${String(tw.to)})`,
    );
  }

  if (
    query.minConfidence !== undefined &&
    (!Number.isFinite(query.minConfidence) || query.minConfidence < 0 || query.minConfidence > 1)
  ) {
    throw new RetrievalInputError(
      ErrorCode.RETRIEVAL_INVALID_CONFIDENCE,
      `minConfidence must be within [0, 1], got ${String(query.minConfidence)}`,
    );
  }
  if (query.entityTypes !== undefined) {
    const err = stringArrayOptionError(query.entityTypes, 'entityTypes');
    if (err) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_FILTER, err);
  }
  if (query.assertionTypes !== undefined) {
    const err = stringArrayOptionError(query.assertionTypes, 'assertionTypes');
    if (err) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_FILTER, err);
  }
}

export function retrieve(
  db: Database,
  ctx: RetrieveContext,
  query: RetrievalQuery,
  options: { skipBefore?: boolean } = {},
): RetrievalResult {
  const started = Date.now();
  const callMiddleware = query.middleware ?? [];
  const core = (q: RetrievalQuery): RetrievalResult => retrieveCore(db, ctx, q);
  const result = options.skipBefore ? core(query) : applyMiddleware(ctx.globalMiddleware, callMiddleware, query, core);
  if (options.skipBefore) {
    result.results = applyAfterHooks(ctx.globalMiddleware, callMiddleware, result.results, query);
  }
  result.meta.tookMs = Date.now() - started;
  observe(ctx.metrics ?? undefined, 'trageti.retrieve.tookMs', result.meta.tookMs);
  observe(ctx.metrics ?? undefined, 'trageti.retrieve.candidateCount', result.meta.candidateCount);
  return result;
}

/**
 * Escape user input for safe FTS5 phrase matching. Wraps in double quotes
 * and escapes inner double quotes; FTS5 treats the result as a literal
 * phrase rather than operator syntax (spec §queryTextMode: 'phrase' default).
 */
function escapeFts5Phrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

function buildMeta(
  query: RetrievalQuery,
  limit: number,
  strategy: RetrievalStrategy,
  queryTextMode: QueryTextMode | null,
  opts: { candidateCount: number; vectorApplied: boolean; bm25Applied: boolean },
): RetrievalMeta {
  return {
    namespace: query.namespace,
    temporalAnchor: query.temporalAnchor,
    limit,
    candidateCount: opts.candidateCount,
    retrievalStrategy: strategy,
    vectorApplied: opts.vectorApplied,
    bm25Applied: opts.bm25Applied,
    queryTextMode,
    warnings: [],
  };
}

function retrieveCore(db: Database, ctx: RetrieveContext, query: RetrievalQuery): RetrievalResult {
  validateRetrievalQuery(query);
  const limit = query.limit ?? DEFAULT_RETRIEVAL_LIMIT;
  const oversample = limit * OVERSAMPLE_MULTIPLIER;
  const mode = query.mode ?? 'snapshot';
  const strategy = query.retrievalStrategy ?? 'hybrid';
  const queryTextMode = query.queryTextMode ?? 'phrase';

  // Treat a whitespace-only queryText as absent.
  const hasQueryText = typeof query.queryText === 'string' && query.queryText.trim().length > 0;
  const hasQueryEmbedding = Boolean(query.queryEmbedding);

  // Meta reports the effective query-text mode only when a queryText was
  // actually supplied; a vector-only call carries no text mode.
  const metaQueryTextMode: QueryTextMode | null = hasQueryText ? queryTextMode : null;
  const emptyMeta = (vectorApplied: boolean, bm25Applied: boolean): RetrievalMeta =>
    buildMeta(query, limit, strategy, metaQueryTextMode, {
      candidateCount: 0,
      vectorApplied,
      bm25Applied,
    });
  const applyVector = strategy !== 'bm25' && hasQueryEmbedding;
  const embeddingTable = applyVector ? ctx.getEmbeddingTable(query.namespace) : null;
  const vectorCanRun = applyVector && embeddingTable !== null;
  const vectorSkipReason = applyVector && !vectorCanRun ? 'VECTOR_INDEX_NOT_READY' : null;
  const applyBm25 = strategy !== 'vector' && hasQueryText;

  if (strategy === 'vector' && vectorSkipReason !== null) {
    throw new RetrievalInputError(
      ErrorCode.RETRIEVAL_VECTOR_INDEX_NOT_READY,
      `Namespace "${query.namespace}" has no readable vector index table; index assertions before vector retrieval.`,
    );
  }

  const withVectorWarning = (result: RetrievalResult): RetrievalResult => {
    if (vectorSkipReason !== null) {
      result.meta.warnings.push({
        code: 'TRGT_RETRIEVE_VECTOR_SKIPPED',
        message: `vector retrieval skipped: ${vectorSkipReason}`,
      });
    }
    return result;
  };

  // Per-step wall-clock: each call returns the ms elapsed since the previous
  // call, i.e. the duration of the step just completed.
  let stepStart = Date.now();
  const sinceStep = (): number => {
    const now = Date.now();
    const d = now - stepStart;
    stepStart = now;
    return d;
  };

  // Strategy-specific input validation.
  if (strategy === 'vector' && !hasQueryEmbedding) {
    throw new RetrievalInputError(
      ErrorCode.RETRIEVAL_REQUIRES_VECTOR_INPUT,
      "retrievalStrategy 'vector' requires queryEmbedding or an embedding provider",
    );
  }
  if (strategy === 'bm25' && !hasQueryText) {
    throw new RetrievalInputError(
      ErrorCode.RETRIEVAL_REQUIRES_QUERY_TEXT,
      "retrievalStrategy 'bm25' requires a non-empty queryText",
    );
  }
  if (!hasQueryText && !hasQueryEmbedding) {
    throw new RetrievalInputError(
      ErrorCode.RETRIEVAL_INPUT_EMPTY,
      'retrieve requires a non-empty queryText, a queryEmbedding, or both',
    );
  }

  // queryEmbedding length vs the namespace's configured dimension.
  if (query.queryEmbedding) {
    const dim = ctx.getDimension(query.namespace);
    if (dim !== null && query.queryEmbedding.length !== dim) {
      throw new RetrievalInputError(
        ErrorCode.RETRIEVAL_DIMENSION_MISMATCH,
        `queryEmbedding length ${String(query.queryEmbedding.length)} does not match namespace dimension ${String(dim)}`,
      );
    }
  }

  debugStep(query, ctx.logger, 'validate', {
    candidateCount: 0,
    tookMs: sinceStep(),
  });

  // Step 1: Temporal filter (applies in all strategies). BM25-only and
  // hybrid fallback push these predicates into the FTS query instead of
  // materializing every temporal candidate id in JS first.
  const useFtsBoundedTemporalSelection = !vectorCanRun && applyBm25 && hasQueryText;
  const step1 = useFtsBoundedTemporalSelection ? [] : runStep1(db, query);
  const temporalCandidateCount = useFtsBoundedTemporalSelection ? countStep1(db, query) : step1.length;
  debugStep(query, ctx.logger, 'temporal-filter', {
    candidateCount: temporalCandidateCount,
    tookMs: sinceStep(),
  });
  if (temporalCandidateCount === 0) {
    return withVectorWarning({
      results: [],
      meta: emptyMeta(strategy !== 'bm25' && hasQueryEmbedding, strategy !== 'vector' && hasQueryText),
    });
  }

  const candidateJson = useFtsBoundedTemporalSelection ? null : buildCandidateJson(step1.map((r) => r.id));
  const step1Map = new Map(step1.map((r) => [r.id, r]));

  // Step 2: Vector candidate selection (when applicable).
  const step2Rows: Step2Row[] = [];
  if (applyVector && query.queryEmbedding) {
    const rows =
      embeddingTable === null || candidateJson === null
        ? []
        : runStep2(db, embeddingTable, candidateJson, query.queryEmbedding, oversample);
    for (const r of rows) step2Rows.push(r);
  }
  debugStep(query, ctx.logger, 'semantic', {
    applied: vectorCanRun,
    candidateCount: step2Rows.length,
    tookMs: sinceStep(),
  });

  // Step 3: BM25. When Step 2 (vector) ran, BM25 is a *re-scoring* step over
  // the vector-selected candidates only — it attaches keyword scores, it does
  // not contribute its own candidates (spec §2581-2582, §2661-2665). When
  // Step 2 was skipped (bm25 strategy, or hybrid fallback), BM25 selects over
  // the full temporal candidate set.
  const bm25Map = new Map<string, number>();
  if (applyBm25 && query.queryText) {
    const ftsText = queryTextMode === 'phrase' ? escapeFts5Phrase(query.queryText) : query.queryText;
    // BM25-only (Step 2 skipped) selects candidates, so it is ordered + capped
    // by relevance; the hybrid re-rank branch only attaches scores (no limit).
    const bm25Limit = vectorCanRun ? undefined : oversample;
    try {
      const step3 = vectorCanRun
        ? runStep3(db, buildCandidateJson(step2Rows.map((r) => r.assertion_id)), ftsText, bm25Limit)
        : runStep3Temporal(db, query, ftsText, oversample);
      for (const row of step3) bm25Map.set(row.assertion_id, row.bm25_score);
    } catch (err) {
      // A malformed raw FTS5 expression surfaces as a SQLite parse error. Under
      // 'phrase' mode the escaping above prevents this; under 'fts5' mode the
      // caller's expression is at fault. Never echo the offending query text or
      // the raw SQLite syntax fragment — both can carry caller content
      // (spec Security Considerations: untrusted query text).
      if (queryTextMode === 'fts5') {
        throw new RetrievalInputError(
          ErrorCode.RETRIEVAL_INVALID_QUERY_TEXT,
          "queryText is not a valid FTS5 expression for queryTextMode: 'fts5'. " +
            "Use queryTextMode: 'phrase' for literal text, or correct the FTS5 query syntax.",
        );
      }
      throw err;
    }
  }

  debugStep(query, ctx.logger, 'keyword', {
    applied: applyBm25,
    candidateCount: bm25Map.size,
    tookMs: sinceStep(),
  });

  // Build the candidate set. When Step 2 ran, the candidates are exactly the
  // vector-selected rows (BM25 only re-scored them) — a BM25-only hit never
  // enters a hybrid+vector result. When Step 2 was skipped, the BM25 hits are
  // the candidate set.
  const candidateIds = new Set<string>();
  if (vectorCanRun) {
    for (const r of step2Rows) candidateIds.add(r.assertion_id);
  } else {
    for (const id of bm25Map.keys()) candidateIds.add(id);
  }
  if (candidateIds.size === 0) {
    return withVectorWarning({ results: [], meta: emptyMeta(vectorCanRun, applyBm25) });
  }

  const oversampledIds = useFtsBoundedTemporalSelection
    ? [...candidateIds]
    : [...candidateIds].filter((id) => step1Map.has(id));
  const hydrated = ctx.assertionRepo.getByIds(oversampledIds);
  const hydratedById = new Map(hydrated.map((a) => [a.id, a]));
  const semanticById = new Map(step2Rows.map((r) => [r.assertion_id, r.semantic_distance]));
  if (useFtsBoundedTemporalSelection) {
    for (const assertion of hydrated) {
      step1Map.set(assertion.id, {
        id: assertion.id,
        content: assertion.content,
        valid_from: assertion.validFrom,
        confidence: assertion.confidence,
        entity_type: assertion.entityType,
        created_at: assertion.createdAt,
      });
    }
  }

  const candidates: Array<{
    id: string;
    candidate: ScoredCandidate;
    s1: Step1Row;
    assertion: Assertion;
  }> = [];
  for (const id of oversampledIds) {
    const s1row = step1Map.get(id);
    const assertion = hydratedById.get(id);
    if (!s1row || !assertion) continue;
    candidates.push({
      id,
      s1: s1row,
      assertion,
      candidate: {
        assertion,
        semanticDistance: semanticById.get(id) ?? null,
        bm25Score: bm25Map.get(id) ?? null,
        position: s1row.valid_from,
      },
    });
  }

  // Step 4: Score.
  const scorer = query.scorer ?? ctx.globalScorer;
  const positionRange = ctx.getPositionRange(query.namespace);
  const scoringContext = {
    temporalAnchor: query.temporalAnchor,
    namespacePositionRange: positionRange,
    query,
  };

  const scores = scorer.scoreBatch(
    candidates.map((c) => c.candidate),
    scoringContext,
  );
  if (scores.length !== candidates.length) {
    throw new RetrievalInputError(
      ErrorCode.SCORER_BATCH_LENGTH_MISMATCH,
      `RetrievalScorer.scoreBatch returned ${String(scores.length)} scores for ${String(candidates.length)} candidates`,
    );
  }
  // Scorer output must be finite — NaN / ±Infinity would corrupt ranking.
  for (const s of scores) {
    if (!Number.isFinite(s)) {
      throw new RetrievalInputError(
        ErrorCode.SCORER_INVALID_OUTPUT,
        `RetrievalScorer produced a non-finite score (${String(s)})`,
      );
    }
  }
  debugStep(query, ctx.logger, 'score', {
    candidateCount: candidates.length,
    tookMs: sinceStep(),
  });

  // Step 5: Rank + truncate with deterministic tie-breaking
  //   (score DESC, validFrom DESC, createdAt ASC, id ASC).
  const ranked = candidates.map((c, i) => ({ ...c, score: scores[i] ?? 0 }));
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.s1.valid_from !== a.s1.valid_from) return b.s1.valid_from - a.s1.valid_from;
    if (a.assertion.createdAt !== b.assertion.createdAt) {
      return a.assertion.createdAt < b.assertion.createdAt ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const topCandidates = ranked.slice(0, limit);

  const results: RetrievedAssertion[] = topCandidates.map((c) => ({
    ...c.candidate.assertion,
    score: c.score,
    scoreComponents: {
      semanticDistance: c.candidate.semanticDistance,
      bm25Score: c.candidate.bm25Score,
      position: c.candidate.assertion.validFrom,
    },
  }));

  // `rank` reports the final ranked + truncated result set. It is emitted here
  // — immediately after sort/truncate — so it precedes the optional graph and
  // trajectory expansion steps, which decorate (never reorder) these results.
  debugStep(query, ctx.logger, 'rank', {
    candidateCount: results.length,
    tookMs: sinceStep(),
  });

  // Step 6: Graph expansion (optional). `includeSuperseded` is a
  // retrieval-wide option, so it propagates into link traversal too.
  let linkedCount = 0;
  if (query.expandLinks && results.length > 0) {
    const fromIds = results.map((r) => r.id);
    const links = ctx.graphAdapter.findConnected(db, query.namespace, fromIds, {
      temporalAnchor: query.temporalAnchor,
      maxDepth: query.maxDepth ?? 1,
      ...(query.includeSuperseded !== undefined && {
        includeSuperseded: query.includeSuperseded,
      }),
    });

    const linkedById = new Map<string, Assertion[]>();
    for (const link of links) {
      const target = ctx.assertionRepo.getById(link.toId);
      if (!target) continue;
      const existing = linkedById.get(link.fromId) ?? [];
      if (!existing.some((a) => a.id === target.id)) {
        existing.push(target);
        linkedById.set(link.fromId, existing);
      }
    }

    for (const result of results) {
      const linked = linkedById.get(result.id);
      if (linked && linked.length > 0) {
        result.linkedAssertions = linked;
        linkedCount += linked.length;
      }
    }
  }
  debugStep(query, ctx.logger, 'graph-expand', {
    applied: Boolean(query.expandLinks && results.length > 0),
    candidateCount: linkedCount,
    tookMs: sinceStep(),
  });

  // Step 7: Trajectory expansion (v0.2). Always populate supersessionChain
  // when mode === 'trajectory' (using [] when there are no predecessors);
  // omit it entirely otherwise.
  let trajectoryCount = 0;
  if (mode === 'trajectory') {
    const chainsById = ctx.assertionRepo.getSupersessionChains(results.map((r) => r.id));
    for (const result of results) {
      const chain = chainsById.get(result.id) ?? [];
      result.supersessionChain = chain.length > 0 ? chain.slice(0, -1) : [];
      trajectoryCount += result.supersessionChain.length;
    }
  }
  debugStep(query, ctx.logger, 'trajectory-expand', {
    applied: mode === 'trajectory',
    candidateCount: trajectoryCount,
    tookMs: sinceStep(),
  });

  return withVectorWarning({
    results,
    meta: buildMeta(query, limit, strategy, metaQueryTextMode, {
      candidateCount: candidates.length,
      vectorApplied: vectorCanRun && step2Rows.length > 0,
      bm25Applied: applyBm25 && bm25Map.size > 0,
    }),
  });
}

function runStep1(db: Database, query: RetrievalQuery): Step1Row[] {
  // `valid_from <= anchor` always applies. The upper bound
  // `(valid_until IS NULL OR valid_until > anchor)` selects exactly the
  // version valid AT the anchor — including the middle of a supersession
  // chain. It is dropped only for includeSuperseded:true, which then returns
  // every assertion that existed by the anchor (closed ones included).
  // NOTE: there is intentionally no `(supersedes_id IS NULL OR valid_until IS
  // NULL)` clause — that would wrongly drop a temporally-valid mid-chain row.
  const { conditions, params } = buildTemporalPredicate(query);

  const sql = `SELECT a.id, a.content, a.valid_from, a.confidence, a.entity_type, a.created_at
               FROM trageti_assertions a
               WHERE ${conditions.join(' AND ')}`;

  return db.prepare<unknown[], Step1Row>(sql).all(...params);
}

function countStep1(db: Database, query: RetrievalQuery): number {
  const { conditions, params } = buildTemporalPredicate(query);
  const row = db
    .prepare<
      unknown[],
      { count: number }
    >(`SELECT COUNT(*) AS count FROM trageti_assertions a WHERE ${conditions.join(' AND ')}`)
    .get(...params);
  return row?.count ?? 0;
}

function buildTemporalPredicate(query: RetrievalQuery): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = ['a.namespace = ?', 'a.valid_from <= ?'];
  const params: unknown[] = [query.namespace, query.temporalAnchor];

  if (!query.includeSuperseded) {
    conditions.push('(a.valid_until IS NULL OR a.valid_until > ?)');
    params.push(query.temporalAnchor);
  }
  if (query.minConfidence !== undefined) {
    conditions.push('a.confidence >= ?');
    params.push(query.minConfidence);
  }
  if (query.temporalWindow?.from !== undefined) {
    conditions.push('a.valid_from >= ?');
    params.push(query.temporalWindow.from);
  }
  if (query.temporalWindow?.to !== undefined) {
    conditions.push('a.valid_from <= ?');
    params.push(query.temporalWindow.to);
  }
  if (query.entityTypes && query.entityTypes.length > 0) {
    conditions.push(`a.entity_type IN (${query.entityTypes.map(() => '?').join(',')})`);
    params.push(...query.entityTypes);
  }
  if (query.assertionTypes && query.assertionTypes.length > 0) {
    conditions.push(`a.type IN (${query.assertionTypes.map(() => '?').join(',')})`);
    params.push(...query.assertionTypes);
  }

  return { conditions, params };
}

function runStep2(
  db: Database,
  embeddingTable: string,
  candidateJson: string,
  queryEmbedding: Float32Array | number[],
  limit: number,
): Step2Row[] {
  const vec = queryEmbedding instanceof Float32Array ? queryEmbedding : new Float32Array(queryEmbedding);
  const sql = `
    SELECT ae.assertion_id,
           vec_distance_cosine(ae.embedding, ?) AS semantic_distance
    FROM ${quoteIdent(embeddingTable)} ae
    WHERE ae.assertion_id IN (SELECT value FROM json_each(?))
    ORDER BY semantic_distance ASC
    LIMIT ?
  `;
  return db.prepare<unknown[], Step2Row>(sql).all(vec, candidateJson, limit);
}

function runStep3(db: Database, candidateJson: string, queryText: string, limit?: number): Step3Row[] {
  // When `limit` is given (BM25-only candidate selection), order by relevance
  // and cap; the hybrid re-rank caller omits it and just attaches scores.
  const tail = limit !== undefined ? 'ORDER BY bm25(trageti_fulltext) ASC LIMIT ?' : '';
  const sql = `
    SELECT a.id AS assertion_id, bm25(trageti_fulltext) AS bm25_score
    FROM trageti_fulltext
    JOIN trageti_assertions a ON a.rowid = trageti_fulltext.rowid
    WHERE trageti_fulltext MATCH ?
      AND a.id IN (SELECT value FROM json_each(?))
    ${tail}
  `;
  const params: unknown[] = limit !== undefined ? [queryText, candidateJson, limit] : [queryText, candidateJson];
  return db.prepare<unknown[], Step3Row>(sql).all(...params);
}

function runStep3Temporal(db: Database, query: RetrievalQuery, queryText: string, limit: number): Step3Row[] {
  const { conditions, params } = buildTemporalPredicate(query);
  const sql = `
    SELECT a.id AS assertion_id, bm25(trageti_fulltext) AS bm25_score
    FROM trageti_fulltext
    JOIN trageti_assertions a ON a.rowid = trageti_fulltext.rowid
    WHERE trageti_fulltext MATCH ?
      AND ${conditions.join(' AND ')}
    ORDER BY bm25(trageti_fulltext) ASC
    LIMIT ?
  `;
  return db.prepare<unknown[], Step3Row>(sql).all(queryText, ...params, limit);
}
