// Functional reference: build data/episodes.ts + data/aggregations.ts from the
// keyframe manifest by running git operations and a live LLM aggregation call.
//
// Usage: npx tsx demos/know-thyself/generate-episodes.ts [--context-length N]
// PowerShell: .\node_modules\.bin\tsx.cmd demos\know-thyself\generate-episodes.ts

import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ExtractionProvider } from '../shared/providers.js'
import { resolveLiveExtractionProvider } from '../shared/providers.js'
import { keyframes, type Keyframe } from './data/keyframes.js'

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function truncateToTokenBudget(text: string, tokenBudget: number): string {
  const charBudget = Math.floor(tokenBudget / 0.25)
  return text.length <= charBudget ? text : text.slice(0, charBudget) + '\n... [truncated]'
}

async function summarizePair(
  extractor: ExtractionProvider,
  prev: Keyframe,
  curr: Keyframe,
  tokenBudget: number,
): Promise<string> {
  const message = git(['log', curr.hash, '-1', '--format=%B'])
  const stat = git(['diff', '--stat', prev.hash, curr.hash])
  const diff = truncateToTokenBudget(git(['diff', prev.hash, curr.hash]), tokenBudget)
  const prompt = `Summarize what materially changed between commit ${prev.hash} (${prev.label}) and commit ${curr.hash} (${curr.label}). Focus on architectural and design-level changes, not line-by-line code changes.\n\nCommit message:\n${message}\n\nDiff stat:\n${stat}\n\nFull diff:\n${diff}\n\nOutput 2-3 sentences of plain prose.`
  return extractor.extract(prompt)
}

async function summarizeFirst(
  extractor: ExtractionProvider,
  first: Keyframe,
  tokenBudget: number,
): Promise<string> {
  const message = git(['log', first.hash, '-1', '--format=%B'])
  const keyFiles = ['_docs/specs/trageti-spec-v0.1.md', 'src/index.ts', 'README.md']
  const contents: string[] = []
  for (const f of keyFiles) {
    try {
      contents.push(`--- ${f} ---\n${git(['show', `${first.hash}:${f}`])}`)
    } catch {
      // file may not exist at this hash
    }
  }
  const body = truncateToTokenBudget(contents.join('\n\n'), tokenBudget)
  const prompt = `Summarize the initial state of the project at commit ${first.hash} (${first.label}). Focus on architectural and design-level facts.\n\nCommit message:\n${message}\n\nKey files:\n${body}\n\nOutput 2-3 sentences of plain prose.`
  return extractor.extract(prompt)
}

async function main(): Promise<void> {
  const tokenBudget = Number(process.argv[process.argv.indexOf('--context-length') + 1]) || 8192
  const extractor = resolveLiveExtractionProvider()

  const aggregations: Record<string, string> = {}
  const episodes: Array<{ id: string; position: number; content: string }> = []

  for (let i = 0; i < keyframes.length; i++) {
    const kf = keyframes[i]
    if (!kf) continue
    const id = `kf-${String(kf.position)}`
    let summary: string
    if (i === 0) {
      summary = await summarizeFirst(extractor, kf, tokenBudget)
    } else {
      const prev = keyframes[i - 1]
      if (!prev) throw new Error(`unreachable: previous keyframe missing at ${String(i)}`)
      summary = await summarizePair(extractor, prev, kf, tokenBudget)
      aggregations[`kf-${String(prev.position)}..${id}`] = summary
    }
    episodes.push({ id, position: kf.position, content: summary })
  }

  console.log('episodes:', JSON.stringify(episodes, null, 2))
  console.log('aggregations:', JSON.stringify(aggregations, null, 2))
  console.log('')
  console.log('(commit the above into data/episodes.ts and data/aggregations.ts manually)')

  void writeFileSync
  void resolve
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
