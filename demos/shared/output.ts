// Terminal output for the demo runners. Keep flow logging and query rendering
// here so both demos explain trageti behavior consistently.

import type {
  Assertion,
  AssertionLink,
  RetrievalMeta,
  RetrievalQuery,
  RetrievalResult,
  RetrievedAssertion,
} from 'trageti'
import type { DemoRunLogger } from './runtime.js'

const RULE = '-'.repeat(72)

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
      console.log(`    - ${message}`)
    },
    success(message) {
      console.log(`    OK ${message}`)
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
}

export function printRetrievalResult(
  annotation: string,
  query: RetrievalQuery,
  result: RetrievalResult,
): void {
  printQueryHeader(annotation, query, result.meta)
  if (result.results.length === 0) {
    console.log('  No matching assertions returned.')
    return
  }
  for (const [i, r] of result.results.entries()) {
    printAssertion(r, i)
  }
}

export function printQueryHeader(
  annotation: string,
  query: RetrievalQuery,
  meta: RetrievalMeta,
): void {
  console.log('')
  console.log(RULE)
  console.log(`Query ${annotation}`)
  console.log(RULE)
  console.log(`  Text: ${query.queryText ?? '(query embedding only)'}`)
  console.log(`  Namespace: ${meta.namespace}`)
  console.log(
    `  Temporal scope: ${describeTemporalScope(query, meta)}; mode=${query.mode ?? 'snapshot'}`,
  )
  console.log(
    `  Retrieval: strategy=${meta.retrievalStrategy}; vector=${applied(meta.vectorApplied)}; ` +
      `BM25=${applied(meta.bm25Applied)}; candidates=${String(meta.candidateCount)}; limit=${String(meta.limit)}`,
  )
  if (meta.queryTextMode) console.log(`  Text search mode: ${meta.queryTextMode}`)
  if (meta.tookMs !== undefined) console.log(`  Runtime: ${meta.tookMs.toFixed(1)} ms`)
  if (meta.warnings.length > 0) {
    for (const warning of meta.warnings) {
      console.log(`  Warning: ${warning.code} - ${warning.message}`)
    }
  }
}

export function printAssertion(a: RetrievedAssertion, index: number): void {
  console.log('')
  console.log(`  Result ${String(index + 1)}: ${a.content}`)
  console.log(`    Assertion: ${a.id} (${a.type})`)
  console.log(
    `    Temporal: valid from position ${String(a.validFrom)}${a.validUntil === null ? '; currently active' : ` until position ${String(a.validUntil)}`}`,
  )
  console.log(
    `    Confidence: ${a.confidence.toFixed(2)}; final rank score: ${a.score.toFixed(3)}`,
  )
  console.log(
    `    Ranking signals: semantic distance=${formatDistance(a.scoreComponents.semanticDistance)}; ` +
      `BM25=${formatBm25(a.scoreComponents.bm25Score)}; position=${String(a.scoreComponents.position)}`,
  )
  console.log(`    Source episode: ${a.sourceEpisodeId}`)
  for (const citation of a.citations.slice(0, 2)) {
    if (citation.excerpt) {
      console.log(`    Citation (${citation.sourceRef}): "${truncate(citation.excerpt, 120)}"`)
    } else {
      console.log(`    Citation (${citation.sourceRef}): no excerpt recorded`)
    }
  }
  if (a.supersedesId) console.log(`    Supersedes: ${a.supersedesId}`)
  if (a.entityId) {
    console.log(
      `    Entity: ${a.entityId}${a.entityType ? ` (${a.entityType})` : ''}`,
    )
  }
  if (a.linkedAssertions && a.linkedAssertions.length > 0) {
    console.log('    Linked assertions:')
    for (const linked of a.linkedAssertions) {
      console.log(`      - ${linked.id}: ${truncate(linked.content, 100)}`)
    }
  }
  if (a.supersessionChain && a.supersessionChain.length > 0) {
    console.log('    Prior versions in supersession chain:')
    for (const prior of a.supersessionChain) {
      console.log(
        `      - position ${String(prior.validFrom)} (${prior.id}): ${truncate(prior.content, 100)}`,
      )
    }
  }
}

export function printSnapshot(title: string, assertions: readonly Assertion[]): void {
  console.log('')
  console.log(RULE)
  console.log(title)
  console.log(RULE)
  if (assertions.length === 0) {
    console.log('  No assertions returned.')
    return
  }
  for (const [i, a] of assertions.entries()) {
    console.log('')
    console.log(`  Snapshot item ${String(i + 1)}: ${truncate(a.content, 120)}`)
    console.log(
      `    ${a.id}; type=${a.type}; valid from position ${String(a.validFrom)}${a.validUntil === null ? '; active' : ` until position ${String(a.validUntil)}`}`,
    )
    console.log(`    Source episode: ${a.sourceEpisodeId}; confidence=${a.confidence.toFixed(2)}`)
  }
}

export function printPathHops(title: string, links: readonly AssertionLink[]): void {
  console.log('')
  console.log(RULE)
  console.log(title)
  console.log(RULE)
  if (links.length === 0) {
    console.log('  No path found.')
    return
  }
  console.log('  Typed assertion-link path:')
  for (const [i, l] of links.entries()) {
    console.log('')
    console.log(`  Hop ${String(i + 1)}: ${l.fromId} --[${l.linkType}]--> ${l.toId}`)
    console.log(
      `    Namespace: ${l.namespace}; valid from position ${String(l.validFrom)}${l.validUntil === null ? '; active' : ` until position ${String(l.validUntil)}`}`,
    )
    console.log(`    Source episode: ${l.sourceEpisodeId}`)
  }
}

export function printNarrative(text: string): void {
  console.log('')
  console.log(RULE)
  console.log('Assembled-context narrative synthesis')
  console.log(RULE)
  console.log('  ' + text.split('\n').join('\n  '))
}

function describeTemporalScope(query: RetrievalQuery, meta: RetrievalMeta): string {
  const window = query.temporalWindow
  if (window) {
    const from = window.from === undefined ? '-infinity' : String(window.from)
    const to = window.to === undefined ? '+infinity' : String(window.to)
    return `anchor position ${String(meta.temporalAnchor)}, window ${from}..${to}`
  }
  return `anchor position ${String(meta.temporalAnchor)}`
}

function applied(value: boolean): string {
  return value ? 'applied' : 'not applied'
}

function formatDistance(n: number | null): string {
  return n === null ? 'not used' : `${n.toFixed(3)} (lower is closer)`
}

function formatBm25(n: number | null): string {
  return n === null ? 'not used' : `${n.toFixed(3)} (raw FTS5 score)`
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '...'
}
