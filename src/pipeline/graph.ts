import type { Database } from 'better-sqlite3';
import type {
  Assertion,
  AssertionLink,
  GraphQueryAdapter,
  GraphAdapterTraversalOptions,
  PathOptions,
  TraversalOptions,
} from '../domain/types.js';
import type { AssertionRepository } from '../db/repositories/AssertionRepository.js';
import type { LinkRepository } from '../db/repositories/LinkRepository.js';
import { DEFAULT_GRAPH_CONNECTED_DEPTH, DEFAULT_GRAPH_PATH_DEPTH } from '../internal/retrieval-defaults.js';
import { ErrorCode, RetrievalInputError } from '../errors/index.js';
import { finiteNumberError, nonNegativeIntegerOptionError, stringArrayOptionError } from '../internal/validate.js';

function validateTraversalOptions(options: TraversalOptions | PathOptions): void {
  const anchorError = finiteNumberError(options.temporalAnchor, 'temporalAnchor');
  if (anchorError) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_TEMPORAL_ANCHOR, anchorError);
  if (options.linkTypes !== undefined) {
    const err = stringArrayOptionError(options.linkTypes, 'linkTypes');
    if (err) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_FILTER, err);
  }
  const { maxDepth } = options;
  if (maxDepth === undefined) return;
  const err = nonNegativeIntegerOptionError(maxDepth, 'maxDepth');
  if (err) throw new RetrievalInputError(ErrorCode.RETRIEVAL_INVALID_MAX_DEPTH, err);
}

/** Build the adapter-facing options from public store options, defaulting maxDepth. */
function toAdapterOptions(options: TraversalOptions | PathOptions, defaultDepth: number): GraphAdapterTraversalOptions {
  return {
    temporalAnchor: options.temporalAnchor,
    maxDepth: options.maxDepth ?? defaultDepth,
    ...(options.linkTypes !== undefined && { linkTypes: options.linkTypes }),
    ...(options.includeSuperseded !== undefined && {
      includeSuperseded: options.includeSuperseded,
    }),
  };
}

export function getConnected(
  db: Database,
  assertionRepo: AssertionRepository,
  adapter: GraphQueryAdapter,
  options: TraversalOptions,
): Assertion[] {
  validateTraversalOptions(options);
  const links = adapter.findConnected(
    db,
    options.namespace,
    [options.fromAssertionId],
    toAdapterOptions(options, DEFAULT_GRAPH_CONNECTED_DEPTH),
  );

  // Collect the distinct destination assertions reached by traversal — the
  // `toId` of each link — excluding the origin itself (spec §677).
  const ids = [...new Set(links.map((l) => l.toId))].filter((id) => id !== options.fromAssertionId);

  const hydrated = assertionRepo.getByIds(ids);
  const byId = new Map(hydrated.map((assertion) => [assertion.id, assertion]));
  return ids.flatMap((id) => {
    const assertion = byId.get(id);
    return assertion ? [assertion] : [];
  });
}

export function findPath(
  db: Database,
  linkRepo: LinkRepository,
  adapter: GraphQueryAdapter,
  options: PathOptions,
): AssertionLink[] | null {
  validateTraversalOptions(options);
  const path = adapter.findPath(
    db,
    options.namespace,
    options.fromAssertionId,
    options.toAssertionId,
    toAdapterOptions(options, DEFAULT_GRAPH_PATH_DEPTH),
  );
  if (path === null) return null;
  const hydrated = linkRepo.getByIds(path.map((link) => link.id));
  const hydratedById = new Map(hydrated.map((link) => [link.id, link]));
  return path.map((link) => hydratedById.get(link.id) ?? { ...link, extensions: link.extensions ?? {} });
}
