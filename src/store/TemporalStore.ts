/* eslint-disable @typescript-eslint/require-await */
import type { Database } from 'better-sqlite3'
import type {
  Episode,
  Assertion,
  AssertionLink,
  AssertionCitation,
  NewAssertion,
  NewAssertionInput,
  NormalizedNewAssertion,
  NamespaceConfig,
  TemporalStoreOptions,
  CreateStoreOptions,
  NamespaceStats,
  MigrationDescriptor,
  RetrievalQuery,
  RetrievedAssertion,
  ContextAssemblyOptions,
  AssembledContext,
  IndexBatchItem,
  IndexBatchOptions,
  IndexBatchResult,
  DeleteNamespaceOptions,
  ReindexOptions,
  ReindexResult,
  RebuildFtsOptions,
  RebuildFtsResult,
  RetrievalExplainResult,
} from '../domain/types.js'
import { MigrationRunner } from '../db/migrations/runner.js'
import { SchemaExtensionApplier } from '../db/schema/extensions.js'
import { NamespaceRepository } from '../db/repositories/NamespaceRepository.js'
import { EpisodeRepository } from '../db/repositories/EpisodeRepository.js'
import { AssertionRepository } from '../db/repositories/AssertionRepository.js'
import { CitationRepository } from '../db/repositories/CitationRepository.js'
import { LinkRepository } from '../db/repositories/LinkRepository.js'
import { EmbeddingRepository } from '../db/repositories/EmbeddingRepository.js'
import { DefaultConnectionVerifier } from '../defaults/connection/DefaultConnectionVerifier.js'
import { DefaultAssertionValidator } from '../defaults/validation/DefaultAssertionValidator.js'
import { CTEGraphAdapter } from '../defaults/graph/CTEGraphAdapter.js'
import { DefaultScorer } from '../defaults/scoring/DefaultScorer.js'
import { ProseFormatter } from '../defaults/formatting/ProseFormatter.js'
import {
  NamespaceNotInitializedError,
  StoreClosedError,
  ValidationError,
  IndexingError,
  MissingPeerDependencyError,
  ReferencedExtensionTableError,
  RetrievalInputError,
  ErrorCode,
} from '../errors/index.js'
import { ConsoleLogger, setDefaultLogger, structuredWarn } from '../internal/logger.js'
import { namespaceToEmbeddingTable } from '../internal/hash.js'
import { quoteIdent } from '../internal/sql-ident.js'
import { prepareDatabase } from '../defaults/connection/prepareDatabase.js'
import { retrieve } from '../pipeline/retrieve.js'
import { assembleContext } from '../pipeline/assemble.js'
import { getTemporalSnapshot } from '../pipeline/snapshot.js'
import { getConnected, findPath } from '../pipeline/graph.js'
import { reindexNamespace as doReindex } from '../pipeline/reindex.js'

const DEFAULT_MAX_EPISODE_CONTENT_BYTES = 8192

export class TemporalStore {
  private readonly db: Database
  private readonly options: TemporalStoreOptions & {
    graphAdapter: NonNullable<TemporalStoreOptions['graphAdapter']>
    scorer: NonNullable<TemporalStoreOptions['scorer']>
    defaultFormatter: NonNullable<TemporalStoreOptions['defaultFormatter']>
    validators: NonNullable<TemporalStoreOptions['validators']>
    connectionVerifier: NonNullable<TemporalStoreOptions['connectionVerifier']>
    middleware: NonNullable<TemporalStoreOptions['middleware']>
    fts5Tokenizer: NonNullable<TemporalStoreOptions['fts5Tokenizer']>
    schemaExtensions: NonNullable<TemporalStoreOptions['schemaExtensions']>
    maxEpisodeContentBytes: number
    logger: NonNullable<TemporalStoreOptions['logger']>
  }
  private readonly closeDatabaseOnStoreClose: boolean

