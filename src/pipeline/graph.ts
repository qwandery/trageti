import type { Database } from 'better-sqlite3'
import type {
  Assertion,
  AssertionLink,
  GraphQueryAdapter,
  GraphAdapterTraversalOptions,
  PathOptions,
  TraversalOptions,
} from '../domain/types.js'
import type { AssertionRepository } from '../db/repositories/AssertionRepository.js'

const DEFAULT_CONNECTED_DEPTH = 3
const DEFAULT_PATH_DEPTH = 5

/** Build the adapter-facing options from public store options, defaulting maxDepth. */
function toAdapterOptions(
  options: TraversalOptions | PathOptions,
  defaultDepth: number,
): GraphAdapterTraversalOptions {
  return {
    temporalAnchor: options.temporalAnchor,
    maxDepth: options.maxDepth ?? defaultDepth,
    ...(options.linkTypes !== undefined && { linkTypes: options.linkTypes }),
    ...(options.includeSuperseded !== undefined && {
      includeSuperseded: options.includeSuperseded,
    }),
  }
}

export function getConnected(
  db: Database,
  assertionRepo: AssertionRepository,
  adapter: GraphQueryAdapter,
  options: TraversalOptions,
): Assertion[] {
  const links = adapter.findConnected(
    db,
    options.namespace,
    [options.fromAssertionId],
    toAdapterOptions(options, DEFAULT_CONNECTED_DEPTH),
  )

  // Collect the distinct destination assertions reached by traversal — the
  // `toId` of each link — excluding the origin itself (spec §677).
  const ids = [...new Set(links.map((l) => l.toId))].filter((id) => id !== options.fromAssertionId)

  return ids.map((id) => assertionRepo.getById(id)).filter((a): a is Assertion => a !== null)
}

export function findPath(
  db: Database,
  adapter: GraphQueryAdapter,
  options: PathOptions,
): AssertionLink[] | null {
  return adapter.findPath(
    db,
    options.namespace,
    options.fromAssertionId,
    options.toAssertionId,
    toAdapterOptions(options, DEFAULT_PATH_DEPTH),
  )
}
