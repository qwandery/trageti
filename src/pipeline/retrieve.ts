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
import { DefaultScorer } from '../defaults/scoring/DefaultScorer.js'

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

  // Step 1: Temporal filter
  const step1 = runStep1(db, query)
  if (step1.length === 0) return []

  const candidateJson = buildCandidateJson(step1.map((r) => r.id))

  // Step 2: Semantic scoring
  const embeddingTable = ctx.getEmbeddingTable(query.namespace)
  const step2 = runStep2(db, embeddingTable, candidateJson, query.queryEmbedding, oversample)
  if (step2.length === 0) return []

  // Step 3: BM25 scoring (optional)
  const bm25Map = new Map<string, number>()
  if (query.queryText) {
    const step3 = runStep3(db, candidateJson, query.queryText)
    // Min-max normalise BM25 scores to [0, 1] over the candidate set
    // FTS5 BM25 is negative; more negative = better match
    const scores = step3.map((r) => r.bm25_score)
    const minScore = Math.min(...scores)
    const maxScore = Math.max(...scores)
    const range = maxScore - minScore
    for (const row of step3) {
      const normalised = range > 0 ? (row.bm25_score - minScore) / range : 1
      // Invert: more negative raw = better = should be higher normalised
      bm25Map.set(row.assertion_id, 1 - normalised)
    }
  }

  // Step 4: Score
  const scorer = query.scorer ?? ctx.globalScorer
  const positionRange = ctx.getPositionRange(query.namespace)

  const step1Map = new Map(step1.map((r) => [r.id, r]))
  const candidates: Array<{ id: string; semanticDistance: number; score: number }> = []

  for (const s2row of step2) {
    const s1row = step1Map.get(s2row.assertion_id)
    if (!s1row) continue

    const candidate: ScoredCandidate = {
      assertion: {} as Assertion, // placeholder — full row fetched after ranking
      semanticDistance: s2row.semantic_distance,
      bm25Score: bm25Map.get(s2row.assertion_id) ?? null,
      position: s1row.valid_from,
    }

    const score = scorer.score(candidate, {
      temporalAnchor: query.temporalAnchor,
      namespacePositionRange: positionRange,
      query,
    })

    candidates.push({ id: s2row.assertion_id, semanticDistance: s2row.semantic_distance, score })
  }

  // Step 5: Rank and truncate
  candidates.sort((a, b) => b.score - a.score)
  const topCandidates = candidates.slice(0, limit)

  // Fetch full assertion rows for top results
  const results: RetrievedAssertion[] = []
  for (const c of topCandidates) {
    const assertion = ctx.assertionRepo.getById(c.id)
    if (!assertion) continue

    const result: RetrievedAssertion = {
      ...assertion,
      score: c.score,
      scoreComponents: {
        semanticDistance: c.semanticDistance,
        bm25Score: bm25Map.get(c.id) ?? null,
        position: assertion.validFrom,
      },
    }
    results.push(result)
  }

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

  return results
}

function runStep1(db: Database, query: RetrievalQuery): Step1Row[] {
  const conditions: string[] = [
    'a.namespace = ?',
    'a.valid_from <= ?',
    '(a.valid_until IS NULL OR a.valid_until > ?)',
  ]
  const params: unknown[] = [query.namespace, query.temporalAnchor, query.temporalAnchor]

  if (!query.includeSuperseded) {
    conditions.push('a.valid_until IS NULL')
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

// Prevent unused import warning
void DefaultScorer
