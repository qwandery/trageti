/*
 * eslint-disable @typescript-eslint/require-await --
 * v0.3 public API contract: every TragetiStore method is `async` for a
 * uniform Promise-returning surface, even where the body is currently
 * synchronous (repositories and DB calls are sync internally). The
 * require-await rule is therefore disabled file-wide *by design* for this
 * one file — it is not masking missing awaits; the all-async surface is
 * intentional. Genuinely async work (provider.embed in indexAssertion/
 * indexBatch/reindex/retrieve) does use await.
 */
/* eslint-disable @typescript-eslint/require-await */
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  Episode,
  Assertion,
  AssertionLink,
  AssertionCitation,
  NewAssertionInput,
  NewEpisodeInput,
  NewEpisodeBundleInput,
  EpisodeBundleWriteResult,
  NewAssertionLinkInput,
  NormalizedNewAssertion,
  NewLateCitation,
  NamespaceConfig,
  TragetiStoreOptions,
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
  FTS5TokenizerConfig,
  RetrievalExplainResult,
  EmbeddingProvider,
  InitNamespaceOptions,
  UpgradeNamespaceToVectorOptions,
  TraversalOptions,
  PathOptions,
  TemporalSnapshotOptions,
  IndexingStateOptions,
} from '../domain/types.js';
import { MigrationRunner } from '../db/migrations/runner.js';
import { SchemaExtensionApplier } from '../db/schema/extensions.js';
import { NamespaceRepository } from '../db/repositories/NamespaceRepository.js';
import { EpisodeRepository } from '../db/repositories/EpisodeRepository.js';
import { AssertionRepository } from '../db/repositories/AssertionRepository.js';
import { CitationRepository } from '../db/repositories/CitationRepository.js';
import { LinkRepository } from '../db/repositories/LinkRepository.js';
import { EmbeddingRepository } from '../db/repositories/EmbeddingRepository.js';
import { buildCandidateJson } from '../db/candidates.js';
import { DefaultConnectionVerifier } from '../defaults/connection/DefaultConnectionVerifier.js';
import { DefaultAssertionValidator } from '../defaults/validation/DefaultAssertionValidator.js';
import { CTEGraphAdapter } from '../defaults/graph/CTEGraphAdapter.js';
import { RRFScorer } from '../defaults/scoring/RRFScorer.js';
import { ProseFormatter } from '../defaults/formatting/ProseFormatter.js';
import {
  NamespaceNotInitializedError,
  NamespaceDimensionMismatchError,
  StoreClosedError,
  ValidationError,
  IndexingError,
  MissingPeerDependencyError,
  ReferencedExtensionTableError,
  RetrievalInputError,
  EmbeddingProviderError,
  ReindexError,
  MigrationCompatibilityError,
  TragetiError,
  ErrorCode,
  errorCodeOf,
} from '../errors/index.js';
import { ConsoleLogger, emitOnce, incr, observe } from '../internal/logger.js';
import { namespaceToEmbeddingTable } from '../internal/hash.js';
import { validateTokenizer } from '../internal/tokenizer.js';
import { quoteIdent } from '../internal/sql-ident.js';
import { vectorValidationError } from '../internal/vector.js';
import {
  finiteNumberError,
  literalOptionError,
  positiveIntegerOptionError,
  stringArrayOptionError,
} from '../internal/validate.js';
import { prepareDatabase } from '../defaults/connection/prepareDatabase.js';
import { retrieve, validateRetrievalQuery } from '../pipeline/retrieve.js';
import { applyBeforeHooks } from '../pipeline/middleware.js';
import { assembleContext } from '../pipeline/assemble.js';
import { getTemporalSnapshot } from '../pipeline/snapshot.js';
import { getConnected, findPath } from '../pipeline/graph.js';
import { reindexNamespace as doReindex } from '../pipeline/reindex.js';

const DEFAULT_MAX_EPISODE_CONTENT_BYTES = 8192;
const NAMESPACE_LOCK_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Throws `ValidationError` unless `dimension` is a positive integer. Shared by
 * namespace registration (`resolveVectorDimension`) and `reindexNamespace`
 * (`newDimension`) so an invalid dimension fails before any vec0 DDL.
 */
function assertValidDimension(namespace: string, dimension: number): void {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new ValidationError([
      `Namespace "${namespace}": embedding dimension must be a positive integer, got ${String(dimension)}`,
    ]);
  }
}