  private migrationRunner!: MigrationRunner
  private extensionApplier!: SchemaExtensionApplier
  private namespaceRepo!: NamespaceRepository
  private episodeRepo!: EpisodeRepository
  private assertionRepo!: AssertionRepository
  private citationRepo!: CitationRepository
  private linkRepo!: LinkRepository
  private embeddingRepo!: EmbeddingRepository

  /** Cache: namespace → embedding table name */
  private readonly embeddingTableCache = new Map<string, string>()
  /** Cache: table → extension column names (for extensions bag) */
  private extensionColumnCache = new Map<string, string[]>()

  private initialized = false
  private closed = false

  static async create(options: CreateStoreOptions): Promise<TemporalStore> {
    const db = prepareDatabase(options.database, options.prepare)
    const store = new TemporalStore(db, options, {
      closeDatabaseOnStoreClose: options.closeDatabaseOnStoreClose ?? typeof options.database === 'string',
    })
    await store.init()
    return store
  }

  constructor(
    db: Database,
    options: TemporalStoreOptions,
    internal: { closeDatabaseOnStoreClose?: boolean } = {},
  ) {
    this.db = db
    this.options = {
      graphAdapter: options.graphAdapter ?? new CTEGraphAdapter(),
      scorer: options.scorer ?? new DefaultScorer(),
      defaultFormatter: options.defaultFormatter ?? new ProseFormatter(),
      validators: options.validators ?? [],
      connectionVerifier: options.connectionVerifier ?? new DefaultConnectionVerifier(),
      middleware: options.middleware ?? [],
      fts5Tokenizer: options.fts5Tokenizer ?? { tokenizer: 'unicode61', tokenizerArgs: ['remove_diacritics', '1'] },
      schemaExtensions: options.schemaExtensions ?? {},
      maxEpisodeContentBytes: options.maxEpisodeContentBytes ?? DEFAULT_MAX_EPISODE_CONTENT_BYTES,
      namespace: options.namespace,
      embeddingDimension: options.embeddingDimension,
      embeddingProvider: options.embeddingProvider,
      logger: options.logger ?? new ConsoleLogger(),
      metrics: options.metrics,
      validation: options.validation,
    } as typeof this.options
    this.closeDatabaseOnStoreClose = internal.closeDatabaseOnStoreClose ?? false
    setDefaultLogger(this.options.logger)
  }

  async init(): Promise<void> {
    this.requireNotClosed('init')
    // (a) connection verification
    this.options.connectionVerifier.verify(this.db, this.options.logger)

    // (b) migrations
    this.migrationRunner = new MigrationRunner(this.options.fts5Tokenizer)
    this.migrationRunner.applyMigrations(this.db)

    // (c) schema extensions validate + apply
    this.extensionApplier = new SchemaExtensionApplier()
    this.extensionApplier.validate(this.options.schemaExtensions)
    this.extensionApplier.apply(this.db, this.options.schemaExtensions)

    // (d) namespace registration
    this.namespaceRepo = new NamespaceRepository(this.db)
    const dimension = this.options.embeddingDimension ?? this.options.embeddingProvider?.dimension ?? null
    this.namespaceRepo.upsert(this.options.namespace, dimension)

    // (e) warm extension column cache
    this.warmExtensionCache()

    // Create repositories with extension column awareness
    this.episodeRepo = new EpisodeRepository(this.db, this.extensionColumnCache.get('trl_episodes') ?? [])
    this.citationRepo = new CitationRepository(this.db)
    this.assertionRepo = new AssertionRepository(
      this.db,
      this.citationRepo,
      this.extensionColumnCache.get('trl_assertions') ?? [],
    )
    this.linkRepo = new LinkRepository(this.db)
    this.embeddingRepo = new EmbeddingRepository(this.db)

    // Add default validators if none provided
    if (this.options.validators.length === 0) {
      this.options.validators.push(new DefaultAssertionValidator(this.db))
    }

    this.initialized = true
  }

