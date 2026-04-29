import type { Database } from 'better-sqlite3'
import type {
  Episode,
  Assertion,
  AssertionLink,
  NamespaceConfig,
  TemporalStoreOptions,
  NamespaceStats,
  Migration,
  RetrievalQuery,
  RetrievedAssertion,
  ContextAssemblyOptions,
  AssembledContext,
} from '../domain/types.js'
import { MigrationRunner } from '../db/migrations/runner.js'
import { SchemaExtensionApplier } from '../db/schema/extensions.js'
import { NamespaceRepository } from '../db/repositories/NamespaceRepository.js'
import { EpisodeRepository } from '../db/repositories/EpisodeRepository.js'
import { AssertionRepository } from '../db/repositories/AssertionRepository.js'
import { LinkRepository } from '../db/repositories/LinkRepository.js'
import { EmbeddingRepository } from '../db/repositories/EmbeddingRepository.js'
import { DefaultConnectionVerifier } from '../defaults/connection/DefaultConnectionVerifier.js'
import { DefaultAssertionValidator } from '../defaults/validation/DefaultAssertionValidator.js'
import { CTEGraphAdapter } from '../defaults/graph/CTEGraphAdapter.js'
import { DefaultScorer } from '../defaults/scoring/DefaultScorer.js'
import { ProseFormatter } from '../defaults/formatting/ProseFormatter.js'
import {
  NamespaceNotInitializedError,
  ValidationError,
} from '../errors/index.js'
import { structuredWarn } from '../internal/logger.js'
import { namespaceToEmbeddingTable } from '../internal/hash.js'
import { retrieve } from '../pipeline/retrieve.js'
import { assembleContext } from '../pipeline/assemble.js'
import { getTemporalSnapshot } from '../pipeline/snapshot.js'
import { getConnected, findPath } from '../pipeline/graph.js'
import { reindexNamespace as doReindex } from '../pipeline/reindex.js'

const DEFAULT_MAX_EPISODE_CONTENT_BYTES = 8192

export class TemporalStore {
  private readonly db: Database
  private readonly options: Required<TemporalStoreOptions>

  private migrationRunner!: MigrationRunner
  private extensionApplier!: SchemaExtensionApplier
  private namespaceRepo!: NamespaceRepository
  private episodeRepo!: EpisodeRepository
  private assertionRepo!: AssertionRepository
  private linkRepo!: LinkRepository
  private embeddingRepo!: EmbeddingRepository

  /** Cache: namespace → embedding table name */
  private readonly embeddingTableCache = new Map<string, string>()
  /** Cache: table → extension column names (for extensions bag) */
  private extensionColumnCache = new Map<string, string[]>()

  private initialized = false

