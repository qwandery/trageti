// Terminal output for the example query runners. Prints raw scoreComponents
// and applied-signal flags from RetrievalMeta so the hybrid retrieval demo is
// observable, plus typed AssertionLink hops for the multi-hop demo.

import type { Assertion, AssertionLink, RetrievalMeta, RetrievedAssertion } from 'trageti'

const RULE = '─'.repeat(60)

export function printBanner(title: string): void {
  console.log(RULE)
  console.log(title)
  console.log(RULE)
}

export function printQueryHeader(annotation: string, meta: RetrievalMeta): void {
  console.log('')
  console.log(`Query: ${annotation}`)
  console.log(
    `  strategy=${meta.retrievalStrategy} vectorApplied=${String(meta.vectorApplied)} ` +
      `bm25Applied=${String(meta.bm25Applied)} candidates=${String(meta.candidateCount)}`,
  )
}

export function printAssertion(a: RetrievedAssertion, index: number): void {
  console.log(`  [${String(index + 1)}] ${a.content}`)
  console.log(
    `      position=${String(a.validFrom)} confidence=${a.confidence.toFixed(2)} ` +
      `score=${a.score.toFixed(3)} (sem=${formatScore(a.scoreComponents.semanticDistance)} ` +
      `bm25=${formatScore(a.scoreComponents.bm25Score)})`,
  )
  const firstCitation = a.citations[0]
  if (firstCitation?.excerpt) {
    console.log(`      cite: "${truncate(firstCitation.excerpt, 80)}"`)
  }
  if (a.linkedAssertions && a.linkedAssertions.length > 0) {
    for (const linked of a.linkedAssertions) {
      console.log(`      linked: ${truncate(linked.content, 80)}`)
    }
  }
  if (a.supersessionChain && a.supersessionChain.length > 0) {
    for (const prior of a.supersessionChain) {
      console.log(`      chain: (pos ${String(prior.validFrom)}) ${truncate(prior.content, 80)}`)
    }
  }
}

export function printSnapshot(assertions: readonly Assertion[]): void {
  for (const [i, a] of assertions.entries()) {
    console.log(
      `  [${String(i + 1)}] (pos ${String(a.validFrom)}) ${truncate(a.content, 100)}`,
    )
  }
}

export function printPathHops(links: readonly AssertionLink[]): void {
  if (links.length === 0) {
    console.log('  (no path)')
    return
  }
  for (const [i, l] of links.entries()) {
    console.log(`  hop ${String(i + 1)}: ${l.fromId} --[${l.linkType}]--> ${l.toId}`)
  }
}

export function printNarrative(text: string): void {
  console.log('')
  console.log('Narrative:')
  console.log('  ' + text.split('\n').join('\n  '))
}

function formatScore(n: number | null): string {
  return n === null ? '—' : n.toFixed(3)
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