  async initNamespace(namespace: string, config: Partial<NamespaceConfig> = {}): Promise<NamespaceConfig> {
    this.requireInit()
    const dimension = config.embeddingDimension ?? this.options.embeddingDimension ?? this.options.embeddingProvider?.dimension ?? null
    this.namespaceRepo.upsert(namespace, dimension, config.config ?? {})
    const stored = this.namespaceRepo.get(namespace)
    if (!stored) throw new NamespaceNotInitializedError(namespace)
    return stored
  }

  // ─── Writing ───────────────────────────────────────────────────────────────

  async writeEpisode(episode: Omit<Episode, 'createdAt'>): Promise<Episode> {
    this.requireNamespaceInit(episode.namespace)
    const maxBytes = this.options.maxEpisodeContentBytes
    if (maxBytes > 0) {
      const byteLen = Buffer.byteLength(episode.content, 'utf8')
      if (byteLen > maxBytes) {
        structuredWarn('EPISODE_CONTENT_LARGE', { namespace: episode.namespace, byteLen, maxBytes })
      }
    }
    return this.episodeRepo.insert(episode)
  }

  async writeAssertion(input: NewAssertionInput): Promise<Assertion> {
    const assertion = this.normalizeAssertionInput(input)
    this.requireNamespaceInit(assertion.namespace)

    // ─── Structural invariants (decision §2) ─────────────────────────────────
    // Enforced here, NOT in DefaultAssertionValidator — replacing the validators
    // array does not bypass these. Configured validators run *after* and only if
    // structural checks pass; this avoids duplicate error messages on the same
    // field.
    this.enforceStructuralInvariants(assertion)

    // ─── User-facing validators (replaceable) ───────────────────────────────
    const errors: string[] = []
    for (const validator of this.options.validators) {
      const result = validator.validate(assertion)
      if (!result.valid) errors.push(...result.errors)
    }
    if (errors.length > 0) throw new ValidationError(errors)

    // ─── Atomic write ───────────────────────────────────────────────────────
    return this.db.transaction(() => {
      this.assertionRepo.insert(assertion)
      const citations = this.citationRepo.insertMany(assertion.id, assertion.citations)
      if (assertion.supersedesId !== null) {
        this.assertionRepo.supersedeAssertion(assertion.supersedesId, assertion.validFrom)
      }
      const inserted = this.assertionRepo.getById(assertion.id)
      if (!inserted) throw new Error(`Assertion "${assertion.id}" not found after insert`)
      // getById already populates citations; pass through without re-fetching
      return { ...inserted, citations }
    })()
  }

  async writeCitation(citation: Omit<AssertionCitation, 'createdAt'>): Promise<AssertionCitation> {
    this.requireInit()
    const errors: string[] = []
    if (!citation.id || !citation.id.trim()) errors.push('citation.id is required')
    if (!citation.sourceRef || !citation.sourceRef.trim()) errors.push('citation.sourceRef is required')

    const parent = this.assertionRepo.getById(citation.assertionId)
    if (!parent) {
      errors.push(`citation.assertionId "${citation.assertionId}" does not reference an existing assertion`)
    } else {
      const ep = this.db
        .prepare<[string, string], { id: string }>(
          'SELECT id FROM trl_episodes WHERE id = ? AND namespace = ?',
        )
        .get(citation.episodeId, parent.namespace)
      if (!ep) {
        errors.push(
          `citation.episodeId "${citation.episodeId}" does not reference an episode in namespace "${parent.namespace}"`,
        )
      }
    }
    if (errors.length > 0) throw new ValidationError(errors)

    if (citation.excerpt === null) {
      structuredWarn('CITATION_EXCERPT_MISSING', { assertionId: citation.assertionId, citationId: citation.id })
    }
    return this.citationRepo.insertOne(citation)
  }

