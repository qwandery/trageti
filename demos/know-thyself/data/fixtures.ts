import { citationSources } from './sources.js'

type CitationFixture = {
  id: string
  episodeId: string
  sourceRef: string
  excerpt: null
  excerptStart: string
  excerptEnd: string
}

type AssertionFixture = {
  id: string
  namespace: string
  type: string
  content: string
  validFrom: number
  confidence: number
  sourceEpisodeId: string
  supersedesId?: string | null
  entityId?: string | null
  entityType?: string | null
  citations: CitationFixture[]
}

type LinkFixture = {
  id: string
  namespace: string
  fromId: string
  toId: string
  linkType: string
  validFrom: number
  validUntil: null
  sourceEpisodeId: string
}

const NAMESPACE = 'trageti-history'

function citation(id: string, episodeId: string, sourceRef: string, quoteText: string): CitationFixture {
  const source = citationSources[sourceRef]
  if (!source) throw new Error(`missing citation source ${sourceRef}`)
  const start = source.indexOf(quoteText)
  if (start < 0) throw new Error(`quote not found in ${sourceRef}: ${quoteText}`)
  return {
    id,
    episodeId,
    sourceRef,
    excerpt: null,
    excerptStart: String(start),
    excerptEnd: String(start + quoteText.length),
  }
}

function assertion(input: Omit<AssertionFixture, 'namespace' | 'validFrom' | 'sourceEpisodeId'> & {
  episodeId: string
  position: number
}): AssertionFixture {
  const { episodeId, position, ...rest } = input
  return {
    ...rest,
    namespace: NAMESPACE,
    validFrom: position,
    sourceEpisodeId: episodeId,
    supersedesId: rest.supersedesId ?? null,
    entityId: rest.entityId ?? null,
    entityType: rest.entityType ?? null,
  }
}

function link(input: Omit<LinkFixture, 'namespace' | 'validUntil'>): LinkFixture {
  return { ...input, namespace: NAMESPACE, validUntil: null }
}

