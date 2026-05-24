import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import type { Assertion, Episode, TemporalStore } from 'trageti'
import { ingest, type ExtractionResult } from './ingest.js'
import { parseExtraction } from './parse.js'
import type { ResolvedDemoProviders } from './providers.js'

export function runtimeDbPath(demoName: string): string {
  const path = join('demos', '.local', `${demoName}.db`)
  mkdirSync(dirname(path), { recursive: true })
  return path
}

export function demoDataVersion(
  demoName: string,
  episodes: readonly Omit<Episode, 'createdAt'>[],
  fixtures?: Record<string, string>,
): string {
  const payload = {
    demoName,
    episodes: episodes.map((e) => ({ id: e.id, namespace: e.namespace, position: e.position, type: e.type })),
    fixtureKeys: fixtures ? Object.keys(fixtures).sort() : [],
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

export function ensureDemoMetadata(options: {
  database: string
  demoName: string
  dataVersion: string
  providers: ResolvedDemoProviders
}): void {
  const db = new Database(options.database)
  try {
    db.prepare(
      `CREATE TABLE IF NOT EXISTS demo_run_metadata (
        demo_name TEXT PRIMARY KEY,
        data_version TEXT NOT NULL,
        extraction_hash TEXT NOT NULL,
        embedding_hash TEXT NOT NULL,
        embedding_dimension INTEGER NOT NULL,
        mode TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    ).run()
    const expected = {
      demo_name: options.demoName,
      data_version: options.dataVersion,
      extraction_hash: options.providers.provenance.extraction.configHash,
      embedding_hash: options.providers.provenance.embedding.configHash,
      embedding_dimension: options.providers.provenance.embedding.dimension ?? 0,
      mode: options.providers.isLive ? 'live' : 'fixture',
    }
    const existing = db
      .prepare<
        [string],
        typeof expected
      >('SELECT demo_name, data_version, extraction_hash, embedding_hash, embedding_dimension, mode FROM demo_run_metadata WHERE demo_name = ?')
      .get(options.demoName)
    if (existing) {
      const mismatches = Object.entries(expected).filter(([key, value]) => existing[key as keyof typeof expected] !== value)
      if (mismatches.length > 0) {
        throw new Error(
          `Demo database "${options.database}" was built with different provider/data provenance.\n` +
            'Delete the demo DB or choose a different DB path before re-running.',
        )
      }
      return
    }
    db.prepare(
      `INSERT INTO demo_run_metadata
        (demo_name, data_version, extraction_hash, embedding_hash, embedding_dimension, mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      expected.demo_name,
      expected.data_version,
      expected.extraction_hash,
      expected.embedding_hash,
      expected.embedding_dimension,
      expected.mode,
      new Date().toISOString(),
    )
  } finally {
    db.close()
  }
}

export async function ingestEpisodes(options: {
  store: TemporalStore
  namespace: string
  episodes: readonly Omit<Episode, 'createdAt'>[]
  providers: ResolvedDemoProviders
  expectedFixtureAssertionIds?: readonly string[]
}): Promise<void> {
  const accumulated: Assertion[] = []
  for (const episode of options.episodes) {
    const existing = await options.store.getEpisode(episode.id)
    if (existing !== null) {
      validateExistingEpisode(existing, episode)
      await reloadAccumulated(options.store, options.namespace, accumulated)
      continue
    }
    const result = await ingest({
      store: options.store,
      namespace: options.namespace,
      episode,
      document: episode.content,
      existingAssertions: accumulated,
      extractor: options.providers.extractor,
    })
    await indexResult(options.store, result)
    await reloadAccumulated(options.store, options.namespace, accumulated)
  }
  await verifyComplete(options)
}

export function expectedFixtureAssertionIds(fixtures: Record<string, string>): string[] {
  return Object.keys(fixtures)
    .flatMap((key) => parseExtraction(fixtures[key] ?? '{"assertions":[],"links":[]}').assertions.map((a) => a.id))
    .sort()
}

async function indexResult(store: TemporalStore, result: ExtractionResult): Promise<void> {
  const ib = await store.indexBatch(
    result.assertions.map((a) => ({ assertionId: a.id })),
    { onProviderError: 'skip' },
  )
  if (ib.skipped.length > 0) {
    const reason = ib.skipped[0]?.reason ?? 'UNKNOWN'
    throw new Error(`indexBatch skipped ${String(ib.skipped.length)} assertion(s): ${reason}`)
  }
}

function validateExistingEpisode(existing: Episode, expected: Omit<Episode, 'createdAt'>): void {
  if (
    existing.namespace !== expected.namespace ||
    existing.position !== expected.position ||
    existing.type !== expected.type
  ) {
    throw new Error(
      `Existing episode "${expected.id}" does not match committed demo data. ` +
        'Delete the demo DB or use a different DB path.',
    )
  }
}

async function reloadAccumulated(
  store: TemporalStore,
  namespace: string,
  target: Assertion[],
): Promise<void> {
  target.length = 0
  target.push(...(await store.getAssertions(namespace, { includeSuperseded: true })))
}

async function verifyComplete(options: {
  store: TemporalStore
  namespace: string
  episodes: readonly Omit<Episode, 'createdAt'>[]
  expectedFixtureAssertionIds?: readonly string[]
}): Promise<void> {
  const assertions = await options.store.getAssertions(options.namespace, { includeSuperseded: true })
  const byEpisode = new Map<string, number>()
  for (const a of assertions) byEpisode.set(a.sourceEpisodeId, (byEpisode.get(a.sourceEpisodeId) ?? 0) + 1)
  const missingEpisodes = options.episodes.filter((e) => (byEpisode.get(e.id) ?? 0) === 0)
  if (missingEpisodes.length > 0) {
    throw new Error(
      `Demo database is partial: missing assertions for ${missingEpisodes.map((e) => e.id).join(', ')}.\n` +
        'Delete the demo DB and re-run.',
    )
  }

  const pending = await options.store.getPendingIndexing(options.namespace)
  if (pending.length > 0) {
    throw new Error(
      `Demo database is partial: ${String(pending.length)} assertion(s) are missing embeddings.\n` +
        'Delete the demo DB and re-run.',
    )
  }

  if (options.expectedFixtureAssertionIds) {
    const actual = assertions.map((a) => a.id).sort()
    const expected = [...options.expectedFixtureAssertionIds].sort()
    if (actual.join('\n') !== expected.join('\n')) {
      throw new Error(
        'Fixture demo database assertion IDs do not match committed fixture data.\n' +
          'Delete the demo DB and re-run.',
      )
    }
  }
}