  async supersedeAssertion(
    assertionId: string,
    options: { validUntil: number; replacedById?: string },
  ): Promise<void> {
    this.requireInit()
    const existing = this.assertionRepo.getById(assertionId)
    if (!existing) throw new ValidationError([`Assertion "${assertionId}" not found`])
    if (existing.validUntil !== null) {
      throw new ValidationError([
        `Assertion "${assertionId}" is already closed (valid_until=${existing.validUntil}); cannot re-supersede. Mutating an established replacement chain is rejected (decision §2).`,
      ])
    }
    if (options.validUntil <= existing.validFrom) {
      throw new ValidationError([`validUntil must be strictly greater than validFrom (${existing.validFrom})`])
    }
    if (options.replacedById !== undefined) {
      const replacement = this.assertionRepo.getById(options.replacedById)
      if (replacement && replacement.namespace !== existing.namespace) {
        throw new ValidationError([
          `replacedById "${options.replacedById}" is in namespace "${replacement.namespace}", not "${existing.namespace}". Cross-namespace supersession is not supported.`,
        ])
      }
    }
    this.assertionRepo.supersedeAssertion(assertionId, options.validUntil)
  }

  async writeLink(link: Omit<AssertionLink, 'createdAt'>): Promise<AssertionLink> {
    this.requireNamespaceInit(link.namespace)
    // Warn once per cross-namespace link pair (spec §Future: permitted but flagged)
    const fromA = this.assertionRepo.getById(link.fromId)
    const toA = this.assertionRepo.getById(link.toId)
    if (fromA && toA && fromA.namespace !== toA.namespace) {
      structuredWarn('CROSS_NAMESPACE_LINK', { fromNs: fromA.namespace, toNs: toA.namespace })
    }
    return this.linkRepo.insert(link)
  }

  // ─── Indexing ──────────────────────────────────────────────────────────────

  async indexAssertion(assertionId: string, embedding: Float32Array | number[]): Promise<void> {
    this.requireInit()
    const assertion = this.assertionRepo.getById(assertionId)
    if (!assertion) throw new ValidationError([`Assertion "${assertionId}" not found`])
    const table = this.ensureVectorReady(assertion.namespace, 'indexing')
    this.embeddingRepo.insert(table, assertionId, embedding)
  }

  async indexBatch(items: IndexBatchItem[], _options: IndexBatchOptions = {}): Promise<IndexBatchResult> {
    this.requireInit()
    // Group by namespace for efficiency
    const byTable = new Map<string, Array<{ assertionId: string; embedding: Float32Array | number[] }>>()
    for (const item of items) {
      const assertion = this.assertionRepo.getById(item.assertionId)
      if (!assertion || !item.embedding) continue
      const table = this.ensureVectorReady(assertion.namespace, 'indexing')
      const group = byTable.get(table) ?? []
      group.push({ assertionId: item.assertionId, embedding: item.embedding })
      byTable.set(table, group)
    }
    for (const [table, batch] of byTable.entries()) {
      this.embeddingRepo.insertBatch(table, batch)
    }
    return { indexed: items.length, skipped: [] }
  }

  async getPendingIndexing(namespace: string): Promise<Array<{ id: string; content: string }>> {
    this.requireNamespaceInit(namespace)
    const table = this.ensureVectorReady(namespace, 'indexing')
    return this.embeddingRepo.getPendingIndexing(table, namespace)
  }

  // ─── Retrieval ─────────────────────────────────────────────────────────────

  async retrieve(query: RetrievalQuery): Promise<RetrievedAssertion[]> {
    this.requireNamespaceInit(query.namespace)
    return retrieve(this.db, {
      assertionRepo: this.assertionRepo,
      embeddingRepo: this.embeddingRepo,
      getEmbeddingTable: (ns) => this.ensureVectorReady(ns, 'retrieval'),
      getPositionRange: (ns) => this.namespaceRepo.getPositionRange(ns),
      globalScorer: this.options.scorer,
      globalMiddleware: this.options.middleware,
      graphAdapter: this.options.graphAdapter,
    }, query)
  }