const byEpisode: Record<string, { assertions: AssertionFixture[]; links: LinkFixture[] }> = {
  'kf-1': {
    assertions: [
      assertion({
        id: 'a-kf-1-scoring',
        episodeId: 'kf-1',
        position: 1,
        type: 'fact',
        content: 'v0.1 retrieval used a weighted hybrid score combining semantic similarity, BM25 text search, and recency.',
        confidence: 0.94,
        entityId: 'retrieval-scoring',
        citations: [citation('c-a-kf-1-scoring', 'kf-1', 'sources/kf-1.md', 'Retrieval combines vector distance, BM25 text search, and recency into a weighted hybrid score.')],
      }),
      assertion({
        id: 'a-kf-1-temporal',
        episodeId: 'kf-1',
        position: 1,
        type: 'fact',
        content: 'v0.1 used Episode.sequenceNumber as the caller-supplied temporal ordering field.',
        confidence: 0.9,
        entityId: 'temporal-model',
        citations: [citation('c-a-kf-1-temporal', 'kf-1', 'sources/kf-1.md', 'The v0.1 temporal model uses Episode.sequenceNumber as the caller-supplied ordering field for snapshot and retrieval behavior.')],
      }),
      assertion({
        id: 'a-kf-1-citations',
        episodeId: 'kf-1',
        position: 1,
        type: 'absence',
        content: 'v0.1 did not require assertions to carry citations.',
        confidence: 0.86,
        entityId: 'citation-model',
        citations: [citation('c-a-kf-1-citations', 'kf-1', 'sources/kf-1.md', 'Citations are not yet a structural requirement in v0.1; assertions can be written without citation rows.')],
      }),
    ],
    links: [],
  },
  'kf-2': {
    assertions: [
      assertion({
        id: 'a-kf-2-citations',
        episodeId: 'kf-2',
        position: 2,
        type: 'update',
        content: 'v0.2 adds citations as first-class assertion provenance.',
        confidence: 0.95,
        supersedesId: 'a-kf-1-citations',
        entityId: 'citation-model',
        citations: [citation('c-a-kf-2-citations', 'kf-2', 'sources/kf-1..kf-2.md', 'v0.2 adds citations as first-class assertion provenance and introduces trajectory retrieval over supersession chains.')],
      }),
      assertion({
        id: 'a-kf-2-trajectory',
        episodeId: 'kf-2',
        position: 2,
        type: 'fact',
        content: 'v0.2 introduces trajectory retrieval so callers can reconstruct supersession chains.',
        confidence: 0.94,
        entityId: 'trajectory-retrieval',
        citations: [citation('c-a-kf-2-trajectory', 'kf-2', 'sources/kf-1..kf-2.md', 'Trajectory retrieval reconstructs supersession chains so callers can ask how an assertion evolved instead of only asking what is current.')],
      }),
      assertion({
        id: 'a-kf-2-temporal',
        episodeId: 'kf-2',
        position: 2,
        type: 'update',
        content: 'v0.2 renames the temporal ordering field from sequenceNumber to position.',
        confidence: 0.9,
        supersedesId: 'a-kf-1-temporal',
        entityId: 'temporal-model',
        citations: [citation('c-a-kf-2-temporal', 'kf-2', 'sources/kf-1..kf-2.md', 'The temporal ordering field is renamed from sequenceNumber to position and remains caller supplied.')],
      }),
    ],
    links: [],
  },
  'kf-3': {
    assertions: [
      assertion({
        id: 'a-kf-3-async',
        episodeId: 'kf-3',
        position: 3,
        type: 'update',
        content: 'v0.3 phase 1 shapes store creation, retrieval, writing, and closing as asynchronous public operations.',
        confidence: 0.9,
        entityId: 'public-api',
        citations: [citation('c-a-kf-3-async', 'kf-3', 'sources/kf-2..kf-3.md', 'TemporalStore creation, retrieval, writing, and close behavior are shaped as asynchronous public operations.')],
      }),
      assertion({
        id: 'a-kf-3-observability',
        episodeId: 'kf-3',
        position: 3,
        type: 'fact',
        content: 'v0.3 phase 1 makes observability and lifecycle first-class library behavior.',
        confidence: 0.88,
        entityId: 'observability',
        citations: [citation('c-a-kf-3-observability', 'kf-3', 'sources/kf-2..kf-3.md', 'trageti starts treating observability and lifecycle as first-class library behavior.')],
      }),
      assertion({
        id: 'a-kf-3-errors',
        episodeId: 'kf-3',
        position: 3,
        type: 'fact',
        content: 'v0.3 phase 1 adds typed trageti errors for configuration, validation, and runtime failures.',
        confidence: 0.88,
        entityId: 'error-model',
        citations: [citation('c-a-kf-3-errors', 'kf-3', 'sources/kf-2..kf-3.md', 'The error foundation introduces typed trageti errors so callers can distinguish configuration, validation, and runtime failures.')],
      }),
    ],
    links: [
      link({ id: 'link-kf-3-observability', fromId: 'a-kf-3-observability', toId: 'a-kf-3-async', linkType: 'contextualizes', validFrom: 3, sourceEpisodeId: 'kf-3' }),
    ],
  },
  'kf-4': {
    assertions: [
      assertion({
        id: 'a-kf-4-vectorless',
        episodeId: 'kf-4',
        position: 4,
        type: 'fact',
        content: 'v0.3 phase 2 lets namespaces use BM25-only retrieval without vector rows.',
        confidence: 0.93,
        entityId: 'vectorless-namespaces',
        citations: [citation('c-a-kf-4-vectorless', 'kf-4', 'sources/kf-3..kf-4.md', 'Migration v003 records vectorless namespace state so a namespace can use BM25-only retrieval without requiring vector rows.')],
      }),
      assertion({
        id: 'a-kf-4-lazy-vec',
        episodeId: 'kf-4',
        position: 4,
        type: 'fact',
        content: 'v0.3 phase 2 creates vector tables lazily for namespaces that need embeddings.',
        confidence: 0.9,
        entityId: 'vectorless-namespaces',
        citations: [citation('c-a-kf-4-lazy-vec', 'kf-4', 'sources/kf-3..kf-4.md', 'Vector tables are created lazily for namespaces that need embeddings rather than eagerly for every namespace.')],
      }),
      assertion({
        id: 'a-kf-4-fk-toggle',
        episodeId: 'kf-4',
        position: 4,
        type: 'fact',
        content: 'v0.3 phase 2 toggles foreign-key enforcement around migrations and restores enforcement afterward.',
        confidence: 0.88,
        entityId: 'schema-migrations',
        citations: [citation('c-a-kf-4-fk-toggle', 'kf-4', 'sources/kf-3..kf-4.md', 'The migration runner toggles foreign-key enforcement around migrations and restores enforcement after schema changes complete.')],
      }),
    ],
    links: [],
  },
  'kf-5': {
    assertions: [
      assertion({
        id: 'a-kf-5-raw-vector',
        episodeId: 'kf-5',
        position: 5,
        type: 'fact',
        content: 'v0.3 phase 3 adds RawVectorProvider for caller-supplied vectors.',
        confidence: 0.94,
        entityId: 'embedding-providers',
        citations: [citation('c-a-kf-5-raw-vector', 'kf-5', 'sources/kf-4..kf-5.md', 'RawVectorProvider returns caller-supplied vectors directly, which lets fixtures exercise sqlite-vec without making live embedding requests.')],
      }),
      assertion({
        id: 'a-kf-5-indexing',
        episodeId: 'kf-5',
        position: 5,
        type: 'update',
        content: 'v0.3 phase 3 moves assertion indexing to the embedding provider boundary.',
        confidence: 0.92,
        entityId: 'embedding-providers',
        citations: [citation('c-a-kf-5-indexing', 'kf-5', 'sources/kf-4..kf-5.md', 'Phase 3 moves indexing to the embedding provider boundary.')],
      }),
      assertion({
        id: 'a-kf-5-rebuild-fts',
        episodeId: 'kf-5',
        position: 5,
        type: 'fact',
        content: 'v0.3 phase 3 adds rebuildFts as a public maintenance path for full-text search.',
        confidence: 0.9,
        entityId: 'fts-maintenance',
        citations: [citation('c-a-kf-5-rebuild-fts', 'kf-5', 'sources/kf-4..kf-5.md', 'rebuildFts gives applications a public maintenance path for rebuilding full-text search state from stored assertions.')],
      }),
    ],
    links: [
      link({ id: 'link-kf-5-vectorless', fromId: 'a-kf-5-indexing', toId: 'a-kf-4-vectorless', linkType: 'deepens', validFrom: 5, sourceEpisodeId: 'kf-5' }),
    ],
  },
  'kf-6': {
    assertions: [
      assertion({
        id: 'a-kf-6-routing',
        episodeId: 'kf-6',
        position: 6,
        type: 'update',
        content: 'v0.3 phase 4 makes retrieval strategy routing explicit for vector, BM25, and hybrid search.',
        confidence: 0.93,
        entityId: 'retrieval-routing',
        citations: [citation('c-a-kf-6-routing', 'kf-6', 'sources/kf-5..kf-6.md', 'Retrieval strategy routing decides when vector search, BM25 search, or hybrid search should run for a query.')],
      }),
      assertion({
        id: 'a-kf-6-query-mode',
        episodeId: 'kf-6',
        position: 6,
        type: 'fact',
        content: 'v0.3 phase 4 adds queryTextMode so text search interpretation is configurable.',
        confidence: 0.9,
        entityId: 'retrieval-routing',
        citations: [citation('c-a-kf-6-query-mode', 'kf-6', 'sources/kf-5..kf-6.md', 'queryTextMode controls how query text is interpreted for text search rather than forcing every query into the same BM25 behavior.')],
      }),
      assertion({
        id: 'a-kf-6-tiebreak',
        episodeId: 'kf-6',
        position: 6,
        type: 'fact',
        content: 'v0.3 phase 4 stabilizes retrieval ordering with deterministic tie-breaks.',
        confidence: 0.9,
        entityId: 'retrieval-determinism',
        citations: [citation('c-a-kf-6-tiebreak', 'kf-6', 'sources/kf-5..kf-6.md', 'Deterministic tie-breaks stabilize retrieval ordering when multiple candidates have comparable scores.')],
      }),
    ],
    links: [
      link({ id: 'link-kf-6-scoring', fromId: 'a-kf-6-routing', toId: 'a-kf-1-scoring', linkType: 'deepens', validFrom: 6, sourceEpisodeId: 'kf-6' }),
    ],
  },
  'kf-7': {
    assertions: [
      assertion({
        id: 'a-kf-7-release',
        episodeId: 'kf-7',
        position: 7,
        type: 'fact',
        content: 'The v0.3.0 release gate updates package metadata, README, changelog, migration guidance, and verification docs.',
        confidence: 0.9,
        entityId: 'release-readiness',
        citations: [citation('c-a-kf-7-release', 'kf-7', 'sources/kf-6..kf-7.md', 'The commit updates package metadata, README, changelog, migration guidance, and the verification matrix.')],
      }),
      assertion({
        id: 'a-kf-7-coverage',
        episodeId: 'kf-7',
        position: 7,
        type: 'fact',
        content: 'v0.3.0 makes coverage thresholds part of release readiness.',
        confidence: 0.88,
        entityId: 'release-readiness',
        citations: [citation('c-a-kf-7-coverage', 'kf-7', 'sources/kf-6..kf-7.md', 'Coverage thresholds become part of release readiness, making test coverage an enforced quality gate rather than an informal target.')],
      }),
    ],
    links: [],
  },
  'kf-8': {
    assertions: [
      assertion({
        id: 'a-kf-8-envelope',
        episodeId: 'kf-8',
        position: 8,
        type: 'update',
        content: 'v0.3 remediation R1 changes retrieval to return a RetrievalResult envelope with metadata and applied signals.',
        confidence: 0.94,
        entityId: 'retrieval-result',
        citations: [citation('c-a-kf-8-envelope', 'kf-8', 'sources/kf-7..kf-8.md', 'Retrieval now returns a RetrievalResult envelope with results, candidate counts, strategy metadata, and applied retrieval signals.')],
      }),
      assertion({
        id: 'a-kf-8-fk-fail-closed',
        episodeId: 'kf-8',
        position: 8,
        type: 'update',
        content: 'v0.3 remediation R1 treats foreign-key enforcement as fail-closed.',
        confidence: 0.9,
        entityId: 'data-integrity',
        citations: [citation('c-a-kf-8-fk-fail-closed', 'kf-8', 'sources/kf-7..kf-8.md', 'Foreign-key enforcement is treated as fail-closed so integrity failures cannot silently continue with constraints disabled.')],
      }),
      assertion({
        id: 'a-kf-8-close-assertion',
        episodeId: 'kf-8',
        position: 8,
        type: 'fact',
        content: 'v0.3 remediation R1 adds advanced.closeAssertion for explicit assertion lifecycle management.',
        confidence: 0.88,
        entityId: 'assertion-lifecycle',
        citations: [citation('c-a-kf-8-close-assertion', 'kf-8', 'sources/kf-7..kf-8.md', 'advanced.closeAssertion gives callers a direct method for closing an assertion validity window.')],
      }),
    ],
    links: [
      link({ id: 'link-kf-8-routing', fromId: 'a-kf-8-envelope', toId: 'a-kf-6-routing', linkType: 'deepens', validFrom: 8, sourceEpisodeId: 'kf-8' }),
    ],
  },
  'kf-9': {
    assertions: [
      assertion({
        id: 'a-kf-9-rename',
        episodeId: 'kf-9',
        position: 9,
        type: 'update',
        content: 'v0.3 remediation R6 renames live database tables from the trl_ prefix to the trageti_ prefix.',
        confidence: 0.95,
        entityId: 'schema-migrations',
        citations: [citation('c-a-kf-9-rename', 'kf-9', 'sources/kf-8..kf-9.md', 'Migration v005 renames every live trl_ table to the trageti_ prefix and preserves existing data during the transition.')],
      }),
      assertion({
        id: 'a-kf-9-timestamps',
        episodeId: 'kf-9',
        position: 9,
        type: 'fact',
        content: 'v0.3 remediation R6 adds timestamp columns through migration v004.',
        confidence: 0.88,
        entityId: 'schema-migrations',
        citations: [citation('c-a-kf-9-timestamps', 'kf-9', 'sources/kf-8..kf-9.md', 'Migration v004 adds timestamp columns needed by the v0.3 schema contract.')],
      }),
      assertion({
        id: 'a-kf-9-verification',
        episodeId: 'kf-9',
        position: 9,
        type: 'fact',
        content: 'v0.3 remediation R6 refreshes verification docs to match migrations and repository behavior.',
        confidence: 0.86,
        entityId: 'release-readiness',
        citations: [citation('c-a-kf-9-verification', 'kf-9', 'sources/kf-8..kf-9.md', 'The verification document is refreshed so spec claims match the implemented migrations and repository behavior.')],
      }),
    ],
    links: [
      link({ id: 'link-kf-9-fk', fromId: 'a-kf-9-rename', toId: 'a-kf-8-fk-fail-closed', linkType: 'contextualizes', validFrom: 9, sourceEpisodeId: 'kf-9' }),
    ],
  },
  'kf-10': {
    assertions: [
      assertion({
        id: 'a-kf-10-snapshot',
        episodeId: 'kf-10',
        position: 10,
        type: 'update',
        content: 'v0.3 polish fixes snapshot supersession semantics so current snapshots reflect active assertions.',
        confidence: 0.94,
        entityId: 'snapshot-retrieval',
        citations: [citation('c-a-kf-10-snapshot', 'kf-10', 'sources/kf-9..kf-10.md', 'Snapshot retrieval filters superseded assertions so a current snapshot reflects the active assertion set.')],
      }),
      assertion({
        id: 'a-kf-10-graph',
        episodeId: 'kf-10',
        position: 10,
        type: 'fact',
        content: 'v0.3 polish makes graph traversal deterministic.',
        confidence: 0.9,
        entityId: 'graph-retrieval',
        citations: [citation('c-a-kf-10-graph', 'kf-10', 'sources/kf-9..kf-10.md', 'Graph traversal is made deterministic so equivalent paths return in a stable and explainable order.')],
      }),
      assertion({
        id: 'a-kf-10-startup',
        episodeId: 'kf-10',
        position: 10,
        type: 'fact',
        content: 'v0.3 polish corrects startup step order for schema preparation, extension loading, and migration checks.',
        confidence: 0.88,
        entityId: 'lifecycle',
        citations: [citation('c-a-kf-10-startup', 'kf-10', 'sources/kf-9..kf-10.md', 'Startup step order is corrected so schema preparation, extension loading, and migration checks happen predictably.')],
      }),
    ],
    links: [
      link({ id: 'link-kf-10-snapshot', fromId: 'a-kf-10-snapshot', toId: 'a-kf-2-trajectory', linkType: 'deepens', validFrom: 10, sourceEpisodeId: 'kf-10' }),
      link({ id: 'link-kf-10-graph', fromId: 'a-kf-10-graph', toId: 'a-kf-6-tiebreak', linkType: 'deepens', validFrom: 10, sourceEpisodeId: 'kf-10' }),
    ],
  },
}

export const fixtures: Record<string, string> = Object.fromEntries(
  Object.entries(byEpisode).map(([episodeId, value]) => [episodeId, JSON.stringify(value)]),
)
