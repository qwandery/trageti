/* eslint-disable @typescript-eslint/require-await */
import type { Database } from 'better-sqlite3'
import type {
  Episode,
  Assertion,
  AssertionLink,
  AssertionCitation,
  NewAssertionInput,
  NormalizedNewAssertion,
  NewLateCitation,
  NamespaceConfig,
  TemporalStoreOptions,
  CreateStoreOptions,
  NamespaceStats,
  MigrationDescriptor,
  RetrievalQuery,
  RetrievalResult,
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
  EmbeddingProvider,
  InitNamespaceOptions,
  UpgradeNamespaceToVectorOptions,
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
  EmbeddingProviderError,
  ReindexError,
  ErrorCode,
} from '../errors/index.js'
import { ConsoleLogger, setDefaultLogger, emitOnce, incr, observe } from '../internal/logger.js'
import { namespaceToEmbeddingTable } from '../internal/hash.js'
import { validateTokenizer } from '../internal/tokenizer.js'
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
  /** Process-local per-namespace embedding providers (never persisted). */
  private readonly namespaceProviders = new Map<string, EmbeddingProvider>()

  private initialized = false
  private closed = false

  static async create(options: CreateStoreOptions): Promise<TemporalStore> {
    const db = prepareDatabase(options.database, options.prepare)
    const store = new TemporalStore(db, options, {
      closeDatabaseOnStoreClose:
        options.closeDatabaseOnStoreClose ?? typeof options.database === 'string',
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
      fts5Tokenizer: options.fts5Tokenizer ?? {
        tokenizer: 'unicode61',
        tokenizerArgs: ['remove_diacritics', '1'],
      },
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
    const dimension =
      this.options.embeddingDimension ?? this.options.embeddingProvider?.dimension ?? null
    this.namespaceRepo.upsert(this.options.namespace, dimension)

    // (e) warm extension column cache
    this.warmExtensionCache()

    // Create repositories with extension column awareness
    this.episodeRepo = new EpisodeRepository(
      this.db,
      this.extensionColumnCache.get('trl_episodes') ?? [],
    )
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
      this.options.validators.push(
        new DefaultAssertionValidator(this.db, {
          logger: this.options.logger,
          requireCitationExcerpt: this.options.validation?.requireCitationExcerpt ?? false,
        }),
      )
    }

    this.initialized = true
  }

  /**
   * Register (or reopen) an additional namespace.
   *
   * On reopen of an existing vector-configured namespace, supplying a
   * mismatching `embeddingDimension` throws `NamespaceDimensionMismatchError`
   * (enforced in `NamespaceRepository.upsert`). Supplying no dimension is a
   * no-op — the stored dimension stays authoritative. A per-namespace
   * `embeddingProvider` is bound process-locally (never persisted).
   */
  async initNamespace(
    namespace: string,
    options: InitNamespaceOptions = {},
  ): Promise<NamespaceConfig> {
    this.requireInit()
    const dimension = options.embeddingDimension ?? options.embeddingProvider?.dimension ?? null
    this.namespaceRepo.upsert(namespace, dimension, options.config ?? {})
    if (options.embeddingProvider) {
      this.namespaceProviders.set(namespace, options.embeddingProvider)
    }
    const stored = this.namespaceRepo.get(namespace)
    if (!stored) throw new NamespaceNotInitializedError(namespace)
    return stored
  }

  /**
   * Resolve the embedding provider for a namespace: the per-namespace binding
   * if one was supplied to `initNamespace`/`upgradeNamespaceToVector`,
   * otherwise the store-level default. Providers are process-local.
   */
  getNamespaceProvider(namespace: string): EmbeddingProvider | null {
    return this.namespaceProviders.get(namespace) ?? this.options.embeddingProvider ?? null
  }

  // ─── Writing ───────────────────────────────────────────────────────────────

  async writeEpisode(episode: Omit<Episode, 'createdAt'>): Promise<Episode> {
    this.requireNamespaceInit(episode.namespace)
    const maxBytes = this.options.maxEpisodeContentBytes
    if (maxBytes > 0) {
      const byteLen = Buffer.byteLength(episode.content, 'utf8')
      if (byteLen > maxBytes) {
        this.options.logger.warn('TRGT_EPISODE_CONTENT_LARGE', {
          namespace: episode.namespace,
          byteLen,
          maxBytes,
        })
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

  async writeCitation(citation: NewLateCitation): Promise<AssertionCitation> {
    this.requireInit()
    const errors: string[] = []
    if (!citation.id || !citation.id.trim()) errors.push('citation.id is required')
    if (!citation.sourceRef || !citation.sourceRef.trim())
      errors.push('citation.sourceRef is required')

    const parent = this.assertionRepo.getById(citation.assertionId)
    if (!parent) {
      errors.push(
        `citation.assertionId "${citation.assertionId}" does not reference an existing assertion`,
      )
    } else {
      const ep = this.db
        .prepare<
          [string, string],
          { id: string }
        >('SELECT id FROM trl_episodes WHERE id = ? AND namespace = ?')
        .get(citation.episodeId, parent.namespace)
      if (!ep) {
        errors.push(
          `citation.episodeId "${citation.episodeId}" does not reference an episode in namespace "${parent.namespace}"`,
        )
      }
    }
    if (errors.length > 0) throw new ValidationError(errors)

    if (citation.excerpt === null) {
      if (this.options.validation?.requireCitationExcerpt) {
        throw new ValidationError([`citation "${citation.id}" excerpt is required`])
      }
      this.options.logger.warn('TRGT_CITATION_EXCERPT_MISSING', {
        assertionId: citation.assertionId,
        citationId: citation.id,
      })
    }
    return this.citationRepo.insertOne(citation)
  }

  /**
   * Advanced / escape-hatch operations. Not part of the primary v0.3 API —
   * use `writeAssertion({ supersedesId })` for the normal replace-an-assertion
   * flow. `closeAssertion()` exists only for the no-replacement case (e.g. a
   * data correction where the predecessor is simply wrong and nothing
   * supersedes it).
   */
  readonly advanced = {
    /**
     * Close an assertion's validity window with no replacement.
     * Emits `TRGT_DEPRECATED_USAGE` (once per process) — this is a narrow
     * escape hatch, not the standard supersession path.
     */
    closeAssertion: async (assertionId: string, options: { validUntil: number }): Promise<void> => {
      if (emitOnce('TRGT_DEPRECATED_USAGE:advanced.closeAssertion')) {
        this.options.logger.warn('TRGT_DEPRECATED_USAGE', {
          symbol: 'store.advanced.closeAssertion',
          guidance: 'For the normal replace flow use writeAssertion({ supersedesId }).',
        })
      }
      this.closeAssertionInternal(assertionId, options.validUntil)
    },
  }

  private closeAssertionInternal(assertionId: string, validUntil: number): void {
    this.requireInit()
    const existing = this.assertionRepo.getById(assertionId)
    if (!existing) throw new ValidationError([`Assertion "${assertionId}" not found`])
    if (existing.validUntil !== null) {
      throw new ValidationError([
        `Assertion "${assertionId}" is already closed (valid_until=${existing.validUntil}); cannot re-close. Mutating an established replacement chain is rejected (decision §2).`,
      ])
    }
    if (validUntil <= existing.validFrom) {
      throw new ValidationError([
        `validUntil must be strictly greater than validFrom (${existing.validFrom})`,
      ])
    }
    this.assertionRepo.supersedeAssertion(assertionId, validUntil)
  }

  async writeLink(link: Omit<AssertionLink, 'createdAt'>): Promise<AssertionLink> {
    this.requireNamespaceInit(link.namespace)
    // Warn once per cross-namespace link pair (spec §Future: permitted but flagged)
    const fromA = this.assertionRepo.getById(link.fromId)
    const toA = this.assertionRepo.getById(link.toId)
    if (fromA && toA && fromA.namespace !== toA.namespace) {
      this.options.logger.warn('TRGT_CROSS_NAMESPACE_LINK', {
        fromNs: fromA.namespace,
        toNs: toA.namespace,
      })
    }
    return this.linkRepo.insert(link)
  }

  // ─── Indexing ──────────────────────────────────────────────────────────────

  /** Length of an embedding, accepting either Float32Array or number[]. */
  private embeddingLength(e: Float32Array | number[]): number {
    return e.length
  }

  async indexAssertion(assertionId: string, embedding?: Float32Array | number[]): Promise<void> {
    this.requireInit()
    const assertion = this.assertionRepo.getById(assertionId)
    if (!assertion) {
      throw new IndexingError(
        ErrorCode.INDEXING_ASSERTION_NOT_FOUND,
        `Assertion "${assertionId}" not found`,
        { assertionId },
      )
    }
    const table = this.ensureVectorReady(assertion.namespace, 'indexing')
    const dim = this.namespaceRepo.get(assertion.namespace)?.embeddingDimension ?? null

    let vec: Float32Array | number[]
    if (embedding) {
      vec = embedding
    } else {
      if (!this.options.embeddingProvider) {
        throw new IndexingError(
          ErrorCode.INDEXING_NO_EMBEDDING_AND_NO_PROVIDER,
          `Cannot index "${assertionId}": no embedding supplied and no embedding provider configured`,
          { assertionId },
        )
      }
      const [computed] = await this.options.embeddingProvider.embed([assertion.content], {
        purpose: 'assertion',
      })
      if (!computed) {
        throw new IndexingError(
          ErrorCode.INDEXING_NO_EMBEDDING_AND_NO_PROVIDER,
          `Embedding provider returned no embedding for assertion "${assertionId}"`,
          { assertionId },
        )
      }
      vec = computed
    }

    if (dim !== null && this.embeddingLength(vec) !== dim) {
      throw new IndexingError(
        ErrorCode.INDEXING_EMBEDDING_DIMENSION_MISMATCH,
        `Embedding length ${String(this.embeddingLength(vec))} for "${assertionId}" does not match namespace dimension ${String(dim)}`,
        { assertionId },
      )
    }
    this.embeddingRepo.insert(table, assertionId, vec)
  }

  async indexBatch(
    items: IndexBatchItem[],
    options: IndexBatchOptions = {},
  ): Promise<IndexBatchResult> {
    this.requireInit()
    const mode = options.onProviderError ?? 'fail-fast'
    const provider = this.options.embeddingProvider

    // Skips are tracked with their input index so the returned skipped[]
    // preserves input order regardless of which resolution stage produced them.
    const skips: Array<{ index: number; entry: IndexBatchResult['skipped'][number] }> = []
    let indexed = 0

    type Pending = {
      index: number
      assertion: Assertion
      table: string
      dim: number | null
      needsProvider: boolean
      supplied?: Float32Array | number[]
    }
    const pending: Pending[] = []

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item) continue
      const assertion = this.assertionRepo.getById(item.assertionId)
      if (!assertion) {
        skips.push({
          index: i,
          entry: {
            assertionId: item.assertionId,
            reason: 'ASSERTION_NOT_FOUND',
            errorCode: 'ASSERTION_NOT_FOUND',
          },
        })
        continue
      }
      // Validate the namespace is vector-configured / sqlite-vec loaded.
      const table = this.ensureVectorReady(assertion.namespace, 'indexing')
      const dim = this.namespaceRepo.get(assertion.namespace)?.embeddingDimension ?? null

      if (item.embedding) {
        if (dim !== null && this.embeddingLength(item.embedding) !== dim) {
          skips.push({
            index: i,
            entry: {
              assertionId: item.assertionId,
              reason: 'EMBEDDING_DIMENSION_MISMATCH',
              errorCode: 'EMBEDDING_DIMENSION_MISMATCH',
            },
          })
          continue
        }
        pending.push({
          index: i,
          assertion,
          table,
          dim,
          needsProvider: false,
          supplied: item.embedding,
        })
      } else if (provider) {
        pending.push({ index: i, assertion, table, dim, needsProvider: true })
      } else {
        skips.push({
          index: i,
          entry: {
            assertionId: item.assertionId,
            reason: 'NO_EMBEDDING_AND_NO_PROVIDER',
            errorCode: 'NO_EMBEDDING_AND_NO_PROVIDER',
          },
        })
      }
    }

    const persist = (p: Pending, vec: Float32Array | number[]): void => {
      if (p.dim !== null && this.embeddingLength(vec) !== p.dim) {
        skips.push({
          index: p.index,
          entry: {
            assertionId: p.assertion.id,
            reason: 'EMBEDDING_DIMENSION_MISMATCH',
            errorCode: 'EMBEDDING_DIMENSION_MISMATCH',
          },
        })
        return
      }
      this.embeddingRepo.insert(p.table, p.assertion.id, vec)
      indexed++
    }

    // Caller-supplied embeddings persist immediately.
    for (const p of pending) {
      if (!p.needsProvider && p.supplied) persist(p, p.supplied)
    }

    // Provider-derived embeddings.
    const needsProvider = pending.filter((p) => p.needsProvider)
    if (needsProvider.length > 0 && provider) {
      if (mode === 'fail-fast') {
        // Embed and persist chunk-by-chunk so a mid-run provider failure
        // leaves EmbeddingProviderError.indexed reflecting rows actually
        // written to vec0.
        const batchSize = options.batchSize ?? 64
        try {
          for (let off = 0; off < needsProvider.length; off += batchSize) {
            if (options.signal?.aborted) {
              throw new EmbeddingProviderError(provider.name, indexed, 'aborted by signal')
            }
            const chunk = needsProvider.slice(off, off + batchSize)
            const opts: { purpose: 'assertion'; signal?: AbortSignal } = { purpose: 'assertion' }
            if (options.signal) opts.signal = options.signal
            const vecs = await provider.embed(
              chunk.map((p) => p.assertion.content),
              opts,
            )
            for (let k = 0; k < chunk.length; k++) {
              const vec = vecs[k]
              const c = chunk[k]
              if (!vec || !c) {
                throw new EmbeddingProviderError(
                  provider.name,
                  indexed,
                  `provider returned no vector for batch item ${String(k)}`,
                )
              }
              persist(c, vec)
            }
          }
        } catch (err) {
          if (err instanceof EmbeddingProviderError) throw err
          throw new EmbeddingProviderError(provider.name, indexed, err)
        }
      } else {
        // skip mode: embed one at a time; record failures in skipped[] with a
        // stable `reason` token and a sanitized `errorCode` — never the raw
        // provider message.
        for (const p of needsProvider) {
          if (options.signal?.aborted) {
            skips.push({
              index: p.index,
              entry: { assertionId: p.assertion.id, reason: 'ABORTED', errorCode: 'ABORTED' },
            })
            continue
          }
          try {
            const opts: { purpose: 'assertion'; signal?: AbortSignal } = { purpose: 'assertion' }
            if (options.signal) opts.signal = options.signal
            const [vec] = await provider.embed([p.assertion.content], opts)
            if (!vec) {
              skips.push({
                index: p.index,
                entry: {
                  assertionId: p.assertion.id,
                  reason: 'EMBEDDING_PROVIDER_ERROR',
                  errorCode: 'EMBEDDING_PROVIDER_EMPTY',
                },
              })
              continue
            }
            persist(p, vec)
          } catch {
            // The raw error is intentionally not surfaced — it may carry
            // assertion content or provider secrets.
            skips.push({
              index: p.index,
              entry: {
                assertionId: p.assertion.id,
                reason: 'EMBEDDING_PROVIDER_ERROR',
                errorCode: 'EMBEDDING_PROVIDER_ERROR',
              },
            })
          }
        }
      }
    }

    const skipped = skips.sort((a, b) => a.index - b.index).map((s) => s.entry)
    if (skipped.length > 0) {
      this.options.logger.warn('TRGT_INDEX_BATCH_SKIPPED', { count: skipped.length })
    }
    incr(this.options.metrics ?? undefined, 'trageti.indexBatch.indexed', { count: indexed })
    incr(this.options.metrics ?? undefined, 'trageti.indexBatch.skipped', { count: skipped.length })
    const providerFailures = skipped.filter(
      (s) => s.errorCode === 'EMBEDDING_PROVIDER_ERROR',
    ).length
    if (providerFailures > 0) {
      incr(this.options.metrics ?? undefined, 'trageti.embeddingProvider.failures', {
        count: providerFailures,
      })
    }
    return { indexed, skipped }
  }

  async getPendingIndexing(namespace: string): Promise<Array<{ id: string; content: string }>> {
    this.requireNamespaceInit(namespace)
    // getPendingIndexing does NOT route through ensureVectorReady: its result
    // is observable across the full (vectorless × vec0-exists × sqlite-vec)
    // matrix without throwing for the vectorless / vec0-not-yet-created cases.
    const config = this.namespaceRepo.get(namespace)
    const table = this.namespaceRepo.getEmbeddingTable(namespace)
    if (!config || config.embeddingDimension === null || !table) {
      // Vectorless namespace — nothing is ever pending vector indexing.
      this.options.logger.debug('TRGT_PENDING_INDEXING_VECTORLESS', { namespace })
      return []
    }
    if (!this.embeddingRepo.tableExists(table)) {
      // Vector-configured but the vec0 table has not been lazily created yet —
      // every active assertion is pending. This case does not touch vec0, so
      // it works whether or not sqlite-vec is loaded.
      return this.embeddingRepo.getAllActiveContent(namespace)
    }
    if (!this.isSqliteVecLoaded()) {
      // vec0 exists but the extension is not loaded — cannot introspect it.
      throw new MissingPeerDependencyError(
        'sqlite-vec',
        'npm install sqlite-vec',
        'load sqlite-vec to introspect indexing state for a vector namespace',
      )
    }
    return this.embeddingRepo.getPendingIndexing(table, namespace)
  }

  // ─── Retrieval ─────────────────────────────────────────────────────────────

  async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    this.requireNamespaceInit(query.namespace)
    // Step 0: routing. Resolve a provider-derived query embedding when the
    // caller gave queryText but no queryEmbedding, or record why the vector
    // branch is skipped under hybrid degradation.
    const { query: routed, skipReason } = await this.resolveQueryEmbedding(query)
    const result = retrieve(
      this.db,
      {
        assertionRepo: this.assertionRepo,
        embeddingRepo: this.embeddingRepo,
        getEmbeddingTable: (ns) => this.ensureVectorReady(ns, 'retrieval'),
        getPositionRange: (ns) => this.namespaceRepo.getPositionRange(ns),
        getDimension: (ns) => this.namespaceRepo.get(ns)?.embeddingDimension ?? null,
        globalScorer: this.options.scorer,
        globalMiddleware: this.options.middleware,
        graphAdapter: this.options.graphAdapter,
        logger: this.options.logger,
        metrics: this.options.metrics ?? null,
      },
      routed,
    )
    if (skipReason) {
      result.meta.warnings.push({
        code: 'TRGT_RETRIEVE_VECTOR_SKIPPED',
        message: `vector retrieval skipped: ${skipReason}`,
      })
    }
    return result
  }

  /**
   * Retrieval Step 0. When `queryText` is supplied without a `queryEmbedding`
   * and the strategy permits vector retrieval, derive a query embedding from
   * the configured provider. If the vector backend is unavailable, hybrid
   * degrades to BM25 (returning a skip reason); a `vector` strategy throws.
   */
  private async resolveQueryEmbedding(
    query: RetrievalQuery,
  ): Promise<{ query: RetrievalQuery; skipReason?: string }> {
    const strategy = query.retrievalStrategy ?? 'hybrid'
    const hasQueryText = typeof query.queryText === 'string' && query.queryText.trim().length > 0
    // Nothing to resolve: embedding already present, bm25-only, or no text.
    if (query.queryEmbedding || strategy === 'bm25' || !hasQueryText) {
      return { query }
    }

    const config = this.namespaceRepo.get(query.namespace)
    const vectorless = !config || config.embeddingDimension === null
    const provider = this.getNamespaceProvider(query.namespace)

    const degrade = (reason: string): { query: RetrievalQuery; skipReason: string } => {
      this.options.logger.info('TRGT_RETRIEVE_VECTOR_SKIPPED', {
        namespace: query.namespace,
        reason,
      })
      return { query, skipReason: reason }
    }

    if (vectorless) {
      if (strategy === 'vector') {
        throw new RetrievalInputError(
          ErrorCode.RETRIEVAL_NAMESPACE_VECTORLESS,
          `Namespace "${query.namespace}" is vectorless; retrievalStrategy 'vector' cannot apply`,
        )
      }
      return degrade('NAMESPACE_VECTORLESS')
    }
    if (!provider) {
      if (strategy === 'vector') {
        throw new RetrievalInputError(
          ErrorCode.RETRIEVAL_REQUIRES_VECTOR_INPUT,
          "retrievalStrategy 'vector' with queryText requires a configured EmbeddingProvider",
        )
      }
      return degrade('NO_PROVIDER')
    }
    if (!this.isSqliteVecLoaded()) {
      if (strategy === 'vector') {
        throw new MissingPeerDependencyError(
          'sqlite-vec',
          'npm install sqlite-vec',
          "use retrievalStrategy: 'bm25'",
        )
      }
      return degrade('NO_SQLITE_VEC')
    }

    const embedOpts: { purpose: 'query'; signal?: AbortSignal } = { purpose: 'query' }
    if (query.signal) embedOpts.signal = query.signal
    const [vec] = await provider.embed([query.queryText as string], embedOpts)
    if (!vec) {
      if (strategy === 'vector') {
        throw new EmbeddingProviderError(provider.name, 0, 'provider returned no query embedding')
      }
      return degrade('NO_PROVIDER')
    }
    return { query: { ...query, queryEmbedding: vec } }
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

  async getAssertions(
    namespace: string,
    options?: {
      entityId?: string
      entityType?: string
      type?: string
      validAt?: number
      includeSuperseded?: boolean
    },
  ): Promise<Assertion[]> {
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
    const refTables = (this.options.schemaExtensions.tables ?? []).filter(
      (t) => t.referencesNamespace,
    )
    if (refTables.length > 0) {
      if (!options.cascade) {
        throw new ReferencedExtensionTableError(
          namespace,
          refTables.map((table) => table.tableName),
        )
      }
    }
    this.db.transaction(() => {
      for (const table of refTables) {
        if (!table.namespaceColumn) continue
        this.db
          .prepare(
            `DELETE FROM ${quoteIdent(table.tableName)} WHERE ${quoteIdent(table.namespaceColumn)} = ?`,
          )
          .run(namespace)
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
    options: ReindexOptions & { embeddingProvider?: EmbeddingProvider } = {},
  ): Promise<ReindexResult> {
    this.requireNamespaceInit(namespace)
    const provider = options.embeddingProvider ?? this.options.embeddingProvider
    if (!provider) {
      throw new ReindexError(
        namespace,
        0,
        'reindexNamespace requires an embeddingProvider (none supplied and none configured on the store)',
      )
    }
    const result = await doReindex(this.db, this.namespaceRepo, this.embeddingRepo, namespace, {
      ...options,
      embeddingProvider: provider,
    })
    // The embedding_table was repointed by the staging swap — refresh the cache.
    const newTable = this.namespaceRepo.getEmbeddingTable(namespace)
    if (newTable) this.embeddingTableCache.set(namespace, newTable)
    observe(this.options.metrics ?? undefined, 'trageti.reindex.tookMs', result.durationMs)
    return result
  }

  async getStats(namespace: string): Promise<NamespaceStats> {
    this.requireNamespaceInit(namespace)
    const assertionStats = this.assertionRepo.getStats(namespace)
    const episodeCount =
      this.db
        .prepare<
          [string],
          { cnt: number }
        >('SELECT COUNT(*) AS cnt FROM trl_episodes WHERE namespace = ?')
        .get(namespace)?.cnt ?? 0
    const ns = this.namespaceRepo.get(namespace)
    const table = this.namespaceRepo.getEmbeddingTable(namespace)
    const vectorReady = Boolean(
      table && this.isSqliteVecLoaded() && this.embeddingRepo.tableExists(table),
    )
    const indexedCount =
      vectorReady && table ? this.embeddingRepo.getIndexedCount(table, namespace) : 0
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
    this.requireNotClosed('getCurrentSchemaVersion')
    return new MigrationRunner().getCurrentVersion(this.db)
  }

  /**
   * Re-run the migration runner. Non-spec public surface, intentionally
   * retained for advanced/operational use; guarded by the open-state check
   * like every other public method.
   */
  async applyMigrations(): Promise<void> {
    this.requireNotClosed('applyMigrations')
    new MigrationRunner(this.options.fts5Tokenizer).applyMigrations(this.db)
  }

  async rebuildFts(options: RebuildFtsOptions = {}): Promise<RebuildFtsResult> {
    this.requireInit()
    const started = Date.now()
    const tokenizer = options.tokenizer ?? this.options.fts5Tokenizer
    // Reject an unsafe/unsupported tokenizer before generating any DDL.
    validateTokenizer(tokenizer)
    const tokenizeArg = [tokenizer.tokenizer, ...(tokenizer.tokenizerArgs ?? [])].join(' ')
    const batchSize = options.batchSize ?? 1000

    // Drop and recreate trl_fts inside a single write transaction, then
    // repopulate while preserving the rowid invariant (trl_fts.rowid ===
    // trl_assertions.rowid) so BM25 joins continue to work.
    let reindexed = 0
    this.db.transaction(() => {
      this.db.exec('DROP TABLE IF EXISTS trl_fts')
      this.db.exec(`
        CREATE VIRTUAL TABLE trl_fts USING fts5(
          assertion_id UNINDEXED,
          content,
          content='trl_assertions',
          content_rowid='rowid',
          tokenize='${tokenizeArg}'
        );
      `)
      const insert = this.db.prepare(
        'INSERT INTO trl_fts(rowid, assertion_id, content) SELECT rowid, id, content FROM trl_assertions WHERE rowid > ? AND rowid <= ?',
      )
      const maxRow = this.db
        .prepare<[], { m: number | null }>('SELECT MAX(rowid) AS m FROM trl_assertions')
        .get()
      const max = maxRow?.m ?? 0
      for (let start = 0; start < max; start += batchSize) {
        if (options.signal?.aborted) throw new ValidationError(['rebuildFts aborted by signal'])
        const end = Math.min(start + batchSize, max)
        const info = insert.run(start, end)
        reindexed += info.changes
      }
      // Update trl_fts_meta with the active tokenizer config.
      this.db
        .prepare(
          `INSERT INTO trl_fts_meta (id, tokenizer, tokenizer_args, updated_at)
           VALUES (1, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET tokenizer = excluded.tokenizer,
                                         tokenizer_args = excluded.tokenizer_args,
                                         updated_at = excluded.updated_at`,
        )
        .run(tokenizer.tokenizer, JSON.stringify(tokenizer.tokenizerArgs ?? []))
    })()

    return { reindexedRows: reindexed, newTokenizer: tokenizer, durationMs: Date.now() - started }
  }

  async upgradeNamespaceToVector(
    namespace: string,
    options: UpgradeNamespaceToVectorOptions,
  ): Promise<void> {
    this.requireNamespaceInit(namespace)
    const existing = this.namespaceRepo.get(namespace)
    if (existing && existing.embeddingDimension !== null) {
      throw new ValidationError([
        `Namespace "${namespace}" is already vector-configured (dimension ${String(existing.embeddingDimension)}). ` +
          'Use reindexNamespace() to change the dimension.',
      ])
    }
    const table = namespaceToEmbeddingTable(namespace)
    this.db.transaction(() => {
      this.namespaceRepo.updateEmbeddingDimension(namespace, options.embeddingDimension, table)
      this.embeddingTableCache.set(namespace, table)
    })()
    if (options.embeddingProvider) {
      this.namespaceProviders.set(namespace, options.embeddingProvider)
    }
    this.options.logger.info('TRGT_NAMESPACE_VECTOR_UPGRADED', {
      namespace,
      embeddingDimension: options.embeddingDimension,
    })
  }

  /**
   * Non-executing retrieval planning introspection. Reports the strategy,
   * the per-step plan, and whether each branch would actually run — without
   * touching the assertion/embedding data.
   *
   * Note: the provider-derived case (queryText + configured provider, no
   * queryEmbedding) is finalized in R3 (hybrid Step-0 routing). At present
   * `wouldApplyVector` is accurate for the supplied-`queryEmbedding` and
   * `bm25`-strategy cases and conservative otherwise.
   */
  async explain(query: RetrievalQuery): Promise<RetrievalExplainResult> {
    this.requireNamespaceInit(query.namespace)
    const strategy = query.retrievalStrategy ?? 'hybrid'
    const config = this.namespaceRepo.get(query.namespace)
    const table = this.namespaceRepo.getEmbeddingTable(query.namespace)
    const vectorReady = Boolean(
      table && this.isSqliteVecLoaded() && this.embeddingRepo.tableExists(table),
    )
    const hasQueryText = typeof query.queryText === 'string' && query.queryText.trim().length > 0
    const hasQueryEmbedding = Boolean(query.queryEmbedding)
    const notes: string[] = []

    const wouldApplyVector =
      strategy !== 'bm25' && hasQueryEmbedding && config?.embeddingDimension !== null
    const wouldApplyBm25 = strategy !== 'vector' && hasQueryText

    if (strategy !== 'bm25' && hasQueryEmbedding && config?.embeddingDimension === null) {
      notes.push('namespace is vectorless — vector retrieval cannot apply')
    }
    if (strategy !== 'bm25' && !hasQueryEmbedding) {
      notes.push(
        'no queryEmbedding supplied — provider-derived embedding is resolved at retrieve time (R3)',
      )
    }

    const steps: RetrievalExplainResult['steps'] = [
      { step: 'temporal-filter', notes: ['filters trl_assertions by namespace + temporal anchor'] },
    ]
    if (wouldApplyVector) {
      steps.push({
        step: 'vector',
        vectorReady,
        sql: 'vec_distance_cosine over the namespace vec0 table',
      })
    }
    if (wouldApplyBm25) {
      steps.push({ step: 'bm25', sql: 'bm25(trl_fts) over the FTS5 index' })
    }
    steps.push({ step: 'score' }, { step: 'rank' })

    return { query, retrievalStrategy: strategy, steps, wouldApplyVector, wouldApplyBm25, notes }
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
  private enforceStructuralInvariants(assertion: NormalizedNewAssertion): void {
    const errors: string[] = []

    // Citation presence + per-citation fields
    if (!Array.isArray(assertion.citations) || assertion.citations.length === 0) {
      errors.push('citations array is required and must contain at least one entry')
    } else {
      for (const cit of assertion.citations) {
        if (!cit.id || !cit.id.trim()) errors.push('citation.id is required')
        if (!cit.sourceRef || !cit.sourceRef.trim())
          errors.push(`citation "${cit.id}" sourceRef is required`)
        if (!cit.episodeId || !cit.episodeId.trim()) {
          errors.push(`citation "${cit.id}" episodeId is required`)
        } else {
          const ep = this.db
            .prepare<
              [string, string],
              { id: string }
            >('SELECT id FROM trl_episodes WHERE id = ? AND namespace = ?')
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
        errors.push(
          `supersedesId "${assertion.supersedesId}" does not reference an existing assertion`,
        )
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
        kind === 'retrieval'
          ? "use retrievalStrategy: 'bm25'"
          : 'load sqlite-vec or use vectorless namespaces',
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