  async assembleContext(options: ContextAssemblyOptions): Promise<AssembledContext> {
    this.requireNamespaceInit(options.namespace)
    return await assembleContext(this, {
      globalFormatter: this.options.defaultFormatter,
      ...options,
    })
  }

  // ─── Snapshot ──────────────────────────────────────────────────────────────

  async getTemporalSnapshot(options: {
    namespace: string
    atPosition: number
    entityTypes?: string[]
    assertionTypes?: string[]
    includeSuperseded?: boolean
  }): Promise<Assertion[]> {
    this.requireNamespaceInit(options.namespace)
    return getTemporalSnapshot(this.db, this.assertionRepo, options)
  }

  // ─── Graph ─────────────────────────────────────────────────────────────────

  async getConnected(options: {
    namespace: string
    fromAssertionId: string
    maxDepth?: number
    linkTypes?: string[]
    temporalAnchor: number
  }): Promise<Assertion[]> {
    this.requireNamespaceInit(options.namespace)
    return getConnected(this.db, this.assertionRepo, this.options.graphAdapter, options)
  }

  async findPath(options: {
    namespace: string
    fromAssertionId: string
    toAssertionId: string
    maxDepth?: number
    temporalAnchor: number
  }): Promise<AssertionLink[] | null> {
    this.requireNamespaceInit(options.namespace)
    return findPath(this.db, this.options.graphAdapter, options)
  }

  // ─── Utility ───────────────────────────────────────────────────────────────

  async getAssertions(namespace: string, options?: {
    entityId?: string
    entityType?: string
    type?: string
    validAt?: number
    includeSuperseded?: boolean
  }): Promise<Assertion[]> {
    this.requireNamespaceInit(namespace)
    return this.assertionRepo.query(namespace, options)
  }

  async getEntityHistory(namespace: string, entityId: string): Promise<Assertion[]> {
    this.requireNamespaceInit(namespace)
    return this.assertionRepo.getEntityHistory(namespace, entityId)
  }

  /**
   * Returns the supersession-chain leaves for an entity (decision §5). Follows
   * supersedes_id only — does NOT traverse trl_links. For entities where new
   * information layers rather than replaces, use writeLink with one of the
   * accumulation link types and read with getEntityHistory + expandLinks.
   */
  async getEntityTrajectory(namespace: string, entityId: string): Promise<Assertion[]> {
    this.requireNamespaceInit(namespace)
    return this.assertionRepo.getEntityTrajectory(namespace, entityId)
  }

  async getEpisode(id: string): Promise<Episode | null> {
    this.requireInit()
    return this.episodeRepo.getById(id)
  }

