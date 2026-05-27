// Terminal output for the demo runners. Keep flow logging and query rendering
// here so both demos explain trageti behavior consistently.

import type {
  Assertion,
  AssertionLink,
  RetrievalMeta,
  RetrievalQuery,
  RetrievalResult,
  RetrievedAssertion,
  Episode,
} from 'trageti'
import type { DemoRunLogger } from './runtime.js'
import type { LlmTraceOptions } from './providers.js'

const RULE = '-'.repeat(72)

export interface DemoTimeline {
  byPosition: ReadonlyMap<number, Omit<Episode, 'createdAt'>>
  byEpisodeId: ReadonlyMap<string, Omit<Episode, 'createdAt'>>
}

export function createDemoTimeline(episodes: readonly Omit<Episode, 'createdAt'>[]): DemoTimeline {
  return {
    byPosition: new Map(episodes.map((episode) => [episode.position, episode])),
    byEpisodeId: new Map(episodes.map((episode) => [episode.id, episode])),
  }
}

export function printBanner(title: string): void {
  console.log(RULE)
  console.log(title)
  console.log(RULE)
}

export function createDemoLogger(): DemoRunLogger {
  let stepNumber = 0
  return {
    step(message) {
      stepNumber += 1
      console.log('')
      console.log(`[${String(stepNumber)}] ${message}`)
    },
    detail(message) {
      console.log(`    ${message}`)
    },
    success(message) {
      console.log(`    OK ${message}`)
    },
  }
}

export function createLlmTraceOptions(argv = process.argv, env: NodeJS.ProcessEnv = process.env): LlmTraceOptions {
  const arg = argv.find((value) => value === '--llm-trace' || value.startsWith('--llm-trace='))
  const raw = arg?.includes('=') ? arg.split('=')[1] : arg ? 'full' : env['DEMO_LLM_TRACE']
  const normalized = raw?.toLowerCase()
  return {
    enabled: normalized === '1' || normalized === 'true' || normalized === 'summary' || normalized === 'full',
    includePayloads: normalized === '1' || normalized === 'true' || normalized === 'full',
    log(message) {
      console.log('')
      console.log('[LLM]')
      console.log(
        message
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n'),
      )
    },
  }
}

export function printProviderSummary(options: {
  modeLabel: string
  namespace: string
  database: string
  extractionLabel: string
  embeddingLabel: string
  embeddingDimension: number
}): void {
  console.log('')
  console.log('Run configuration')
  console.log(`  Mode: ${options.modeLabel}`)
  console.log(`  Namespace: ${options.namespace}`)
  console.log(`  SQLite DB: ${options.database}`)
  console.log(`  Extraction provider: ${options.extractionLabel}`)
  console.log(`  Embedding provider: ${options.embeddingLabel}`)
  console.log(`  Embedding dimension: ${String(options.embeddingDimension)}`)
  console.log('  LLM trace: set DEMO_LLM_TRACE=summary or run with --llm-trace to print model calls')
}

export function printRetrievalResult(
  annotation: string,
  query: RetrievalQuery,
  result: RetrievalResult,
  timeline?: DemoTimeline,
): void {
  printQueryHeader(annotation, query, result.meta, timeline)
  if (result.results.length === 0) {
    console.log('  No matching assertions returned.')
    return
  }
  for (const [i, r] of result.results.entries()) {
    printAssertion(r, i, timeline)
  }
}

export function printQueryHeader(
  annotation: string,
  query: RetrievalQuery,
  meta: RetrievalMeta,
  timeline?: DemoTimeline,
): void {
  console.log('')
  console.log(RULE)
  console.log(`Query ${annotation}`)
  console.log(RULE)
  console.log(`  Text: ${query.queryText ?? '(query embedding only)'}`)
  console.log(`  Namespace: ${meta.namespace}`)
  console.log(
    `  Time view: ${describeTemporalScope(query, meta, timeline)}; mode=${query.mode ?? 'snapshot'}`,
  )
  console.log(
    `  Retrieval: ${meta.retrievalStrategy}; vector ${applied(meta.vectorApplied)}, ` +
      `BM25 ${applied(meta.bm25Applied)}; ${String(meta.candidateCount)} candidates, ` +
      `top ${String(meta.limit)}`,
  )
  if (meta.queryTextMode) console.log(`  Text search mode: ${meta.queryTextMode}`)
  if (meta.tookMs !== undefined) console.log(`  Runtime: ${meta.tookMs.toFixed(1)} ms`)
  if (meta.warnings.length > 0) {
    for (const warning of meta.warnings) {
      console.log(`  Warning: ${warning.code} - ${warning.message}`)
    }
  }
}

export function printAssertion(a: RetrievedAssertion, index: number, timeline?: DemoTimeline): void {
  console.log('')
  console.log(`  Result ${String(index + 1)}: ${a.content}`)
  console.log(`    Time: ${describeAssertionValidity(a, timeline)}`)
  console.log(
    `    Source: ${describeEpisode(a.sourceEpisodeId, timeline)}; ` +
      `${a.type}, confidence ${a.confidence.toFixed(2)}`,
  )
  console.log(`    Rank: ${a.score.toFixed(3)} (${describeRankingSignals(a)})`)
  for (const citation of a.citations.slice(0, 2)) {
    if (citation.excerpt) {
      console.log(`    Citation (${citation.sourceRef}): "${truncate(citation.excerpt, 120)}"`)
    } else {
      console.log(`    Citation (${citation.sourceRef}): no excerpt recorded`)
    }
  }
  if (a.supersedesId) console.log('    Supersedes an earlier stored claim.')
  if (a.entityId) {
    console.log(
      `    Entity: ${a.entityId}${a.entityType ? ` (${a.entityType})` : ''}`,
    )
  }
  if (a.linkedAssertions && a.linkedAssertions.length > 0) {
    console.log('    Linked assertions:')
    for (const linked of a.linkedAssertions) {
      console.log(`      - ${truncate(linked.content, 100)}`)
    }
  }
  if (a.supersessionChain && a.supersessionChain.length > 0) {
    console.log('    Earlier versions:')
    for (const prior of a.supersessionChain) {
      console.log(
        `      - ${formatPosition(prior.validFrom, timeline)}: ${truncate(prior.content, 100)}`,
      )
    }
  }
}

