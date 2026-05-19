import type { Database } from 'better-sqlite3'
import type {
  RetrievalQuery,
  RetrievedAssertion,
  Assertion,
  RetrievalScorer,
  RetrievalMiddleware,
  GraphQueryAdapter,
  ScoredCandidate,
} from '../domain/types.js'
import type { AssertionRepository } from '../db/repositories/AssertionRepository.js'
import type { EmbeddingRepository } from '../db/repositories/EmbeddingRepository.js'
import { buildCandidateJson } from '../db/candidates.js'
import { applyMiddleware } from './middleware.js'
import { ValidationError } from '../errors/index.js'

interface RetrieveContext {
  assertionRepo: AssertionRepository
  embeddingRepo: EmbeddingRepository
  getEmbeddingTable: (namespace: string) => string
  getPositionRange: (namespace: string) => { min: number; max: number }
  globalScorer: RetrievalScorer
  globalMiddleware: readonly RetrievalMiddleware[]
  graphAdapter: GraphQueryAdapter
}

interface Step1Row {
  id: string
  content: string
  valid_from: number
  confidence: number
  entity_type: string | null
}

interface Step2Row {
  assertion_id: string
  semantic_distance: number
}

interface Step3Row {
  assertion_id: string
  bm25_score: number
}

export function retrieve(
  db: Database,
  ctx: RetrieveContext,
  query: RetrievalQuery,
): RetrievedAssertion[] {
  const callMiddleware = query.middleware ?? []
  const core = (q: RetrievalQuery) => retrieveCore(db, ctx, q)
  return applyMiddleware(ctx.globalMiddleware, callMiddleware, query, core)
}

function retrieveCore(
  db: Database,
  ctx: RetrieveContext,
  query: RetrievalQuery,
): RetrievedAssertion[] {
  const limit = query.limit ?? 10
  const oversample = limit * 3
  const mode = query.mode ?? 'snapshot'

  // Step 1: Temporal filter
  const step1 = runStep1(db, query)
  if (step1.length === 0) return []

  const candidateJson = buildCandidateJson(step1.map((r) => r.id))

  // Step 2: Semantic scoring
  if (!query.queryEmbedding) return []
  const embeddingTable = ctx.getEmbeddingTable(query.namespace)
  const step2 = runStep2(db, embeddingTable, candidateJson, query.queryEmbedding, oversample)
  if (step2.length === 0) return []

  // Step 3: BM25 scoring (optional). v0.2: raw FTS5 values pass through unmodified.
  const bm25Map = new Map<string, number>()
  if (query.queryText) {
    const step3 = runStep3(db, candidateJson, query.queryText)
    for (const row of step3) {
      bm25Map.set(row.assertion_id, row.bm25_score)
    }
  }

  // Step 4: Score. Hydrate ScoredCandidate.assertion (decision §8).
  const step1Map = new Map(step1.map((r) => [r.id, r]))
  const oversampledIds = step2.map((r) => r.assertion_id).filter((id) => step1Map.has(id))
  const hydrated = ctx.assertionRepo.getByIds(oversampledIds)
  const hydratedById = new Map(hydrated.map((a) => [a.id, a]))

  const candidates: Array<{ id: string; candidate: ScoredCandidate }> = []
  for (const s2row of step2) {
    const s1row = step1Map.get(s2row.assertion_id)
    const assertion = hydratedById.get(s2row.assertion_id)
    if (!s1row || !assertion) continue
    candidates.push({
      id: s2row.assertion_id,
      candidate: {
        assertion,
        semanticDistance: s2row.semantic_distance,
        bm25Score: bm25Map.get(s2row.assertion_id) ?? null,
        position: s1row.valid_from,
      },
    })
  }

  const scorer = query.scorer ?? ctx.globalScorer
  const positionRange = ctx.getPositionRange(query.namespace)
  const scoringContext = { temporalAnchor: query.temporalAnchor, namespacePositionRange: positionRange, query }

  let scores: number[]
  if (scorer.scoreBatch) {
    scores = scorer.scoreBatch(candidates.map((c) => c.candidate), scoringContext)
    if (scores.length !== candidates.length) {
      throw new ValidationError([
        `RetrievalScorer.scoreBatch returned ${String(scores.length)} scores for ${String(candidates.length)} candidates`,
      ])
    }
  } else {
    scores = candidates.map((c) => scorer.score(c.candidate, scoringContext))
  }

  const ranked = candidates.map((c, i) => ({ ...c, score: scores[i] ?? 0 }))

  // Step 5: Rank and truncate
  ranked.sort((a, b) => b.score - a.score)
  const topCandidates = ranked.slice(0, limit)

  const results: RetrievedAssertion[] = topCandidates.map((c) => ({
    ...c.candidate.assertion,
    score: c.score,
    scoreComponents: {
      semanticDistance: c.candidate.semanticDistance,
      bm25Score: c.candidate.bm25Score,
      position: c.candidate.assertion.validFrom,
    },
  }))

  // Step 6: Graph expansion (optional)
  if (query.expandLinks && results.length > 0) {
    const fromIds = results.map((r) => r.id)
    const links = ctx.graphAdapter.findConnected(db, query.namespace, fromIds, {
      temporalAnchor: query.temporalAnchor,
      maxDepth: query.maxDepth ?? 1,
    })

    const linkedById = new Map<string, Assertion[]>()
    for (const link of links) {
      const target = ctx.assertionRepo.getById(link.toId)
      if (!target) continue
      const existing = linkedById.get(link.fromId) ?? []
      if (!existing.some((a) => a.id === target.id)) {
        existing.push(target)
        linkedById.set(link.fromId, existing)
      }
    }

    for (const result of results) {
      const linked = linkedById.get(result.id)
      if (linked && linked.length > 0) {
        result.linkedAssertions = linked
      }
    }
  }

  // Step 7: Trajectory expansion (v0.2). Always populate supersessionChain
  // when mode === 'trajectory' (using [] when there are no predecessors);
  // omit it entirely otherwise.
  if (mode === 'trajectory') {
    for (const result of results) {
      const chain = ctx.assertionRepo.getSupersessionChain(result.id)
      // Helper returns oldest-first INCLUDING the result itself; slice off the last entry.
      result.supersessionChain = chain.length > 0 ? chain.slice(0, -1) : []
    }
  }

  return results
}