function vectorErrorCode(message: string): string {
  return message.includes(' length ') ? 'EMBEDDING_DIMENSION_MISMATCH' : 'EMBEDDING_INVALID';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates an episode's identity and numeric fields before any SQLite write,
 * so malformed input fails with a typed `ValidationError` rather than a raw
 * constraint error: non-empty `id`, finite `position`. `occurredAt` / `type` /
 * `content` are opaque payload — the library does not constrain their values
 * (an empty `occurredAt` is an accepted "no audit timestamp" sentinel).
 */
function validateEpisodeInput(episode: NewEpisodeInput): void {
  const errors: string[] = [];
  if (!isNonEmptyString(episode.id)) errors.push('episode.id is required');
  if (!Number.isFinite(episode.position))
    errors.push(`episode.position must be a finite number, got ${String(episode.position)}`);
  if (errors.length > 0) throw new ValidationError(errors, 'Episode');
}

/**
 * Validates a link's identity, reference, and numeric fields before any SQLite
 * write: non-empty `id` / `fromId` / `toId` / `sourceEpisodeId` (a blank
 * reference would otherwise surface as a raw foreign-key error); finite
 * `validFrom`; `validUntil` either null or finite. `linkType` is opaque,
 * caller-defined payload and is not constrained.
 */
function validateLinkInput(link: NewAssertionLinkInput): void {
  const errors: string[] = [];
  validateLinkFields(link, errors);
  if (errors.length > 0) throw new ValidationError(errors, 'Link');
}

function validateLinkFields(link: NewAssertionLinkInput, errors: string[]): void {
  if (!isNonEmptyString(link.id)) errors.push('link.id is required');
  if (!isNonEmptyString(link.fromId)) errors.push('link.fromId is required');
  if (!isNonEmptyString(link.toId)) errors.push('link.toId is required');
  if (!isNonEmptyString(link.sourceEpisodeId)) errors.push('link.sourceEpisodeId is required');
  if (!Number.isFinite(link.validFrom))
    errors.push(`link.validFrom must be a finite number, got ${String(link.validFrom)}`);
  if (link.validUntil !== null && !Number.isFinite(link.validUntil))
    errors.push(`link.validUntil must be null or a finite number, got ${String(link.validUntil)}`);
  if (link.validUntil !== null && Number.isFinite(link.validUntil) && link.validUntil <= link.validFrom)
    errors.push('link.validUntil must be greater than link.validFrom');
}

function buildFtsTokenizeArg(tokenizer: FTS5TokenizerConfig): string {
  validateTokenizer(tokenizer, 'rebuild');
  return [tokenizer.tokenizer, ...(tokenizer.tokenizerArgs ?? [])].join(' ');
}

export class TragetiStore {
  private readonly db: Database;
  private readonly options: TragetiStoreOptions & {
    graphAdapter: NonNullable<TragetiStoreOptions['graphAdapter']>;
    scorer: NonNullable<TragetiStoreOptions['scorer']>;
    defaultFormatter: NonNullable<TragetiStoreOptions['defaultFormatter']>;
    validators: NonNullable<TragetiStoreOptions['validators']>;
    connectionVerifier: NonNullable<TragetiStoreOptions['connectionVerifier']>;
    middleware: NonNullable<TragetiStoreOptions['middleware']>;
    fts5Tokenizer: NonNullable<TragetiStoreOptions['fts5Tokenizer']>;
    schemaExtensions: NonNullable<TragetiStoreOptions['schemaExtensions']>;
    maxEpisodeContentBytes: number;
    logger: NonNullable<TragetiStoreOptions['logger']>;
  };
  private readonly closeDatabaseOnStoreClose: boolean;
  /** Whether the caller explicitly supplied `fts5Tokenizer` (vs the default). */
  private readonly fts5TokenizerExplicit: boolean;

  private migrationRunner!: MigrationRunner;
  private extensionApplier!: SchemaExtensionApplier;
  private namespaceRepo!: NamespaceRepository;
  private episodeRepo!: EpisodeRepository;
  private assertionRepo!: AssertionRepository;
  private citationRepo!: CitationRepository;
  private linkRepo!: LinkRepository;
  private embeddingRepo!: EmbeddingRepository;

  /** Cache: table → extension column names (for extensions bag) */
  private extensionColumnCache = new Map<string, string[]>();
  /** Process-local per-namespace embedding providers (never persisted). */
  private readonly namespaceProviders = new Map<string, EmbeddingProvider>();

  private initialized = false;
  private closed = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private inFlightOperations = 0;
  private readonly inFlightWaiters: Array<() => void> = [];
  private sqliteVecLoaded: boolean | null = null;

  static async create(options: CreateStoreOptions): Promise<TragetiStore> {
    const db = prepareDatabase(options.database, options.prepare);
    const store = new TragetiStore(db, options, {
      closeDatabaseOnStoreClose: options.closeDatabaseOnStoreClose ?? typeof options.database === 'string',
    });
    await store.init();
    return store;
  }

  constructor(db: Database, options: TragetiStoreOptions, internal: { closeDatabaseOnStoreClose?: boolean } = {}) {
    this.db = db;
    this.options = {
      graphAdapter: options.graphAdapter ?? new CTEGraphAdapter(),
      scorer: options.scorer ?? new RRFScorer(),
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
    } as typeof this.options;
    this.closeDatabaseOnStoreClose = internal.closeDatabaseOnStoreClose ?? false;
    this.fts5TokenizerExplicit = options.fts5Tokenizer !== undefined;
  }

  async init(): Promise<void> {
    this.requireNotClosed('init');
    // (a) connection verification
    this.options.connectionVerifier.verify(this.db, this.options.logger);

    // (b) migrations
    this.migrationRunner = new MigrationRunner(this.options.fts5Tokenizer);
    this.migrationRunner.applyMigrations(this.db);

    // (b2) reconcile an explicitly-supplied tokenizer against the stored one
    this.reconcileFtsTokenizer();

    // (c) schema extensions validate + apply
    this.extensionApplier = new SchemaExtensionApplier();
    this.extensionApplier.validate(this.options.schemaExtensions);
    this.extensionApplier.apply(this.db, this.options.schemaExtensions);

    // (d) namespace registration
    this.namespaceRepo = new NamespaceRepository(this.db);
    const dimension = this.resolveVectorDimension(
      this.options.namespace,
      this.options.embeddingDimension,
      this.options.embeddingProvider,
    );
    this.namespaceRepo.upsert(this.options.namespace, dimension);

    // (e) warm extension column cache
    this.warmExtensionCache();

    // Create repositories with extension column awareness
    this.episodeRepo = new EpisodeRepository(this.db, this.extensionColumnCache.get('trageti_episodes') ?? []);
    this.citationRepo = new CitationRepository(this.db);
    this.assertionRepo = new AssertionRepository(
      this.db,
      this.citationRepo,
      this.extensionColumnCache.get('trageti_assertions') ?? [],
    );
    this.linkRepo = new LinkRepository(this.db, this.extensionColumnCache.get('trageti_links') ?? []);
    this.embeddingRepo = new EmbeddingRepository(this.db);

    // Add default validators if none provided. The store owns citation-excerpt
    // policy (enforced in writeAssertion, so a custom validators array cannot
    // bypass it), so the auto-installed validator skips its excerpt block to
    // avoid a double warning/error.
    if (this.options.validators.length === 0) {
      this.options.validators.push(
        new DefaultAssertionValidator(this.db, {
          logger: this.options.logger,
          enforceCitationExcerptPolicy: false,
        }),
      );
    }

    this.initialized = true;
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
  async initNamespace(namespace: string, options: InitNamespaceOptions = {}): Promise<NamespaceConfig> {
    this.requireInit();
    const dimension = this.resolveVectorDimension(namespace, options.embeddingDimension, options.embeddingProvider);
    this.namespaceRepo.upsert(namespace, dimension, options.config);
    if (options.embeddingProvider) {
      this.namespaceProviders.set(namespace, options.embeddingProvider);
    }
    const stored = this.namespaceRepo.get(namespace);
    if (!stored) throw new NamespaceNotInitializedError(namespace);
    return stored;
  }

  /**
   * Resolve and validate the embedding dimension for a namespace from the
   * caller-supplied `embeddingDimension` and/or `embeddingProvider`:
   *   - neither supplied → `null` (vectorless)
   *   - both supplied → they MUST agree, else `NamespaceDimensionMismatchError`
   *   - either alone → that value
   * A non-null resolved dimension MUST be a positive integer.
   */
  private resolveVectorDimension(
    namespace: string,
    embeddingDimension: number | undefined,
    embeddingProvider: EmbeddingProvider | undefined,
  ): number | null {
    const explicit = embeddingDimension ?? null;
    const fromProvider = embeddingProvider ? embeddingProvider.dimension : null;
    if (explicit !== null && fromProvider !== null && explicit !== fromProvider) {
      throw new NamespaceDimensionMismatchError(namespace, explicit, fromProvider);
    }
    const resolved = explicit ?? fromProvider;
    if (resolved === null) return null;
    assertValidDimension(namespace, resolved);
    return resolved;
  }

  /**
   * Resolve the embedding provider for a namespace: the per-namespace binding
   * if one was supplied to `initNamespace`/`upgradeNamespaceToVector`,
   * otherwise the store-level default. Providers are process-local.
   */
  getNamespaceProvider(namespace: string): EmbeddingProvider | null {
    return this.namespaceProviders.get(namespace) ?? this.options.embeddingProvider ?? null;
  }

  // ─── Writing ───────────────────────────────────────────────────────────────

  async writeEpisode(episode: NewEpisodeInput): Promise<Episode> {
    this.requireNamespaceInit(episode.namespace);
    this.requireNamespaceUnlocked(episode.namespace, 'writeEpisode');
    validateEpisodeInput(episode);
    const maxBytes = this.options.maxEpisodeContentBytes;
    if (maxBytes > 0) {
      const byteLen = Buffer.byteLength(episode.content, 'utf8');
      if (byteLen > maxBytes) {
        this.options.logger.warn('TRGT_EPISODE_CONTENT_LARGE', {
          namespace: episode.namespace,
          byteLen,
          maxBytes,
        });
      }
    }
    return this.episodeRepo.insert(episode);
  }

  async writeEpisodeBundle(input: NewEpisodeBundleInput): Promise<EpisodeBundleWriteResult> {
    this.requireNamespaceInit(input.episode.namespace);
    this.requireNamespaceUnlocked(input.episode.namespace, 'writeEpisodeBundle');
    validateEpisodeInput(input.episode);
    const assertions = input.assertions.map((assertion) => this.normalizeAssertionInput(assertion));
    const links = input.links ?? [];

    const assertionIds = new Set<string>();
    const citationIds = new Set<string>();
    const claimedPredecessors = new Set<string>();
    const errors: string[] = [];
    const inFlightEpisodeIds = new Set([input.episode.id]);
    for (const assertion of assertions) {
      if (assertion.namespace !== input.episode.namespace) {
        errors.push(`assertion "${assertion.id}" namespace must match episode namespace "${input.episode.namespace}"`);
      }
      if (assertion.sourceEpisodeId !== input.episode.id) {
        errors.push(`assertion "${assertion.id}" sourceEpisodeId must be "${input.episode.id}"`);
      }
      if (assertionIds.has(assertion.id)) errors.push(`duplicate assertion id "${assertion.id}" in episode bundle`);
      assertionIds.add(assertion.id);
      if (assertion.supersedesId !== null) {
        if (claimedPredecessors.has(assertion.supersedesId)) {
          errors.push(`duplicate supersedesId "${assertion.supersedesId}" in episode bundle`);
        }
        claimedPredecessors.add(assertion.supersedesId);
      }
      for (const citation of assertion.citations) {
        if (citationIds.has(citation.id)) errors.push(`duplicate citation id "${citation.id}" in episode bundle`);
        citationIds.add(citation.id);
      }
      this.validateAssertionForWrite(assertion, {
        inFlightEpisodeIds,
        collectErrors: errors,
        errorPrefix: `assertion "${assertion.id}": `,
      });
    }

    const linkIds = new Set<string>();
    for (const link of links) {
      if (linkIds.has(link.id)) errors.push(`duplicate link id "${link.id}" in episode bundle`);
      linkIds.add(link.id);
      if (link.namespace !== input.episode.namespace) {
        errors.push(`link "${link.id}" namespace must match episode namespace "${input.episode.namespace}"`);
      }
      if (link.sourceEpisodeId !== input.episode.id) {
        errors.push(`link "${link.id}" sourceEpisodeId must be "${input.episode.id}"`);
      }
      validateLinkFields(link, errors);
      this.validateLinkReferences(link, errors, { inFlightAssertionIds: assertionIds, inFlightEpisodeIds });
    }

    if (errors.length > 0) throw new ValidationError(errors, 'EpisodeBundle');

    return this.db.transaction(() => {
      const episode = this.episodeRepo.insert(input.episode);
      const storedAssertions: Assertion[] = [];
      for (const assertion of assertions) {
        this.assertionRepo.insert(assertion);
        const citations = this.citationRepo.insertMany(assertion.id, assertion.citations);
        if (assertion.supersedesId !== null) {
          this.closeSupersededAssertion(assertion.supersedesId, assertion.validFrom);
        }
        const inserted = this.assertionRepo.getById(assertion.id);
        if (!inserted) {
          throw new TragetiError(ErrorCode.INTERNAL_INVARIANT, `Assertion "${assertion.id}" not found after insert`);
        }
        storedAssertions.push({ ...inserted, citations });
      }
      const storedLinks = links.map((link) => this.linkRepo.insert(link));
      return { episode, assertions: storedAssertions, links: storedLinks };
    })();
  }

  async writeAssertion(input: NewAssertionInput): Promise<Assertion> {
    const assertion = this.normalizeAssertionInput(input);
    this.requireNamespaceInit(assertion.namespace);
    this.requireNamespaceUnlocked(assertion.namespace, 'writeAssertion');

    // ─── Structural invariants (decision §2) ─────────────────────────────────
    // Enforced here, NOT in DefaultAssertionValidator — replacing the validators
    // array does not bypass these. Configured validators run *after* and only if
    // structural checks pass; this avoids duplicate error messages on the same
    // field.
    this.validateAssertionForWrite(assertion);

    // ─── Atomic write ───────────────────────────────────────────────────────
    return this.db.transaction(() => {
      this.assertionRepo.insert(assertion);
      const citations = this.citationRepo.insertMany(assertion.id, assertion.citations);
      if (assertion.supersedesId !== null) {
        this.closeSupersededAssertion(assertion.supersedesId, assertion.validFrom);
      }
      const inserted = this.assertionRepo.getById(assertion.id);
      if (!inserted) {
        throw new TragetiError(ErrorCode.INTERNAL_INVARIANT, `Assertion "${assertion.id}" not found after insert`);
      }
      // getById already populates citations; pass through without re-fetching
      return { ...inserted, citations };
    })();
  }

  async writeCitation(citation: NewLateCitation): Promise<AssertionCitation> {
    this.requireInit();
    const errors: string[] = [];
    if (!isNonEmptyString(citation.id)) errors.push('citation.id is required');
    if (!isNonEmptyString(citation.sourceRef)) errors.push('citation.sourceRef is required');

    const parent = this.assertionRepo.getById(citation.assertionId);
    if (!parent) {
      errors.push(`citation.assertionId "${citation.assertionId}" does not reference an existing assertion`);
    } else {
      this.requireNamespaceUnlocked(parent.namespace, 'writeCitation');
      const ep = this.db
        .prepare<[string, string], { id: string }>('SELECT id FROM trageti_episodes WHERE id = ? AND namespace = ?')
        .get(citation.episodeId, parent.namespace);
      if (!ep) {
        errors.push(
          `citation.episodeId "${citation.episodeId}" does not reference an episode in namespace "${parent.namespace}"`,
        );
      }
    }
    if (errors.length > 0) throw new ValidationError(errors, 'Citation');

    if (citation.excerpt === null) {
      if (this.options.validation?.requireCitationExcerpt) {
        throw new ValidationError([`citation "${citation.id}" excerpt is required`], 'Citation');
      }
      this.options.logger.warn('TRGT_CITATION_EXCERPT_MISSING', {
        assertionId: citation.assertionId,
        citationId: citation.id,
      });
    }
    return this.citationRepo.insertOne(citation);
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
        });
      }
      this.closeAssertionInternal(assertionId, options.validUntil);
    },
  };

  private closeAssertionInternal(assertionId: string, validUntil: number): void {
    this.requireInit();
    if (!Number.isFinite(validUntil)) {
      throw new ValidationError([`validUntil must be a finite number, got ${String(validUntil)}`], 'Assertion');
    }
    const existing = this.assertionRepo.getById(assertionId);
    if (!existing) throw new ValidationError([`Assertion "${assertionId}" not found`], 'Assertion');
    if (existing.validUntil !== null) {
      throw new ValidationError(
        [
          `Assertion "${assertionId}" is already closed (valid_until=${existing.validUntil}); cannot re-close. Mutating an established replacement chain is rejected (decision §2).`,
        ],
        'Assertion',
      );
    }
    if (validUntil <= existing.validFrom) {
      throw new ValidationError(
        [`validUntil must be strictly greater than validFrom (${existing.validFrom})`],
        'Assertion',
      );
    }
    this.closeSupersededAssertion(assertionId, validUntil);
  }

  async writeLink(link: NewAssertionLinkInput): Promise<AssertionLink> {
    this.requireNamespaceInit(link.namespace);
    this.requireNamespaceUnlocked(link.namespace, 'writeLink');
    validateLinkInput(link);
    const linkErrors: string[] = [];
    this.validateLinkReferences(link, linkErrors);
    if (linkErrors.length > 0) throw new ValidationError(linkErrors, 'Link');
    return this.linkRepo.insert(link);
  }

  // ─── Indexing ──────────────────────────────────────────────────────────────

  async indexAssertion(assertionId: string, embedding?: Float32Array | number[]): Promise<void> {
    return this.trackOperation('indexAssertion', async () => {
      this.requireInit();
      const assertion = this.assertionRepo.getById(assertionId);
      if (!assertion) {
        throw new IndexingError(ErrorCode.INDEXING_ASSERTION_NOT_FOUND, `Assertion "${assertionId}" not found`, {
          assertionId,
        });
      }
      this.requireNamespaceUnlocked(assertion.namespace, 'indexAssertion');
      const table = this.ensureVectorReady(assertion.namespace, 'indexing');
      const dim = this.namespaceRepo.get(assertion.namespace)?.embeddingDimension ?? null;

      let vec: Float32Array | number[];
      if (embedding) {
        const vectorError = vectorValidationError(embedding, dim, 'embedding');
        if (vectorError) {
          throw new IndexingError(ErrorCode.INDEXING_EMBEDDING_DIMENSION_MISMATCH, vectorError, { assertionId });
        }
        vec = embedding;
      } else {
        // Resolve the namespace-effective provider: a per-namespace binding
        // (from initNamespace/upgradeNamespaceToVector) takes precedence over
        // the store-level default.
        const provider = this.getNamespaceProvider(assertion.namespace);
        if (!provider) {
          throw new IndexingError(
            ErrorCode.INDEXING_NO_EMBEDDING_AND_NO_PROVIDER,
            `Cannot index "${assertionId}": no embedding supplied and no embedding provider configured`,
            { assertionId },
          );
        }
        let computed: Float32Array | undefined;
        try {
          [computed] = await provider.embed([assertion.content], {
            purpose: 'assertion',
          });
        } catch (err) {
          throw new EmbeddingProviderError(provider.name, 0, err);
        }
        if (!computed) {
          throw new IndexingError(
            ErrorCode.INDEXING_NO_EMBEDDING_AND_NO_PROVIDER,
            `Embedding provider returned no embedding for assertion "${assertionId}"`,
            { assertionId },
          );
        }
        const vectorError = vectorValidationError(computed, dim, 'provider embedding');
        if (vectorError) {
          throw new EmbeddingProviderError(provider.name, 0, vectorError);
        }
        vec = computed;
      }

      this.embeddingRepo.insert(table, assertionId, vec);
    });
  }

  async indexBatch(items: IndexBatchItem[], options: IndexBatchOptions = {}): Promise<IndexBatchResult> {
    return this.trackOperation('indexBatch', async () => {
      this.requireInit();
      const batchSize = options.batchSize ?? 64;
      const batchError = positiveIntegerOptionError(batchSize, 'batchSize');
      if (batchError) throw new ValidationError([batchError], 'IndexBatch');
      const mode = options.onProviderError ?? 'fail-fast';
      const modeError = literalOptionError(mode, 'onProviderError', ['fail-fast', 'skip'] as const);
      if (modeError) {
        throw new IndexingError(ErrorCode.INDEXING_INVALID_PROVIDER_ERROR_MODE, modeError);
      }
      this.clearStaleNamespaceLocks();

      // Skips are tracked with their input index so the returned skipped[]
      // preserves input order regardless of which resolution stage produced them.
      const skips: Array<{ index: number; entry: IndexBatchResult['skipped'][number] }> = [];
      let indexed = 0;

      type Pending = {
        index: number;
        assertion: Assertion;
        table: string;
        dim: number | null;
        needsProvider: boolean;
        supplied?: Float32Array | number[];
        /** The namespace-effective provider for a provider-derived item. */
        provider?: EmbeddingProvider;
      };
      const pending: Pending[] = [];
      // ensureVectorReady / dimension / provider lookups are resolved once per
      // namespace per call, not once per item.
      const tableByNs = new Map<string, string>();
      const dimByNs = new Map<string, number | null>();
      const providerByNs = new Map<string, EmbeddingProvider | null>();

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item) continue;
        const assertion = this.assertionRepo.getById(item.assertionId);
        if (!assertion) {
          skips.push({
            index: i,
            entry: {
              assertionId: item.assertionId,
              reason: 'ASSERTION_NOT_FOUND',
              errorCode: 'ASSERTION_NOT_FOUND',
            },
          });
          continue;
        }
        const locked = this.namespaceLock(assertion.namespace);
        if (locked) {
          if (mode === 'skip') {
            skips.push({
              index: i,
              entry: {
                assertionId: item.assertionId,
                reason: ErrorCode.NAMESPACE_OPERATION_LOCKED,
                errorCode: ErrorCode.NAMESPACE_OPERATION_LOCKED,
              },
            });
            continue;
          }
          throw new IndexingError(
            ErrorCode.NAMESPACE_OPERATION_LOCKED,
            `Namespace "${assertion.namespace}" is locked by ${locked.operation}; cannot index "${assertion.id}"`,
            { assertionId: assertion.id },
          );
        }
        // Validate the namespace is vector-configured / sqlite-vec loaded, and
        // resolve its effective embedding provider — once per distinct namespace.
        let table = tableByNs.get(assertion.namespace);
        if (table === undefined) {
          table = this.ensureVectorReady(assertion.namespace, 'indexing');
          tableByNs.set(assertion.namespace, table);
          dimByNs.set(assertion.namespace, this.namespaceRepo.get(assertion.namespace)?.embeddingDimension ?? null);
          providerByNs.set(assertion.namespace, this.getNamespaceProvider(assertion.namespace));
        }
        const dim = dimByNs.get(assertion.namespace) ?? null;
        const provider = providerByNs.get(assertion.namespace) ?? null;

        if (item.embedding) {
          const vectorError = vectorValidationError(item.embedding, dim, 'embedding');
          if (vectorError) {
            skips.push({
              index: i,
              entry: {
                assertionId: item.assertionId,
                reason: vectorErrorCode(vectorError),
                errorCode: vectorErrorCode(vectorError),
              },
            });
            continue;
          }
          pending.push({
            index: i,
            assertion,
            table,
            dim,
            needsProvider: false,
            supplied: item.embedding,
          });
        } else if (provider) {
          pending.push({ index: i, assertion, table, dim, needsProvider: true, provider });
        } else {
          skips.push({
            index: i,
            entry: {
              assertionId: item.assertionId,
              reason: 'NO_EMBEDDING_AND_NO_PROVIDER',
              errorCode: 'NO_EMBEDDING_AND_NO_PROVIDER',
            },
          });
        }
      }

      const persist = (p: Pending, vec: Float32Array | number[]): void => {
        const vectorError = vectorValidationError(vec, p.dim, 'embedding');
        if (vectorError) {
          skips.push({
            index: p.index,
            entry: {
              assertionId: p.assertion.id,
              reason: vectorErrorCode(vectorError),
              errorCode: vectorErrorCode(vectorError),
            },
          });
          return;
        }
        this.embeddingRepo.insert(p.table, p.assertion.id, vec);
        indexed++;
      };

      // Caller-supplied embeddings persist immediately.
      for (const p of pending) {
        if (!p.needsProvider && p.supplied) persist(p, p.supplied);
      }

      // Provider-derived embeddings, grouped by the effective provider so a
      // batch spanning namespaces never calls provider A for namespace B.
      const needsProvider = pending.filter(
        (p): p is Pending & { provider: EmbeddingProvider } => p.needsProvider && !!p.provider,
      );
      const groups = new Map<EmbeddingProvider, Array<Pending & { provider: EmbeddingProvider }>>();
      for (const p of needsProvider) {
        const g = groups.get(p.provider) ?? [];
        g.push(p);
        groups.set(p.provider, g);
      }

      if (mode === 'fail-fast') {
        // Embed and persist chunk-by-chunk so a mid-run provider failure leaves
        // EmbeddingProviderError.indexed reflecting rows actually written to vec0.
        for (const [groupProvider, groupItems] of groups) {
          try {
            for (let off = 0; off < groupItems.length; off += batchSize) {
              if (options.signal?.aborted) {
                throw new EmbeddingProviderError(groupProvider.name, indexed, 'aborted by signal');
              }
              const chunk = groupItems.slice(off, off + batchSize);
              const opts: { purpose: 'assertion'; signal?: AbortSignal } = { purpose: 'assertion' };
              if (options.signal) opts.signal = options.signal;
              const vecs = await groupProvider.embed(
                chunk.map((p) => p.assertion.content),
                opts,
              );
              for (let k = 0; k < chunk.length; k++) {
                const vec = vecs[k];
                const c = chunk[k];
                if (!vec || !c) {
                  throw new EmbeddingProviderError(
                    groupProvider.name,
                    indexed,
                    `provider returned no vector for batch item ${String(k)}`,
                  );
                }
                const vectorError = vectorValidationError(vec, c.dim, 'provider embedding');
                if (vectorError) {
                  throw new EmbeddingProviderError(groupProvider.name, indexed, vectorError);
                }
                persist(c, vec);
              }
            }
          } catch (err) {
            if (err instanceof EmbeddingProviderError) throw err;
            throw new EmbeddingProviderError(groupProvider.name, indexed, err);
          }
        }
      } else {
        // skip mode: embed one at a time; record failures in skipped[] with a
        // stable `reason` token and a sanitized `errorCode` derived from the
        // thrown error — never the raw provider message.
        for (const p of needsProvider) {
          if (options.signal?.aborted) {
            skips.push({
              index: p.index,
              entry: { assertionId: p.assertion.id, reason: 'ABORTED', errorCode: 'ABORTED' },
            });
            continue;
          }
          try {
            const opts: { purpose: 'assertion'; signal?: AbortSignal } = { purpose: 'assertion' };
            if (options.signal) opts.signal = options.signal;
            const [vec] = await p.provider.embed([p.assertion.content], opts);
            if (!vec) {
              skips.push({
                index: p.index,
                entry: {
                  assertionId: p.assertion.id,
                  reason: 'EMBEDDING_PROVIDER_ERROR',
                  errorCode: 'EMBEDDING_PROVIDER_EMPTY',
                },
              });
              continue;
            }
            const vectorError = vectorValidationError(vec, p.dim, 'provider embedding');
            if (vectorError) {
              skips.push({
                index: p.index,
                entry: {
                  assertionId: p.assertion.id,
                  reason: 'EMBEDDING_PROVIDER_ERROR',
                  errorCode: vectorErrorCode(vectorError),
                },
              });
              continue;
            }
            persist(p, vec);
          } catch (err) {
            // The raw message is never surfaced — errorCode is the thrown
            // error's stable code, or 'UNKNOWN' for a plain Error.
            skips.push({
              index: p.index,
              entry: {
                assertionId: p.assertion.id,
                reason: 'EMBEDDING_PROVIDER_ERROR',
                errorCode: errorCodeOf(err),
              },
            });
          }
        }
      }

      const skipped = skips.sort((a, b) => a.index - b.index).map((s) => s.entry);
      if (skipped.length > 0) {
        this.options.logger.warn('TRGT_INDEX_BATCH_SKIPPED', { count: skipped.length });
      }
      incr(this.options.metrics ?? undefined, 'trageti.indexBatch.indexed', { count: indexed });
      incr(this.options.metrics ?? undefined, 'trageti.indexBatch.skipped', { count: skipped.length });
      const providerFailures = skipped.filter((s) => s.reason === 'EMBEDDING_PROVIDER_ERROR').length;
      if (providerFailures > 0) {
        incr(this.options.metrics ?? undefined, 'trageti.embeddingProvider.failures', {
          count: providerFailures,
        });
      }
      return { indexed, skipped };
    });
  }

  async getPendingIndexing(
    namespace: string,
    options: IndexingStateOptions = {},
  ): Promise<Array<{ id: string; content: string }>> {
    this.requireNamespaceInit(namespace);
    // getPendingIndexing does NOT route through ensureVectorReady: its result
    // is observable across the full (vectorless × vec0-exists × sqlite-vec)
    // matrix without throwing for the vectorless / vec0-not-yet-created cases.
    const config = this.namespaceRepo.get(namespace);
    const table = this.namespaceRepo.getEmbeddingTable(namespace);
    if (!config || config.embeddingDimension === null || !table) {
      // Vectorless namespace — nothing is ever pending vector indexing.
      this.options.logger.debug('TRGT_PENDING_INDEXING_VECTORLESS', { namespace });
      return [];
    }
    if (!this.embeddingRepo.tableExists(table)) {
      // Vector-configured but the vec0 table has not been lazily created yet —
      // every active assertion is pending. This case does not touch vec0, so
      // it works whether or not sqlite-vec is loaded.
      return this.embeddingRepo.getAllContent(namespace, options);
    }
    if (!this.isSqliteVecLoaded()) {
      // vec0 exists but the extension is not loaded — cannot introspect it.
      throw new MissingPeerDependencyError(
        'sqlite-vec',
        'npm install sqlite-vec',
        'load sqlite-vec to introspect indexing state for a vector namespace',
      );
    }
    return this.embeddingRepo.getPendingIndexing(table, namespace, options);
  }

  // ─── Retrieval ─────────────────────────────────────────────────────────────

  async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    return this.trackOperation('retrieve', async () => {
      const routedBefore = applyBeforeHooks(this.options.middleware, query.middleware ?? [], query);
      this.requireNamespaceInit(routedBefore.namespace);
      validateRetrievalQuery(routedBefore);
      // Step 0: routing. Resolve a provider-derived query embedding when the
      // caller gave queryText but no queryEmbedding, or record why the vector
      // branch is skipped under hybrid degradation.
      const { query: routed, skipReason } = await this.resolveQueryEmbedding(routedBefore);
      const result = retrieve(
        this.db,
        {
          assertionRepo: this.assertionRepo,
          embeddingRepo: this.embeddingRepo,
          getEmbeddingTable: (ns) => this.ensureVectorReadable(ns),
          getPositionRange: (ns) => this.namespaceRepo.getPositionRange(ns),
          getDimension: (ns) => this.namespaceRepo.get(ns)?.embeddingDimension ?? null,
          globalScorer: this.options.scorer,
          globalMiddleware: this.options.middleware,
          graphAdapter: this.options.graphAdapter,
          logger: this.options.logger,
          metrics: this.options.metrics ?? null,
        },
        routed,
        { skipBefore: true },
      );
      if (skipReason) {
        result.meta.warnings.push({
          code: 'TRGT_RETRIEVE_VECTOR_SKIPPED',
          message: `vector retrieval skipped: ${skipReason}`,
        });
      }
      return result;
    });
  }

  /**
   * Retrieval Step 0. When `queryText` is supplied without a `queryEmbedding`
   * and the strategy permits vector retrieval, derive a query embedding from
   * the configured provider. If the vector backend is unavailable, hybrid
   * degrades to BM25 (returning a skip reason); a `vector` strategy throws.
   */
  private async resolveQueryEmbedding(query: RetrievalQuery): Promise<{ query: RetrievalQuery; skipReason?: string }> {
    const strategy = query.retrievalStrategy ?? 'hybrid';
    const hasQueryText = typeof query.queryText === 'string' && query.queryText.trim().length > 0;
    // Nothing to resolve: embedding already present, bm25-only, or no text.
    if (query.queryEmbedding || strategy === 'bm25' || !hasQueryText) {
      return { query };
    }

    const config = this.namespaceRepo.get(query.namespace);
    const vectorless = !config || config.embeddingDimension === null;
    const provider = this.getNamespaceProvider(query.namespace);

    const degrade = (reason: string): { query: RetrievalQuery; skipReason: string } => {
      this.options.logger.info('TRGT_RETRIEVE_VECTOR_SKIPPED', {
        namespace: query.namespace,
        reason,
      });
      return { query, skipReason: reason };
    };

    if (vectorless) {
      if (strategy === 'vector') {
        throw new RetrievalInputError(
          ErrorCode.RETRIEVAL_NAMESPACE_VECTORLESS,
          `Namespace "${query.namespace}" is vectorless; retrievalStrategy 'vector' cannot apply`,
        );
      }
      return degrade('NAMESPACE_VECTORLESS');
    }
    if (!provider) {
      if (strategy === 'vector') {
        throw new RetrievalInputError(
          ErrorCode.RETRIEVAL_REQUIRES_VECTOR_INPUT,
          "retrievalStrategy 'vector' with queryText requires a configured EmbeddingProvider",
        );
      }
      return degrade('NO_PROVIDER');
    }
    if (!this.isSqliteVecLoaded()) {
      if (strategy === 'vector') {
        throw new MissingPeerDependencyError('sqlite-vec', 'npm install sqlite-vec', "use retrievalStrategy: 'bm25'");
      }
      return degrade('NO_SQLITE_VEC');
    }
    const table = this.namespaceRepo.getEmbeddingTable(query.namespace);
    if (!table || !this.embeddingRepo.tableExists(table)) {
      if (strategy === 'vector') {
        throw new RetrievalInputError(
          ErrorCode.RETRIEVAL_VECTOR_INDEX_NOT_READY,
          `Namespace "${query.namespace}" has no readable vector index table; index assertions before vector retrieval.`,
        );
      }
      return degrade('VECTOR_INDEX_NOT_READY');
    }

    // Pre-checks passed (provider resolvable, sqlite-vec loaded, namespace
    // vector-ready) — Step 0 has committed to deriving a query embedding. From
    // here a provider outage is a hard failure: it surfaces as
    // EmbeddingProviderError and is NOT hidden behind a BM25 degrade, for both
    // hybrid and vector strategy (spec §2569, §2589).
    const embedOpts: { purpose: 'query'; signal?: AbortSignal } = { purpose: 'query' };
    if (query.signal) embedOpts.signal = query.signal;
    let vec: Float32Array | undefined;
    try {
      [vec] = await provider.embed([query.queryText as string], embedOpts);
    } catch (err) {
      throw new EmbeddingProviderError(provider.name, 0, err);
    }
    if (!vec) {
      throw new EmbeddingProviderError(provider.name, 0, 'provider returned no query embedding');
    }
    const vectorError = vectorValidationError(vec, config.embeddingDimension, 'provider query embedding');
    if (vectorError) {
      throw new EmbeddingProviderError(provider.name, 0, vectorError);
    }
    return { query: { ...query, queryEmbedding: vec } };
  }

  async assembleContext(options: ContextAssemblyOptions): Promise<AssembledContext> {
    return this.trackOperation('assembleContext', async () => {
      this.requireNamespaceInit(options.namespace);
      return await assembleContext(this, {
        globalFormatter: this.options.defaultFormatter,
        ...options,
      });
    });
  }

  // ─── Snapshot ──────────────────────────────────────────────────────────────

  async getTemporalSnapshot(options: TemporalSnapshotOptions): Promise<Assertion[]> {
    this.requireNamespaceInit(options.namespace);
    this.validateTemporalSnapshotOptions(options);
    return getTemporalSnapshot(this.db, this.assertionRepo, options);
  }

  // ─── Graph ─────────────────────────────────────────────────────────────────

  async getConnected(options: TraversalOptions): Promise<Assertion[]> {
    this.requireNamespaceInit(options.namespace);
    return getConnected(this.db, this.assertionRepo, this.options.graphAdapter, options);
  }

  async findPath(options: PathOptions): Promise<AssertionLink[] | null> {
    this.requireNamespaceInit(options.namespace);
    return findPath(this.db, this.linkRepo, this.options.graphAdapter, options);
  }

  // ─── Utility ───────────────────────────────────────────────────────────────

  async getAssertions(
    namespace: string,
    options?: {
      entityId?: string;
      entityType?: string;
      type?: string;
      validAt?: number;
      includeSuperseded?: boolean;
    },
  ): Promise<Assertion[]> {
    this.requireNamespaceInit(namespace);
    if (options?.validAt !== undefined) {
      const err = finiteNumberError(options.validAt, 'validAt');
      if (err) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_TEMPORAL_ANCHOR, err);
    }
    return this.assertionRepo.query(namespace, options);
  }

  async getEntityHistory(namespace: string, entityId: string): Promise<Assertion[]> {
    this.requireNamespaceInit(namespace);
    return this.assertionRepo.getEntityHistory(namespace, entityId);
  }

  /**
   * Returns the supersession-chain leaves for an entity (decision §5). Follows
   * supersedes_id only — does NOT traverse trageti_links. For entities where new
   * information layers rather than replaces, use writeLink with one of the
   * accumulation link types and read with getEntityHistory + expandLinks.
   */
  async getEntityTrajectory(namespace: string, entityId: string): Promise<Assertion[]> {
    this.requireNamespaceInit(namespace);
    return this.assertionRepo.getEntityTrajectory(namespace, entityId);
  }

  async getLinksByIds(ids: readonly string[]): Promise<AssertionLink[]> {
    this.requireInit();
    return this.linkRepo.getByIds(ids);
  }

  async getMissingIndexing(
    namespace: string,
    assertionIds: readonly string[],
    options: IndexingStateOptions = {},
  ): Promise<Array<{ id: string; content: string }>> {
    this.requireNamespaceInit(namespace);
    if (assertionIds.length === 0) return [];
    const config = this.namespaceRepo.get(namespace);
    const tableName = this.namespaceRepo.getEmbeddingTable(namespace);
    if (!config || config.embeddingDimension === null || !tableName) {
      this.options.logger.debug('TRGT_MISSING_INDEXING_VECTORLESS', { namespace });
      return [];
    }
    const table = this.ensureVectorReadable(namespace);
    const missingIds =
      table === null
        ? this.filterRequestedIndexingIds(namespace, assertionIds, options)
        : this.embeddingRepo.getMissingIndexingByIds(table, namespace, assertionIds, options);
    if (missingIds.length === 0) return [];
    const assertionsById = new Map(this.assertionRepo.getByIds(missingIds).map((assertion) => [assertion.id, assertion]));
    return missingIds.flatMap((id) => {
      const assertion = assertionsById.get(id);
      return assertion && assertion.namespace === namespace ? [{ id, content: assertion.content }] : [];
    });
  }

  async getEpisode(id: string): Promise<Episode | null> {
    this.requireInit();
    return this.episodeRepo.getById(id);
  }

  async deleteNamespace(namespace: string, options: DeleteNamespaceOptions = {}): Promise<void> {
    this.requireInit();
    this.requireNamespaceUnlocked(namespace, 'deleteNamespace');
    const refTables = (this.options.schemaExtensions.tables ?? []).filter((t) => t.referencesNamespace);
    if (refTables.length > 0) {
      if (!options.cascade) {
        throw new ReferencedExtensionTableError(
          namespace,
          refTables.map((table) => table.tableName),
        );
      }
    }
    this.db.transaction(() => {
      for (const table of refTables) {
        if (!table.namespaceColumn) continue;
        this.db
          .prepare(`DELETE FROM ${quoteIdent(table.tableName)} WHERE ${quoteIdent(table.namespaceColumn)} = ?`)
          .run(namespace);
      }
      const table = this.namespaceRepo.getEmbeddingTable(namespace);
      if (table) this.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
      // Citations must go before assertions (FK from trageti_citations.assertion_id).
      this.citationRepo.deleteByAssertionNamespace(namespace);
      this.db.prepare('DELETE FROM trageti_links WHERE namespace = ?').run(namespace);
      this.db
        .prepare('DELETE FROM trageti_links WHERE from_id IN (SELECT id FROM trageti_assertions WHERE namespace = ?)')
        .run(namespace);
      this.db
        .prepare('DELETE FROM trageti_links WHERE to_id IN (SELECT id FROM trageti_assertions WHERE namespace = ?)')
        .run(namespace);
      this.db
        .prepare('DELETE FROM trageti_links WHERE source_episode_id IN (SELECT id FROM trageti_episodes WHERE namespace = ?)')
        .run(namespace);
      this.db.prepare('DELETE FROM trageti_assertions WHERE namespace = ?').run(namespace);
      this.db.prepare('DELETE FROM trageti_episodes WHERE namespace = ?').run(namespace);
      this.db.prepare('DELETE FROM trageti_namespaces WHERE namespace = ?').run(namespace);
    })();
  }

  async reindexNamespace(namespace: string, options: ReindexOptions = {}): Promise<ReindexResult> {
    return this.trackOperation('reindexNamespace', async () => {
      this.requireNamespaceInit(namespace);
      const lockOwner = this.acquireNamespaceOperationLock(namespace, 'reindexNamespace');
      try {
        const batchSize = options.batchSize ?? 64;
        const batchError = positiveIntegerOptionError(batchSize, 'batchSize');
        if (batchError) throw new ReindexError(namespace, 0, batchError);
        const strategy = options.strategy ?? 'staging-swap';
        const strategyError = literalOptionError(strategy, 'strategy', ['staging-swap', 'in-place'] as const);
        if (strategyError) {
          throw new ReindexError(namespace, 0, strategyError, { code: ErrorCode.REINDEX_INVALID_STRATEGY });
        }
        const mode = options.onProviderError ?? 'fail-fast';
        const modeError = literalOptionError(mode, 'onProviderError', ['fail-fast', 'skip'] as const);
        if (modeError) {
          throw new ReindexError(namespace, 0, modeError, {
            code: ErrorCode.REINDEX_INVALID_PROVIDER_ERROR_MODE,
          });
        }
        // Validate newDimension before any vec0 DDL — a non-integer / non-positive
        // value would otherwise surface as a raw SQLite error.
        if (options.newDimension !== undefined) {
          assertValidDimension(namespace, options.newDimension);
        }
        // Effective provider: explicit override → per-namespace binding → store default.
        const provider = options.embeddingProvider ?? this.getNamespaceProvider(namespace);
        if (!provider) {
          throw new ReindexError(
            namespace,
            0,
            'reindexNamespace requires an embeddingProvider (none supplied and none configured on the store)',
          );
        }
        try {
          this.ensureVectorReady(namespace, 'indexing');
        } catch (err) {
          throw new ReindexError(namespace, 0, err instanceof Error ? err.message : String(err), {
            code: errorCodeOf(err),
          });
        }
        const result = await doReindex(this.db, this.namespaceRepo, this.embeddingRepo, namespace, {
          ...options,
          embeddingProvider: provider,
          onHeartbeat: () => {
            this.refreshNamespaceOperationLock(namespace, lockOwner);
          },
        });
        observe(this.options.metrics ?? undefined, 'trageti.reindex.tookMs', result.durationMs);
        return result;
      } finally {
        this.releaseNamespaceOperationLock(namespace, lockOwner);
      }
    });
  }

  async getStats(namespace: string): Promise<NamespaceStats> {
    this.requireNamespaceInit(namespace);
    const assertionStats = this.assertionRepo.getStats(namespace);
    const episodeCount =
      this.db
        .prepare<[string], { cnt: number }>('SELECT COUNT(*) AS cnt FROM trageti_episodes WHERE namespace = ?')
        .get(namespace)?.cnt ?? 0;
    const ns = this.namespaceRepo.get(namespace);
    const table = this.namespaceRepo.getEmbeddingTable(namespace);
    // Table existence is probed independently of sqlite-vec so the
    // vec0-exists-but-no-sqlite-vec gap can be reported.
    const sqliteVecLoaded = this.isSqliteVecLoaded();
    const tableExists = table ? this.embeddingRepo.tableExists(table) : false;
    if (tableExists && !sqliteVecLoaded) {
      // The vec0 table physically exists but cannot be introspected — surface
      // the gap so callers can see why indexedCount is 0 (spec §2133, §2404).
      this.options.logger.debug('TRGT_STATS_VEC_NOT_INTROSPECTED', { namespace });
    }
    const vectorReady = Boolean(table && sqliteVecLoaded && tableExists);
    const indexedCount = vectorReady && table ? this.embeddingRepo.getIndexedCount(table, namespace) : 0;
    const linkCount = this.linkRepo.getCount(namespace);
    const positionRange = this.namespaceRepo.getPositionRange(namespace);
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
    };
  }

  async getMigrations(): Promise<readonly MigrationDescriptor[]> {
    this.requireInit();
    const appliedAt = this.migrationRunner.getAppliedVersions(this.db);
    return this.migrationRunner.getMigrations().map((migration) => ({
      version: migration.version,
      name: migration.name ?? migration.description,
      description: migration.description,
      requiresForeignKeyToggle: migration.requiresForeignKeyToggle ?? false,
      appliedAt: appliedAt.get(migration.version) ?? null,
    }));
  }

  async getCurrentSchemaVersion(): Promise<number> {
    this.requireNotClosed('getCurrentSchemaVersion');
    return new MigrationRunner().getCurrentVersion(this.db);
  }

  /**
   * Re-run the migration runner. Non-spec public surface, intentionally
   * retained for advanced/operational use; guarded by the open-state check
   * like every other public method.
   */
  async applyMigrations(): Promise<void> {
    this.requireNotClosed('applyMigrations');
    new MigrationRunner(this.options.fts5Tokenizer).applyMigrations(this.db);
  }

  async rebuildFts(options: RebuildFtsOptions = {}): Promise<RebuildFtsResult> {
    this.requireInit();
    const started = Date.now();
    // When no tokenizer is supplied, a rebuild is a repair — it MUST preserve
    // the tokenizer currently recorded in trageti_tokenizer, never silently
    // reset to the store's configured fts5Tokenizer (spec §2088-2099, §2350-2355).
    const tokenizer = options.tokenizer ?? this.readStoredTokenizer() ?? this.options.fts5Tokenizer;
    const tokenizeArg = buildFtsTokenizeArg(tokenizer);
    const batchSize = options.batchSize ?? 1000;
    const batchError = positiveIntegerOptionError(batchSize, 'batchSize');
    if (batchError) throw new ValidationError([batchError]);

    // Drop and recreate trageti_fulltext inside a single write transaction, then
    // repopulate while preserving the rowid invariant (trageti_fulltext.rowid ===
    // trageti_assertions.rowid) so BM25 joins continue to work.
    let reindexed = 0;
    this.db.transaction(() => {
      this.db.exec('DROP TABLE IF EXISTS trageti_fulltext');
      this.db.exec(`
        CREATE VIRTUAL TABLE trageti_fulltext USING fts5(
          assertion_id UNINDEXED,
          content,
          content='trageti_assertions',
          content_rowid='rowid',
          tokenize='${tokenizeArg}'
        );
      `);
      const insert = this.db.prepare(
        'INSERT INTO trageti_fulltext(rowid, assertion_id, content) SELECT rowid, id, content FROM trageti_assertions WHERE rowid > ? AND rowid <= ?',
      );
      const maxRow = this.db.prepare<[], { m: number | null }>('SELECT MAX(rowid) AS m FROM trageti_assertions').get();
      const max = maxRow?.m ?? 0;
      for (let start = 0; start < max; start += batchSize) {
        if (options.signal?.aborted) throw new ValidationError(['rebuildFts aborted by signal']);
        const end = Math.min(start + batchSize, max);
        const info = insert.run(start, end);
        reindexed += info.changes;
      }
      // Update trageti_tokenizer with the active tokenizer config.
      this.db
        .prepare(
          `INSERT INTO trageti_tokenizer (id, tokenizer, tokenizer_args, updated_at)
           VALUES (1, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET tokenizer = excluded.tokenizer,
                                         tokenizer_args = excluded.tokenizer_args,
                                         updated_at = excluded.updated_at`,
        )
        .run(tokenizer.tokenizer, JSON.stringify(tokenizer.tokenizerArgs ?? []));
    })();

    return { reindexedRows: reindexed, newTokenizer: tokenizer, durationMs: Date.now() - started };
  }

  async upgradeNamespaceToVector(namespace: string, options: UpgradeNamespaceToVectorOptions): Promise<void> {
    this.requireNamespaceInit(namespace);
    this.requireNamespaceUnlocked(namespace, 'upgradeNamespaceToVector');
    const existing = this.namespaceRepo.get(namespace);
    if (existing && existing.embeddingDimension !== null) {
      throw new ValidationError([
        `Namespace "${namespace}" is already vector-configured (dimension ${String(existing.embeddingDimension)}). ` +
          'Use reindexNamespace() to change the dimension.',
      ]);
    }
    const dimension = this.resolveVectorDimension(namespace, options.embeddingDimension, options.embeddingProvider);
    if (dimension === null) {
      throw new ValidationError([
        `upgradeNamespaceToVector("${namespace}") requires an embeddingDimension or an embeddingProvider`,
      ]);
    }
    const table = namespaceToEmbeddingTable(namespace);
    this.db.transaction(() => {
      this.namespaceRepo.updateEmbeddingDimension(namespace, dimension, table);
    })();
    if (options.embeddingProvider) {
      this.namespaceProviders.set(namespace, options.embeddingProvider);
    }
    this.options.logger.info('TRGT_NAMESPACE_VECTOR_UPGRADED', {
      namespace,
      embeddingDimension: dimension,
    });
  }

  /**
   * Non-executing retrieval planning introspection. Reports the strategy, the
   * per-step plan, and whether each branch would actually run — without
   * touching assertion/embedding data or calling the embedding provider.
   *
   * Step-0 routing is modelled exactly as `resolveQueryEmbedding()` decides
   * it: a `queryText`-only query with a resolvable provider, a loaded
   * `sqlite-vec`, and a vector-configured namespace WOULD run vector retrieval.
   */
  async explain(query: RetrievalQuery): Promise<RetrievalExplainResult> {
    this.requireNamespaceInit(query.namespace);
    validateRetrievalQuery(query);
    const strategy = query.retrievalStrategy ?? 'hybrid';
    const config = this.namespaceRepo.get(query.namespace);
    const table = this.namespaceRepo.getEmbeddingTable(query.namespace);
    const sqliteVec = this.isSqliteVecLoaded();
    const vectorReady = Boolean(table && sqliteVec && this.embeddingRepo.tableExists(table));
    const vectorless = !config || config.embeddingDimension === null;
    const provider = this.getNamespaceProvider(query.namespace);
    const hasQueryText = typeof query.queryText === 'string' && query.queryText.trim().length > 0;
    const hasQueryEmbedding = Boolean(query.queryEmbedding);
    const notes: string[] = [];

    // wouldApplyVector — true iff Step 2 (vector candidate selection) would run.
    let wouldApplyVector = false;
    if (strategy !== 'bm25') {
      if (hasQueryEmbedding) {
        wouldApplyVector = !vectorless && vectorReady;
        if (vectorless) {
          notes.push('namespace is vectorless — vector retrieval cannot apply');
        }
      } else if (hasQueryText) {
        // Step 0 would derive the embedding from the provider — model the
        // same pre-checks resolveQueryEmbedding() applies, without calling it.
        const blocker = vectorless
          ? 'NAMESPACE_VECTORLESS'
          : !provider
            ? 'NO_PROVIDER'
            : !sqliteVec
              ? 'NO_SQLITE_VEC'
              : !vectorReady
                ? 'VECTOR_TABLE_MISSING'
                : null;
        if (blocker === null) {
          wouldApplyVector = true;
        } else if (strategy === 'vector') {
          notes.push(`retrievalStrategy 'vector' would fail: ${blocker}`);
        } else {
          notes.push(`would fall back to BM25-only: ${blocker}`);
        }
      }
    }
    const wouldApplyBm25 = strategy !== 'vector' && hasQueryText;

    const steps: RetrievalExplainResult['steps'] = [
      { step: 'validate', notes: ['validates strategy-specific retrieval inputs'] },
      {
        step: 'temporal-filter',
        notes: ['filters trageti_assertions by namespace + temporal anchor'],
      },
    ];
    if (wouldApplyVector) {
      steps.push({
        step: 'semantic',
        vectorReady,
        sql: 'vec_distance_cosine over the namespace vec0 table',
      });
    }
    if (wouldApplyBm25) {
      steps.push({ step: 'keyword', sql: 'bm25(trageti_fulltext) over the FTS5 index' });
    }
    // `rank` follows `score` and precedes the optional graph / trajectory
    // expansion steps — the same order the retrieval pipeline emits them in.
    steps.push({ step: 'score' }, { step: 'rank' });
    if (query.expandLinks && (query.maxDepth ?? 1) > 0) {
      steps.push({ step: 'graph-expand' });
    }
    if ((query.mode ?? 'snapshot') === 'trajectory') {
      steps.push({ step: 'trajectory-expand' });
    }

    return { query, retrievalStrategy: strategy, steps, wouldApplyVector, wouldApplyBm25, notes };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closePromise ??= this.closeCore();
    return this.closePromise;
  }

  private async closeCore(): Promise<void> {
    this.closing = true;
    const cleanupErrors: unknown[] = [];
    await this.waitForInFlightOperations();
    for (const middleware of this.options.middleware) {
      try {
        await middleware.dispose?.();
      } catch (err) {
        cleanupErrors.push(err);
      }
    }
    try {
      await this.options.logger.flush?.();
    } catch (err) {
      cleanupErrors.push(err);
    }
    if (this.closeDatabaseOnStoreClose) {
      try {
        this.db.close();
      } catch (err) {
        cleanupErrors.push(err);
      }
    }
    this.closed = true;
    this.closing = false;
    if (cleanupErrors.length > 0) {
      throw new TragetiError(
        ErrorCode.STORE_CLOSED,
        `TragetiStore closed with cleanup error(s): ${cleanupErrors.map(errorCodeOf).join(', ')}`,
      );
    }
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Structural invariants (decision §2). These are enforced by TragetiStore
   * directly so that replacing the validators array cannot bypass them.
   */
  private enforceStructuralInvariants(
    assertion: NormalizedNewAssertion,
    options: { inFlightEpisodeIds?: ReadonlySet<string>; collectErrors?: string[] } = {},
  ): void {
    const errors = options.collectErrors ?? [];

    for (const [value, label] of [
      [assertion.id, 'id'],
      [assertion.namespace, 'namespace'],
      [assertion.type, 'type'],
      [assertion.content, 'content'],
      [assertion.sourceEpisodeId, 'sourceEpisodeId'],
    ] as const) {
      if (!isNonEmptyString(value)) errors.push(`${label} is required`);
    }

    const validFromError = finiteNumberError(assertion.validFrom, 'validFrom');
    if (validFromError) errors.push(validFromError);
    if (assertion.validUntil !== null) {
      const validUntilError = finiteNumberError(assertion.validUntil, 'validUntil');
      if (validUntilError) errors.push(validUntilError);
    }
    if (
      Number.isFinite(assertion.validFrom) &&
      assertion.validUntil !== null &&
      Number.isFinite(assertion.validUntil) &&
      assertion.validUntil <= assertion.validFrom
    ) {
      errors.push('validUntil must be strictly greater than validFrom');
    }
    if (!Number.isFinite(assertion.confidence) || assertion.confidence < 0 || assertion.confidence > 1) {
      errors.push('confidence must be a number in [0.0, 1.0]');
    }
    if (
      isNonEmptyString(assertion.sourceEpisodeId) &&
      isNonEmptyString(assertion.namespace) &&
      !options.inFlightEpisodeIds?.has(assertion.sourceEpisodeId)
    ) {
      const sourceEpisode = this.db
        .prepare<[string, string], { id: string }>('SELECT id FROM trageti_episodes WHERE id = ? AND namespace = ?')
        .get(assertion.sourceEpisodeId, assertion.namespace);
      if (!sourceEpisode) {
        errors.push(
          `sourceEpisodeId "${assertion.sourceEpisodeId}" does not reference a known episode in namespace "${assertion.namespace}"`,
        );
      }
    }

    // Citation presence + per-citation fields
    if (!Array.isArray(assertion.citations) || assertion.citations.length === 0) {
      errors.push('citations array is required and must contain at least one entry');
    } else {
      for (const cit of assertion.citations) {
        if (!isNonEmptyString(cit.id)) errors.push('citation.id is required');
        if (!isNonEmptyString(cit.sourceRef)) errors.push(`citation "${cit.id}" sourceRef is required`);
        if (!isNonEmptyString(cit.episodeId)) {
          errors.push(`citation "${cit.id}" episodeId is required`);
        } else if (!options.inFlightEpisodeIds?.has(cit.episodeId)) {
          const ep = this.db
            .prepare<[string, string], { id: string }>('SELECT id FROM trageti_episodes WHERE id = ? AND namespace = ?')
            .get(cit.episodeId, assertion.namespace);
          if (!ep) {
            errors.push(
              `citation "${cit.id}" episodeId "${cit.episodeId}" does not reference an episode in namespace "${assertion.namespace}"`,
            );
          }
        }
      }
    }

    // Predecessor checks (only if supersedesId set)
    if (assertion.supersedesId !== null) {
      const pred = this.assertionRepo.getById(assertion.supersedesId);
      if (!pred) {
        errors.push(`supersedesId "${assertion.supersedesId}" does not reference an existing assertion`);
      } else {
        if (pred.namespace !== assertion.namespace) {
          errors.push(
            `cross-namespace supersession not supported: predecessor "${pred.id}" is in namespace "${pred.namespace}", new assertion is in "${assertion.namespace}"`,
          );
        }
        if (assertion.validFrom <= pred.validFrom) {
          errors.push(`new.validFrom (${assertion.validFrom}) must be > predecessor.validFrom (${pred.validFrom})`);
        }
        if (pred.validUntil !== null && pred.validUntil !== assertion.validFrom) {
          errors.push(
            `predecessor "${pred.id}" already closed at validUntil=${pred.validUntil}; cannot supersede with validFrom=${assertion.validFrom}`,
          );
        }
      }
    }

    if (options.collectErrors === undefined && errors.length > 0) throw new ValidationError(errors, 'Assertion');
  }

  /**
   * Citation-excerpt policy, owned by the store so a replaced `validators`
   * array cannot bypass it. Per inline citation with a null excerpt: collect a
   * `ValidationError` under `validation.requireCitationExcerpt`, otherwise emit
   * `TRGT_CITATION_EXCERPT_MISSING`. Mirrors `writeCitation()`'s late-citation
   * check.
   */
  private enforceCitationExcerptPolicy(
    assertion: NormalizedNewAssertion,
    options: { collectErrors?: string[] } = {},
  ): void {
    const strict = this.options.validation?.requireCitationExcerpt ?? false;
    const errors = options.collectErrors ?? [];
    for (const cit of assertion.citations) {
      if (cit.excerpt === null) {
        if (strict) {
          errors.push(`citation "${cit.id}" excerpt is required`);
        } else {
          this.options.logger.warn('TRGT_CITATION_EXCERPT_MISSING', {
            assertionId: assertion.id,
            citationId: cit.id,
          });
        }
      }
    }
    if (options.collectErrors === undefined && errors.length > 0) throw new ValidationError(errors, 'Assertion');
  }

  private validateTemporalSnapshotOptions(options: TemporalSnapshotOptions): void {
    const anchorError = finiteNumberError(options.atPosition, 'atPosition');
    if (anchorError) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_TEMPORAL_ANCHOR, anchorError);
    if (options.entityTypes !== undefined) {
      const err = stringArrayOptionError(options.entityTypes, 'entityTypes');
      if (err) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_FILTER, err);
    }
    if (options.assertionTypes !== undefined) {
      const err = stringArrayOptionError(options.assertionTypes, 'assertionTypes');
      if (err) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_FILTER, err);
    }
  }

  private normalizeAssertionInput(input: NewAssertionInput): NormalizedNewAssertion {
    return {
      ...input,
      validUntil: input.validUntil ?? null,
      supersedesId: input.supersedesId ?? null,
      entityId: input.entityId ?? null,
      entityType: input.entityType ?? null,
    };
  }

  private requireInit(): void {
    this.requireNotClosed();
    if (!this.initialized) {
      throw new NamespaceNotInitializedError(this.options.namespace);
    }
  }

  private requireNotClosed(operation?: string): void {
    if (this.closed || this.closing) throw new StoreClosedError(operation);
  }

  private async trackOperation<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    this.requireNotClosed(operation);
    this.inFlightOperations++;
    try {
      return await fn();
    } finally {
      this.inFlightOperations--;
      if (this.inFlightOperations === 0) {
        const waiters = this.inFlightWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }

  private async waitForInFlightOperations(): Promise<void> {
    if (this.inFlightOperations === 0) return;
    await new Promise<void>((resolve) => {
      this.inFlightWaiters.push(resolve);
    });
  }

  private requireNamespaceInit(namespace: string): void {
    this.requireInit();
    if (!this.namespaceRepo.get(namespace)) {
      throw new NamespaceNotInitializedError(namespace);
    }
  }

  private clearStaleNamespaceLocks(now = Date.now()): void {
    const staleBefore = new Date(now - NAMESPACE_LOCK_STALE_MS).toISOString();
    const result = this.db
      .prepare('DELETE FROM trageti_namespace_locks WHERE COALESCE(heartbeat_at, acquired_at) < ?')
      .run(staleBefore);
    if (result.changes > 0) {
      this.options.logger.warn('TRGT_NAMESPACE_LOCK_STALE_CLEARED', { count: result.changes });
    }
  }

  private namespaceLock(namespace: string): { operation: string; owner: string; acquired_at: string; heartbeat_at: string | null } | null {
    return (
      this.db
        .prepare<[string], { operation: string; owner: string; acquired_at: string; heartbeat_at: string | null }>(
          'SELECT operation, owner, acquired_at, heartbeat_at FROM trageti_namespace_locks WHERE namespace = ?',
        )
        .get(namespace) ?? null
    );
  }

  private requireNamespaceUnlocked(namespace: string, operation: string): void {
    this.clearStaleNamespaceLocks();
    const lock = this.namespaceLock(namespace);
    if (!lock) return;
    throw new TragetiError(
      ErrorCode.NAMESPACE_OPERATION_LOCKED,
      `Namespace "${namespace}" is locked by ${lock.operation}; cannot run ${operation}.`,
    );
  }

  private acquireNamespaceOperationLock(namespace: string, operation: string): string {
    this.clearStaleNamespaceLocks();
    const owner = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO trageti_namespace_locks (namespace, operation, owner, acquired_at, heartbeat_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(namespace, operation, owner, new Date().toISOString(), new Date().toISOString());
      return owner;
    } catch {
      const lock = this.namespaceLock(namespace);
      throw new ReindexError(namespace, 0, `namespace locked by ${lock?.operation ?? 'another operation'}`, {
        code: ErrorCode.REINDEX_ALREADY_RUNNING,
        advice: 'wait for the existing namespace operation to finish, then retry',
      });
    }
  }

  private releaseNamespaceOperationLock(namespace: string, owner: string): void {
    this.db.prepare('DELETE FROM trageti_namespace_locks WHERE namespace = ? AND owner = ?').run(namespace, owner);
  }

  private refreshNamespaceOperationLock(namespace: string, owner: string): void {
    this.db
      .prepare('UPDATE trageti_namespace_locks SET heartbeat_at = ? WHERE namespace = ? AND owner = ?')
      .run(new Date().toISOString(), namespace, owner);
  }

  private warmExtensionCache(): void {
    const tables: Array<'trageti_assertions' | 'trageti_episodes' | 'trageti_links'> = [
      'trageti_assertions',
      'trageti_episodes',
      'trageti_links',
    ];
    for (const table of tables) {
      const cols = this.extensionApplier.getExtensionColumns(this.db, table);
      this.extensionColumnCache.set(table, cols);
    }
  }

  private validateAssertionForWrite(
    assertion: NormalizedNewAssertion,
    options: {
      inFlightEpisodeIds?: ReadonlySet<string>;
      collectErrors?: string[];
      errorPrefix?: string;
    } = {},
  ): void {
    const errors = options.collectErrors ?? [];
    const before = errors.length;
    this.enforceStructuralInvariants(assertion, {
      ...(options.inFlightEpisodeIds !== undefined && { inFlightEpisodeIds: options.inFlightEpisodeIds }),
      collectErrors: errors,
    });
    this.enforceCitationExcerptPolicy(assertion, { collectErrors: errors });
    for (const validator of this.options.validators) {
      if (options.inFlightEpisodeIds !== undefined && validator instanceof DefaultAssertionValidator) continue;
      const result = validator.validate(assertion);
      if (!result.valid) errors.push(...result.errors);
    }
    if (options.errorPrefix && errors.length > before) {
      for (let i = before; i < errors.length; i++) {
        errors[i] = `${options.errorPrefix}${errors[i]}`;
      }
    }
    if (options.collectErrors === undefined && errors.length > 0) throw new ValidationError(errors, 'Assertion');
  }

  private validateLinkReferences(
    link: NewAssertionLinkInput,
    errors: string[],
    options: {
      inFlightAssertionIds?: ReadonlySet<string>;
      inFlightEpisodeIds?: ReadonlySet<string>;
    } = {},
  ): void {
    const endpoint = (id: string, label: 'fromId' | 'toId'): { namespace: string } | null => {
      if (options.inFlightAssertionIds?.has(id)) return { namespace: link.namespace };
      const assertion = this.assertionRepo.getById(id);
      if (!assertion) {
        errors.push(`link.${label} "${id}" does not reference an existing or bundled assertion`);
        return null;
      }
      return { namespace: assertion.namespace };
    };

    const fromA = endpoint(link.fromId, 'fromId');
    const toA = endpoint(link.toId, 'toId');
    if (fromA && toA && fromA.namespace !== toA.namespace) {
      this.options.logger.warn('TRGT_CROSS_NAMESPACE_LINK', {
        fromNs: fromA.namespace,
        toNs: toA.namespace,
      });
    }

    if (!options.inFlightEpisodeIds?.has(link.sourceEpisodeId)) {
      const sourceEpisode = this.db
        .prepare<[string, string], { id: string }>('SELECT id FROM trageti_episodes WHERE id = ? AND namespace = ?')
        .get(link.sourceEpisodeId, link.namespace);
      if (!sourceEpisode) {
        errors.push(
          `link.sourceEpisodeId "${link.sourceEpisodeId}" does not reference an episode in namespace "${link.namespace}"`,
        );
      }
    }
  }

  private closeSupersededAssertion(assertionId: string, validUntil: number): void {
    if (!this.assertionRepo.supersedeAssertion(assertionId, validUntil)) {
      throw new ValidationError(
        [`Assertion "${assertionId}" is already closed or no longer available for supersession`],
        'Assertion',
      );
    }
  }

  private filterRequestedIndexingIds(
    namespace: string,
    assertionIds: readonly string[],
    options: IndexingStateOptions,
  ): string[] {
    if (assertionIds.length === 0) return [];
    const activeOnly = options.includeSuperseded === true ? '' : 'AND valid_until IS NULL';
    return this.db
      .prepare<[string, string], { id: string }>(
        `SELECT id
         FROM trageti_assertions
         WHERE namespace = ?
           AND id IN (SELECT value FROM json_each(?))
           ${activeOnly}`,
      )
      .all(namespace, buildCandidateJson(assertionIds))
      .map((row) => row.id);
  }

  private ensureVectorReadable(namespace: string): string | null {
    const config = this.namespaceRepo.get(namespace);
    if (!config) throw new NamespaceNotInitializedError(namespace);
    const table = this.namespaceRepo.getEmbeddingTable(namespace);
    if (config.embeddingDimension === null || !table) {
      throw new RetrievalInputError(
        ErrorCode.RETRIEVAL_NAMESPACE_VECTORLESS,
        `Namespace "${namespace}" is vectorless; use retrievalStrategy: 'bm25' or upgrade the namespace first.`,
      );
    }
    if (!this.isSqliteVecLoaded()) {
      throw new MissingPeerDependencyError('sqlite-vec', 'npm install sqlite-vec', "use retrievalStrategy: 'bm25'");
    }
    if (!this.embeddingRepo.tableExists(table)) {
      this.options.logger.debug('TRGT_RETRIEVE_VECTOR_TABLE_MISSING', { namespace, table });
      return null;
    }
    return table;
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
    const config = this.namespaceRepo.get(namespace);
    if (!config) throw new NamespaceNotInitializedError(namespace);
    const table = this.namespaceRepo.getEmbeddingTable(namespace);
    if (config.embeddingDimension === null || !table) {
      if (kind === 'indexing') {
        throw new IndexingError(
          ErrorCode.INDEXING_NAMESPACE_VECTORLESS,
          `Namespace "${namespace}" is vectorless; call upgradeNamespaceToVector() before indexing.`,
        );
      }
      throw new RetrievalInputError(
        ErrorCode.RETRIEVAL_NAMESPACE_VECTORLESS,
        `Namespace "${namespace}" is vectorless; use retrievalStrategy: 'bm25' or upgrade the namespace first.`,
      );
    }
    if (!this.isSqliteVecLoaded()) {
      throw new MissingPeerDependencyError(
        'sqlite-vec',
        'npm install sqlite-vec',
        kind === 'retrieval' ? "use retrievalStrategy: 'bm25'" : 'load sqlite-vec or use vectorless namespaces',
      );
    }
    if (!this.embeddingRepo.tableExists(table)) {
      this.embeddingRepo.ensureVec0Table(table, config.embeddingDimension);
    }
    return table;
  }

  /** Returns true when sqlite-vec's vec_version() function is callable. */
  private isSqliteVecLoaded(): boolean {
    if (this.sqliteVecLoaded === true) return true;
    try {
      this.db.prepare('SELECT vec_version() AS v').get();
      this.sqliteVecLoaded = true;
    } catch {
      this.sqliteVecLoaded = false;
    }
    return this.sqliteVecLoaded;
  }

  /**
   * Reconcile an explicitly-supplied `fts5Tokenizer` against the tokenizer
   * already recorded in the database (spec — tokenizer changes are never
   * silently ignored). No-op when the caller did not supply a tokenizer, or
   * when it matches the stored one. When it differs:
   *   - assertions exist → throw `MigrationCompatibilityError` (fail closed);
   *     the caller must run `rebuildFts()` to re-tokenize the corpus.
   *   - zero assertions → safely rebuild the empty FTS table under the new
   *     tokenizer (nothing to re-tokenize).
   */
  private reconcileFtsTokenizer(): void {
    if (!this.fts5TokenizerExplicit) return;
    const stored = this.readStoredTokenizer();
    if (!stored) return;
    const want = this.options.fts5Tokenizer;
    const same =
      stored.tokenizer === want.tokenizer &&
      JSON.stringify(stored.tokenizerArgs ?? []) === JSON.stringify(want.tokenizerArgs ?? []);
    if (same) return;

    const count = this.db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM trageti_assertions').get()?.c ?? 0;
    if (count > 0) {
      throw new MigrationCompatibilityError(
        'rebuild-fts',
        `The database's FTS index is tokenized with "${stored.tokenizer}" but the store was ` +
          `opened with fts5Tokenizer "${want.tokenizer}". Changing the tokenizer on a populated ` +
          `database requires an explicit rebuild — call store.rebuildFts({ tokenizer }).`,
        { command: 'store.rebuildFts({ tokenizer })', estimatedRows: count },
      );
    }
    // Empty database — no corpus to re-tokenize, so adopt the new tokenizer.
    this.applyFtsTokenizer(want);
  }

  /**
   * Drop and recreate `trageti_fulltext` under `tokenizer`, repopulate from
   * `trageti_assertions`, and record the tokenizer in `trageti_tokenizer` —
   * all in one transaction. The sync triggers reference the table by name, so
   * they survive the drop/recreate. Mirrors the DDL `rebuildFts()` runs.
   */
  private applyFtsTokenizer(tokenizer: FTS5TokenizerConfig): void {
    const tokenizeArg = buildFtsTokenizeArg(tokenizer);
    this.db.transaction(() => {
      this.db.exec('DROP TABLE IF EXISTS trageti_fulltext');
      this.db.exec(`
        CREATE VIRTUAL TABLE trageti_fulltext USING fts5(
          assertion_id UNINDEXED,
          content,
          content='trageti_assertions',
          content_rowid='rowid',
          tokenize='${tokenizeArg}'
        );
      `);
      this.db.exec(
        'INSERT INTO trageti_fulltext(rowid, assertion_id, content) SELECT rowid, id, content FROM trageti_assertions',
      );
      this.db
        .prepare(
          `INSERT INTO trageti_tokenizer (id, tokenizer, tokenizer_args, updated_at)
           VALUES (1, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET tokenizer = excluded.tokenizer,
                                         tokenizer_args = excluded.tokenizer_args,
                                         updated_at = excluded.updated_at`,
        )
        .run(tokenizer.tokenizer, JSON.stringify(tokenizer.tokenizerArgs ?? []));
    })();
  }

  /**
   * The tokenizer config currently recorded in the `trageti_tokenizer`
   * metadata table — the source of truth for "what is the FTS index actually
   * tokenized with". Returns null if the row is somehow absent.
   */
  private readStoredTokenizer(): FTS5TokenizerConfig | null {
    const row = this.db
      .prepare<
        [],
        { tokenizer: string; tokenizer_args: string }
      >('SELECT tokenizer, tokenizer_args FROM trageti_tokenizer WHERE id = 1')
      .get();
    if (!row) return null;
    return {
      tokenizer: row.tokenizer,
      tokenizerArgs: JSON.parse(row.tokenizer_args) as string[],
    };
  }
}