  constructor(db: Database, options: TemporalStoreOptions) {
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
    }
  }

  init(): void {
    // (a) connection verification
    this.options.connectionVerifier.verify(this.db)

    // (b) migrations
    this.migrationRunner = new MigrationRunner(this.options.fts5Tokenizer)
    this.migrationRunner.applyMigrations(this.db)

    // (c) schema extensions validate + apply
    this.extensionApplier = new SchemaExtensionApplier()
    this.extensionApplier.validate(this.options.schemaExtensions)
    this.extensionApplier.apply(this.db, this.options.schemaExtensions)

    // (d) namespace registration
    this.namespaceRepo = new NamespaceRepository(this.db)
    this.namespaceRepo.upsert(this.options.namespace, this.options.embeddingDimension)

    // (e) warm extension column cache
    this.warmExtensionCache()

    // Create repositories with extension column awareness
    this.episodeRepo = new EpisodeRepository(this.db, this.extensionColumnCache.get('trl_episodes') ?? [])
    this.assertionRepo = new AssertionRepository(this.db, this.extensionColumnCache.get('trl_assertions') ?? [])
    this.linkRepo = new LinkRepository(this.db)
    this.embeddingRepo = new EmbeddingRepository(this.db)

    // Ensure vec0 table for default namespace
    const embeddingTable = this.getOrCacheEmbeddingTable(this.options.namespace)
    this.embeddingRepo.ensureVec0Table(embeddingTable, this.options.embeddingDimension)

    // Add default validators if none provided
    if (this.options.validators.length === 0) {
      this.options.validators.push(new DefaultAssertionValidator(this.db))
    }

    this.initialized = true
  }

  initNamespace(namespace: string, config: Partial<NamespaceConfig> = {}): void {
    this.requireInit()
    const dimension = config.embeddingDimension ?? this.options.embeddingDimension
    this.namespaceRepo.upsert(namespace, dimension, config.config ?? {})
    const embeddingTable = this.getOrCacheEmbeddingTable(namespace)
    this.embeddingRepo.ensureVec0Table(embeddingTable, dimension)
  }

  // ─── Writing ───────────────────────────────────────────────────────────────

  writeEpisode(episode: Omit<Episode, 'createdAt'>): Episode {
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

  writeAssertion(assertion: Omit<Assertion, 'createdAt' | 'extensions'>): Assertion {
    this.requireNamespaceInit(assertion.namespace)
    const errors: string[] = []
    for (const validator of this.options.validators) {
      const result = validator.validate(assertion)
      if (!result.valid) errors.push(...result.errors)
    }
    if (errors.length > 0) throw new ValidationError(errors)
    return this.assertionRepo.insert(assertion)
  }

  supersedeAssertion(
    assertionId: string,
    options: { validUntil: number; replacedById?: string },
  ): void {
    this.requireInit()
    const existing = this.assertionRepo.getById(assertionId)
    if (!existing) throw new ValidationError([`Assertion "${assertionId}" not found`])
    if (options.validUntil <= existing.validFrom) {
      throw new ValidationError([`validUntil must be strictly greater than validFrom (${existing.validFrom})`])
    }
    if (options.replacedById) {
      const replacement = this.assertionRepo.getById(options.replacedById)
      if (replacement && replacement.namespace !== existing.namespace) {
        throw new ValidationError([
          `replacedById "${options.replacedById}" is in namespace "${replacement.namespace}", not "${existing.namespace}". Cross-namespace supersession is not supported.`,
        ])
      }
    }
    this.assertionRepo.supersedeAssertion(assertionId, options.validUntil, options.replacedById ?? null)
  }

  writeLink(link: Omit<AssertionLink, 'createdAt'>): AssertionLink {
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

  indexAssertion(assertionId: string, embedding: Float32Array | number[]): void {
    this.requireInit()
    const assertion = this.assertionRepo.getById(assertionId)
    if (!assertion) throw new ValidationError([`Assertion "${assertionId}" not found`])
    const table = this.requireEmbeddingTable(assertion.namespace)
    this.embeddingRepo.insert(table, assertionId, embedding)
  }

  indexBatch(items: Array<{ assertionId: string; embedding: Float32Array | number[] }>): void {
    this.requireInit()
    // Group by namespace for efficiency
    const byTable = new Map<string, typeof items>()
    for (const item of items) {
      const assertion = this.assertionRepo.getById(item.assertionId)
      if (!assertion) continue
      const table = this.requireEmbeddingTable(assertion.namespace)
      const group = byTable.get(table) ?? []
      group.push(item)
      byTable.set(table, group)
    }
    for (const [table, batch] of byTable.entries()) {
      this.embeddingRepo.insertBatch(table, batch)
    }
  }

  getPendingIndexing(namespace: string): Array<{ id: string; content: string }> {
    this.requireNamespaceInit(namespace)
    const table = this.requireEmbeddingTable(namespace)
    return this.embeddingRepo.getPendingIndexing(table, namespace)
  }

  // ─── Retrieval ─────────────────────────────────────────────────────────────

  retrieve(query: RetrievalQuery): RetrievedAssertion[] {
    this.requireNamespaceInit(query.namespace)
    return retrieve(this.db, {
      assertionRepo: this.assertionRepo,
      embeddingRepo: this.embeddingRepo,
      getEmbeddingTable: (ns) => this.requireEmbeddingTable(ns),
      getPositionRange: (ns) => this.namespaceRepo.getPositionRange(ns),
      globalScorer: this.options.scorer,
      globalMiddleware: this.options.middleware,
      graphAdapter: this.options.graphAdapter,
    }, query)
  }

  assembleContext(options: ContextAssemblyOptions): AssembledContext {
    this.requireNamespaceInit(options.namespace)
    return assembleContext(this, {
      globalFormatter: this.options.defaultFormatter,
      ...options,
    })
  }

  // ─── Snapshot ──────────────────────────────────────────────────────────────

  getTemporalSnapshot(options: {
    namespace: string
    atPosition: number
    entityTypes?: string[]
    assertionTypes?: string[]
    includeSuperseded?: boolean
  }): Assertion[] {
    this.requireNamespaceInit(options.namespace)
    return getTemporalSnapshot(this.db, this.assertionRepo, options)
  }

  // ─── Graph ─────────────────────────────────────────────────────────────────

  getConnected(options: {
    namespace: string
    fromAssertionId: string
    maxDepth?: number
    linkTypes?: string[]
    temporalAnchor: number
  }): Assertion[] {
    this.requireNamespaceInit(options.namespace)
    return getConnected(this.db, this.assertionRepo, this.options.graphAdapter, options)
  }

  findPath(options: {
    namespace: string
    fromAssertionId: string
    toAssertionId: string
    maxDepth?: number
    temporalAnchor: number
  }): AssertionLink[] | null {
    this.requireNamespaceInit(options.namespace)
    return findPath(this.db, this.options.graphAdapter, options)
  }

  // ─── Utility ───────────────────────────────────────────────────────────────

  getAssertions(namespace: string, options?: {
    entityId?: string
    entityType?: string
    type?: string
    validAt?: number
    includeSuperseded?: boolean
  }): Assertion[] {
    this.requireNamespaceInit(namespace)
    return this.assertionRepo.query(namespace, options)
  }

  getEntityHistory(namespace: string, entityId: string): Assertion[] {
    this.requireNamespaceInit(namespace)
    return this.assertionRepo.getEntityHistory(namespace, entityId)
  }

  getEpisode(id: string): Episode | null {
    this.requireInit()
    return this.episodeRepo.getById(id)
  }

  deleteNamespace(namespace: string): void {
    this.requireInit()
    const refTables = (this.options.schemaExtensions.tables ?? []).filter((t) => t.referencesNamespace)
    if (refTables.length > 0) {
      structuredWarn('DELETE_NAMESPACE_HAS_REFERENCES', {
        namespace,
        referencingTables: refTables.map((t) => t.tableName).join(','),
      })
    }
    this.db.transaction(() => {
      const table = this.embeddingTableCache.get(namespace)
      if (table) this.db.exec(`DROP TABLE IF EXISTS ${table}`)
      this.db.prepare('DELETE FROM trl_links WHERE namespace = ?').run(namespace)
      this.db.prepare('DELETE FROM trl_assertions WHERE namespace = ?').run(namespace)
      this.db.prepare('DELETE FROM trl_episodes WHERE namespace = ?').run(namespace)
      this.db.prepare('DELETE FROM trl_namespaces WHERE namespace = ?').run(namespace)
      this.embeddingTableCache.delete(namespace)
    })()
  }

  async reindexNamespace(
    namespace: string,
    options: {
      newDimension: number
      embeddingProvider: (assertionId: string, content: string) => Promise<Float32Array>
    },
  ): Promise<void> {
    this.requireNamespaceInit(namespace)
    await doReindex(this.db, this.namespaceRepo, this.embeddingRepo, this.assertionRepo, namespace, options)
    // Re-warm embedding table cache
    const newTable = this.namespaceRepo.getEmbeddingTable(namespace)
    if (newTable) this.embeddingTableCache.set(namespace, newTable)
  }

  getStats(namespace: string): NamespaceStats {
    this.requireNamespaceInit(namespace)
    const assertionStats = this.assertionRepo.getStats(namespace)
    const episodeCount = (
      this.db
        .prepare<[string], { cnt: number }>('SELECT COUNT(*) AS cnt FROM trl_episodes WHERE namespace = ?')
        .get(namespace)
    )?.cnt ?? 0
    const table = this.requireEmbeddingTable(namespace)
    const indexedCount = this.embeddingRepo.getIndexedCount(table, namespace)
    const linkCount = this.linkRepo.getCount(namespace)
    const positionRange = this.namespaceRepo.getPositionRange(namespace)
    return {
      episodeCount,
      ...assertionStats,
      indexedCount,
      linkCount,
      positionRange,
    }
  }

  getMigrations(): readonly Migration[] {
    this.requireInit()
    return this.migrationRunner.getMigrations()
  }

  getCurrentSchemaVersion(): number {
    return new MigrationRunner().getCurrentVersion(this.db)
  }

  applyMigrations(): void {
    new MigrationRunner(this.options.fts5Tokenizer).applyMigrations(this.db)
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private requireInit(): void {
    if (!this.initialized) {
      throw new NamespaceNotInitializedError(this.options.namespace)
    }
  }

  private requireNamespaceInit(namespace: string): void {
    this.requireInit()
    if (!this.namespaceRepo.get(namespace)) {
      throw new NamespaceNotInitializedError(namespace)
    }
  }

  private getOrCacheEmbeddingTable(namespace: string): string {
    const cached = this.embeddingTableCache.get(namespace)
    if (cached) return cached
    const fromDb = this.namespaceRepo.getEmbeddingTable(namespace)
    if (fromDb) {
      this.embeddingTableCache.set(namespace, fromDb)
      return fromDb
    }
    // Namespace just created in this call — compute from hash
    const table = namespaceToEmbeddingTable(namespace)
    this.embeddingTableCache.set(namespace, table)
    return table
  }

  private requireEmbeddingTable(namespace: string): string {
    const table = this.getOrCacheEmbeddingTable(namespace)
    if (!table) throw new NamespaceNotInitializedError(namespace)
    return table
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
}