function runStep1(db: Database, query: RetrievalQuery): Step1Row[] {
  const conditions: string[] = [
    'a.namespace = ?',
    'a.valid_from <= ?',
    '(a.valid_until IS NULL OR a.valid_until > ?)',
  ]
  const params: unknown[] = [query.namespace, query.temporalAnchor, query.temporalAnchor]

  // v0.2: spec wording for includeSuperseded (decision §12).
  // includeSuperseded:false includes current replacements (supersedes_id IS NOT NULL,
  // valid_until IS NULL) and excludes closed rows (valid_until IS NOT NULL).
  if (!query.includeSuperseded) {
    conditions.push('(a.supersedes_id IS NULL OR a.valid_until IS NULL)')
  }
  if (query.minConfidence !== undefined) {
    conditions.push('a.confidence >= ?')
    params.push(query.minConfidence)
  }
  if (query.temporalWindow?.from !== undefined) {
    conditions.push('a.valid_from >= ?')
    params.push(query.temporalWindow.from)
  }
  if (query.temporalWindow?.to !== undefined) {
    conditions.push('a.valid_from <= ?')
    params.push(query.temporalWindow.to)
  }
  if (query.entityTypes && query.entityTypes.length > 0) {
    conditions.push(`a.entity_type IN (${query.entityTypes.map(() => '?').join(',')})`)
    params.push(...query.entityTypes)
  }
  if (query.assertionTypes && query.assertionTypes.length > 0) {
    conditions.push(`a.type IN (${query.assertionTypes.map(() => '?').join(',')})`)
    params.push(...query.assertionTypes)
  }

  const sql = `SELECT a.id, a.content, a.valid_from, a.confidence, a.entity_type
               FROM trl_assertions a
               WHERE ${conditions.join(' AND ')}`

  return db.prepare<unknown[], Step1Row>(sql).all(...params)
}

function runStep2(
  db: Database,
  embeddingTable: string,
  candidateJson: string,
  queryEmbedding: Float32Array | number[],
  limit: number,
): Step2Row[] {
  const vec = queryEmbedding instanceof Float32Array ? queryEmbedding : new Float32Array(queryEmbedding)
  const sql = `
    SELECT ae.assertion_id,
           vec_distance_cosine(ae.embedding, ?) AS semantic_distance
    FROM ${embeddingTable} ae
    WHERE ae.assertion_id IN (SELECT value FROM json_each(?))
    ORDER BY semantic_distance ASC
    LIMIT ?
  `
  return db.prepare<unknown[], Step2Row>(sql).all(vec, candidateJson, limit)
}

function runStep3(db: Database, candidateJson: string, queryText: string): Step3Row[] {
  // Join to trl_assertions via rowid — FTS5 external-content tables cannot read UNINDEXED
  // columns back directly; the backing table is the authoritative source.
  const sql = `
    SELECT a.id AS assertion_id, bm25(trl_fts) AS bm25_score
    FROM trl_fts
    JOIN trl_assertions a ON a.rowid = trl_fts.rowid
    WHERE trl_fts MATCH ?
      AND a.id IN (SELECT value FROM json_each(?))
  `
  return db.prepare<unknown[], Step3Row>(sql).all(queryText, candidateJson)
}