  async deleteNamespace(namespace: string, options: DeleteNamespaceOptions = {}): Promise<void> {
    this.requireInit()
    const refTables = (this.options.schemaExtensions.tables ?? []).filter((t) => t.referencesNamespace)
    if (refTables.length > 0) {
      if (!options.cascade) {
        throw new ReferencedExtensionTableError(namespace, refTables.map((table) => table.tableName))
      }
    }
    this.db.transaction(() => {
      for (const table of refTables) {
        if (!table.namespaceColumn) continue
        this.db.prepare(`DELETE FROM ${quoteIdent(table.tableName)} WHERE ${quoteIdent(table.namespaceColumn)} = ?`).run(namespace)
      }
      const table = this.namespaceRepo.getEmbeddingTable(namespace)
      if (table) this.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(table)}`)
      // Citations must go before assertions (FK from trl_citations.assertion_id).
      this.citationRepo.deleteByAssertionNamespace(namespace)
      this.db.prepare('DELETE FROM trl_links WHERE namespace = ?').run(namespace)
      this.db.prepare('DELETE FROM trl_assertions WHERE namespace = ?').run(namespace)
      this.db.prepare('DELETE FROM trl_episodes WHERE namespace = ?').run(namespace)
      this.db.prepare('DELETE FROM trl_namespaces WHERE namespace = ?').run(namespace)
      this.embeddingTableCache.delete(namespace)
    })()
  }

  async reindexNamespace(
    namespace: string,
    options: ReindexOptions & {
      newDimension: number
      embeddingProvider: (assertionId: string, content: string) => Promise<Float32Array>
    },
  ): Promise<ReindexResult> {
    this.requireNamespaceInit(namespace)
    await doReindex(this.db, this.namespaceRepo, this.embeddingRepo, this.assertionRepo, namespace, options)
    // Re-warm embedding table cache
    const newTable = this.namespaceRepo.getEmbeddingTable(namespace)
    if (newTable) this.embeddingTableCache.set(namespace, newTable)
    return { reindexed: this.assertionRepo.getStats(namespace).assertionCount, skipped: [], durationMs: 0 }
  }

  async getStats(namespace: string): Promise<NamespaceStats> {
    this.requireNamespaceInit(namespace)
    const assertionStats = this.assertionRepo.getStats(namespace)
    const episodeCount = (
      this.db
        .prepare<[string], { cnt: number }>('SELECT COUNT(*) AS cnt FROM trl_episodes WHERE namespace = ?')
        .get(namespace)
    )?.cnt ?? 0
    const ns = this.namespaceRepo.get(namespace)
    const table = this.namespaceRepo.getEmbeddingTable(namespace)
    const vectorReady = Boolean(table && this.isSqliteVecLoaded() && this.embeddingRepo.tableExists(table))
    const indexedCount = vectorReady && table ? this.embeddingRepo.getIndexedCount(table, namespace) : 0
    const linkCount = this.linkRepo.getCount(namespace)
    const positionRange = this.namespaceRepo.getPositionRange(namespace)
    return {
      namespace,
      embeddingDimension: ns?.embeddingDimension ?? null,
      vectorReady,
      episodeCount,
      ...assertionStats,
      citationCount: this.citationRepo.getCountByNamespace(namespace),
      indexedCount,
      linkCount,
      positionRange,
    }
  }

  async getMigrations(): Promise<readonly MigrationDescriptor[]> {
    this.requireInit()
    return this.migrationRunner.getMigrations().map((migration) => ({
      version: migration.version,
      name: migration.name ?? migration.description,
      description: migration.description,
      requiresForeignKeyToggle: migration.requiresForeignKeyToggle ?? false,
    }))
  }

  async getCurrentSchemaVersion(): Promise<number> {
    return new MigrationRunner().getCurrentVersion(this.db)
  }

  async applyMigrations(): Promise<void> {
    new MigrationRunner(this.options.fts5Tokenizer).applyMigrations(this.db)
  }

  async rebuildFts(_options: RebuildFtsOptions = {}): Promise<RebuildFtsResult> {
    this.requireInit()
    return { reindexedRows: 0, newTokenizer: this.options.fts5Tokenizer, durationMs: 0 }
  }

  async upgradeNamespaceToVector(namespace: string, options: { embeddingDimension: number }): Promise<void> {
    this.requireNamespaceInit(namespace)
    const table = namespaceToEmbeddingTable(namespace)
    this.db.transaction(() => {
      this.namespaceRepo.updateEmbeddingDimension(namespace, options.embeddingDimension, table)
      this.embeddingTableCache.set(namespace, table)
    })()
    this.options.logger.info?.('TRGT_NAMESPACE_VECTOR_UPGRADED', {
      namespace,
      embeddingDimension: options.embeddingDimension,
    })
  }

  async explain(query: RetrievalQuery): Promise<RetrievalExplainResult> {
    this.requireNamespaceInit(query.namespace)
    return {
      query,
      retrievalStrategy: query.retrievalStrategy ?? 'hybrid',
      steps: [{ name: 'validate' }],
      wouldApplyVector: query.retrievalStrategy !== 'bm25',
      wouldApplyBm25: Boolean(query.queryText),
      notes: [],
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const middleware of this.options.middleware) {
      await middleware.dispose?.()
    }
    await this.options.logger.flush?.()
    if (this.closeDatabaseOnStoreClose) {
      this.db.close()
    }
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Structural invariants (decision §2). These are enforced by TemporalStore
   * directly so that replacing the validators array cannot bypass them.
   */
  private enforceStructuralInvariants(assertion: NewAssertion): void {
    const errors: string[] = []

    // Citation presence + per-citation fields
    if (!Array.isArray(assertion.citations) || assertion.citations.length === 0) {
      errors.push('citations array is required and must contain at least one entry')
    } else {
      for (const cit of assertion.citations) {
        if (!cit.id || !cit.id.trim()) errors.push('citation.id is required')
        if (!cit.sourceRef || !cit.sourceRef.trim()) errors.push(`citation "${cit.id}" sourceRef is required`)
        if (!cit.episodeId || !cit.episodeId.trim()) {
          errors.push(`citation "${cit.id}" episodeId is required`)
        } else {
          const ep = this.db
            .prepare<[string, string], { id: string }>(
              'SELECT id FROM trl_episodes WHERE id = ? AND namespace = ?',
            )
            .get(cit.episodeId, assertion.namespace)
          if (!ep) {
            errors.push(
              `citation "${cit.id}" episodeId "${cit.episodeId}" does not reference an episode in namespace "${assertion.namespace}"`,
            )
          }
        }
      }
    }

    // Predecessor checks (only if supersedesId set)
    if (assertion.supersedesId !== null) {
      const pred = this.assertionRepo.getById(assertion.supersedesId)
      if (!pred) {
        errors.push(`supersedesId "${assertion.supersedesId}" does not reference an existing assertion`)
      } else {
        if (pred.namespace !== assertion.namespace) {
          errors.push(
            `cross-namespace supersession not supported: predecessor "${pred.id}" is in namespace "${pred.namespace}", new assertion is in "${assertion.namespace}"`,
          )
        }
        if (assertion.validFrom <= pred.validFrom) {
          errors.push(
            `new.validFrom (${assertion.validFrom}) must be > predecessor.validFrom (${pred.validFrom})`,
          )
        }
        if (pred.validUntil !== null && pred.validUntil !== assertion.validFrom) {
          errors.push(
            `predecessor "${pred.id}" already closed at validUntil=${pred.validUntil}; cannot supersede with validFrom=${assertion.validFrom}`,
          )
        }
      }
    }

    if (errors.length > 0) throw new ValidationError(errors)
  }

  private normalizeAssertionInput(input: NewAssertionInput): NormalizedNewAssertion {
    return {
      ...input,
      validUntil: input.validUntil ?? null,
      supersedesId: input.supersedesId ?? null,
      entityId: input.entityId ?? null,
      entityType: input.entityType ?? null,
    }
  }

  private requireInit(): void {
    this.requireNotClosed()
    if (!this.initialized) {
      throw new NamespaceNotInitializedError(this.options.namespace)
    }
  }

  private requireNotClosed(operation?: string): void {
    if (this.closed) throw new StoreClosedError(operation)
  }

  private requireNamespaceInit(namespace: string): void {
    this.requireInit()
    if (!this.namespaceRepo.get(namespace)) {
      throw new NamespaceNotInitializedError(namespace)
    }
  }

  private getOrCacheEmbeddingTable(namespace: string): string | null {
    const cached = this.embeddingTableCache.get(namespace)
    if (cached) return cached
    const fromDb = this.namespaceRepo.getEmbeddingTable(namespace)
    if (fromDb) {
      this.embeddingTableCache.set(namespace, fromDb)
      return fromDb
    }
    // Namespace just created in this call — compute from hash
    return null
  }

  private requireEmbeddingTable(namespace: string): string {
    const table = this.getOrCacheEmbeddingTable(namespace)
    if (!table) throw new NamespaceNotInitializedError(namespace)
    return table
  }

  private ensureVectorReady(namespace: string, purpose: 'indexing' | 'retrieval'): string {
    this.requireNamespaceInit(namespace)
    const config = this.namespaceRepo.get(namespace)
    const table = this.getOrCacheEmbeddingTable(namespace)
    if (!config || config.embeddingDimension === null || table === null) {
      if (purpose === 'indexing') {
        throw new IndexingError(
          ErrorCode.INDEXING_NAMESPACE_VECTORLESS,
          `Namespace "${namespace}" is vectorless. Call upgradeNamespaceToVector() before indexing.`,
        )
      }
      throw new RetrievalInputError(
        ErrorCode.RETRIEVAL_NAMESPACE_VECTORLESS,
        `Namespace "${namespace}" is vectorless. Use BM25 retrieval or upgrade the namespace before vector retrieval.`,
      )
    }
    if (!this.isSqliteVecLoaded()) {
      throw new MissingPeerDependencyError(
        'sqlite-vec',
        'npm install sqlite-vec',
        'use vectorless/BM25-only retrieval or load sqlite-vec with prepareDatabase()',
      )
    }
    if (!this.embeddingRepo.tableExists(table)) {
      this.embeddingRepo.ensureVec0Table(table, config.embeddingDimension)
    }
    return table
  }

  private isSqliteVecLoaded(): boolean {
    try {
      this.db.prepare('SELECT vec_version()').get()
      return true
    } catch {
      return false
    }
  }

  private warmExtensionCache(): void {
    const tables: Array<'trl_assertions' | 'trl_episodes' | 'trl_links'> = [
      'trl_assertions',
      'trl_episodes',
      'trl_links',
    ]
    for (const table of tables) {
      const cols = this.extensionApplier.getExtensionColumns(this.db, table)
      this.extensionColumnCache.set(table, cols)
    }
  }

  /**
   * The single chokepoint guarding every vec0-touching path (spec §1527).
   *
   * - Throws when the namespace is vectorless (RetrievalInputError or
   *   IndexingError depending on call-site `kind`).
   * - Throws MissingPeerDependencyError when sqlite-vec is not loaded.
   * - Lazily CREATEs the namespace's vec0 virtual table on first use.
   *
   * Returns the stored embedding-table name on success.
   */
  private ensureVectorReady(namespace: string, kind: 'indexing' | 'retrieval'): string {
    const config = this.namespaceRepo.get(namespace)
    if (!config) throw new NamespaceNotInitializedError(namespace)
    const table = this.namespaceRepo.getEmbeddingTable(namespace)
    if (config.embeddingDimension === null || !table) {
      if (kind === 'indexing') {
        throw new IndexingError(
          ErrorCode.INDEXING_NAMESPACE_VECTORLESS,
          `Namespace "${namespace}" is vectorless; call upgradeNamespaceToVector() before indexing.`,
        )
      }
      throw new RetrievalInputError(
        ErrorCode.RETRIEVAL_NAMESPACE_VECTORLESS,
        `Namespace "${namespace}" is vectorless; use retrievalStrategy: 'bm25' or upgrade the namespace first.`,
      )
    }
    if (!this.isSqliteVecLoaded()) {
      throw new MissingPeerDependencyError(
        'sqlite-vec',
        'npm install sqlite-vec',
        kind === 'retrieval' ? "use retrievalStrategy: 'bm25'" : 'load sqlite-vec or use vectorless namespaces',
      )
    }
    if (!this.embeddingRepo.tableExists(table)) {
      this.embeddingRepo.ensureVec0Table(table, config.embeddingDimension)
    }
    this.embeddingTableCache.set(namespace, table)
    return table
  }

  /** Returns true when sqlite-vec's vec_version() function is callable. */
  private isSqliteVecLoaded(): boolean {
    try {
      this.db.prepare('SELECT vec_version() AS v').get()
      return true
    } catch {
      return false
    }
  }
}