export function printSnapshot(
  title: string,
  assertions: readonly Assertion[],
  options?: { emptyMessage?: string; timeline?: DemoTimeline },
): void {
  console.log('')
  console.log(RULE)
  console.log(title)
  console.log(RULE)
  if (assertions.length === 0) {
    console.log(`  ${options?.emptyMessage ?? 'No assertions matched this request.'}`)
    return
  }
  for (const [i, a] of assertions.entries()) {
    console.log('')
    console.log(`  Snapshot item ${String(i + 1)}: ${truncate(a.content, 120)}`)
    console.log(`    Time: ${describeAssertionValidity(a, options?.timeline)}`)
    console.log(
      `    Source: ${describeEpisode(a.sourceEpisodeId, options?.timeline)}; ` +
        `${a.type}, confidence ${a.confidence.toFixed(2)}`,
    )
  }
}

export function printPathHops(
  title: string,
  links: readonly AssertionLink[],
  options?: {
    fromAssertionId?: string
    toAssertionId?: string
    temporalAnchor?: number
    maxDepth?: number
    liveMode?: boolean
    timeline?: DemoTimeline
  },
): void {
  console.log('')
  console.log(RULE)
  console.log(title)
  console.log(RULE)
  if (links.length === 0) {
    console.log('  No graph path was returned.')
    console.log(
      '  This query does not run semantic search. It asks SQLite for stored typed links that connect two known assertions.',
    )
    if (options?.fromAssertionId && options.toAssertionId) {
      console.log(
        `  Requested path: ${options.fromAssertionId} -> ${options.toAssertionId}` +
          (options.maxDepth === undefined ? '' : ` within ${String(options.maxDepth)} hop(s)`) +
          `${options.temporalAnchor === undefined ? '' : ` at ${formatPosition(
            options.temporalAnchor,
            options.timeline,
          )}`}.`,
      )
    }
    console.log(
      '  Meaning: the current DB does not contain active stored links connecting those assertion IDs.',
    )
    if (options?.liveMode) {
      console.log(
        '  Live extraction can choose different IDs or omit the expected contextualizes link; ' +
          'fixture mode is deterministic for this graph demo.',
      )
    }
    console.log(
      '  If the DB was created before the latest fixtures, delete demos/.local/alex-place.db and rerun.',
    )
    return
  }
  console.log('  Typed assertion-link path:')
  for (const [i, l] of links.entries()) {
    console.log('')
    console.log(`  Hop ${String(i + 1)}: ${l.linkType}`)
    console.log(
      `    Time: valid from ${formatPosition(l.validFrom, options?.timeline)}` +
        (l.validUntil === null ? '; active' : ` until ${formatPosition(l.validUntil, options?.timeline)}`),
    )
    console.log(`    Source: ${describeEpisode(l.sourceEpisodeId, options?.timeline)}`)
  }
}

export function printNarrative(text: string): void {
  console.log('')
  console.log(RULE)
  console.log('Assembled-context narrative synthesis')
  console.log(RULE)
  console.log('  ' + text.split('\n').join('\n  '))
}

function describeTemporalScope(query: RetrievalQuery, meta: RetrievalMeta, timeline?: DemoTimeline): string {
  const window = query.temporalWindow
  if (window) {
    const from = window.from === undefined ? 'the beginning' : formatPosition(window.from, timeline)
    const to = window.to === undefined ? 'now' : formatPosition(window.to, timeline)
    return `${formatPosition(meta.temporalAnchor, timeline)}, window ${from}..${to}`
  }
  return formatPosition(meta.temporalAnchor, timeline)
}

function describeAssertionValidity(a: Assertion, timeline?: DemoTimeline): string {
  return (
    `valid from ${formatPosition(a.validFrom, timeline)}` +
    (a.validUntil === null ? '; active at the query time' : ` until ${formatPosition(a.validUntil, timeline)}`)
  )
}

function describeEpisode(episodeId: string, timeline?: DemoTimeline): string {
  const episode = timeline?.byEpisodeId.get(episodeId)
  if (!episode) return episodeId
  return `${formatDateTime(episode.occurredAt)} ${episode.type} episode`
}

function formatPosition(position: number, timeline?: DemoTimeline): string {
  const episode = timeline?.byPosition.get(position)
  if (!episode) return `position ${String(position)}`
  return formatDateTime(episode.occurredAt)
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
  }).format(new Date(value))
}

function applied(value: boolean): string {
  return value ? 'on' : 'off'
}

function describeRankingSignals(a: RetrievedAssertion): string {
  const semantic = a.scoreComponents.semanticDistance
  const bm25 = a.scoreComponents.bm25Score
  const parts = [
    semantic === null ? 'semantic unused' : `semantic distance ${semantic.toFixed(3)}`,
    bm25 === null ? 'BM25 unused' : `BM25 ${bm25.toFixed(3)}`,
    `position signal ${String(a.scoreComponents.position)}`,
  ]
  return parts.join('; ')
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '...'
}
