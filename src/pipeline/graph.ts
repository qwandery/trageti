import type { Database } from 'better-sqlite3'
import type { Assertion, AssertionLink, GraphQueryAdapter } from '../domain/types.js'
import type { AssertionRepository } from '../db/repositories/AssertionRepository.js'

export function getConnected(
  db: Database,
  assertionRepo: AssertionRepository,
  adapter: GraphQueryAdapter,
  options: {
    namespace: string
    fromAssertionId: string
    maxDepth?: number
    linkTypes?: string[]
    temporalAnchor: number
  },
): Assertion[] {
  const links = adapter.findConnected(db, options.namespace, [options.fromAssertionId], {
    temporalAnchor: options.temporalAnchor,
    maxDepth: options.maxDepth ?? 3,
    ...(options.linkTypes !== undefined && { linkTypes: options.linkTypes }),
  })

  const ids = [...new Set(links.flatMap((l) => [l.fromId, l.toId]))]
    .filter((id) => id !== options.fromAssertionId)

  return ids
    .map((id) => assertionRepo.getById(id))
    .filter((a): a is Assertion => a !== null)
}

export function findPath(
  db: Database,
  adapter: GraphQueryAdapter,
  options: {
    namespace: string
    fromAssertionId: string
    toAssertionId: string
    maxDepth?: number
    temporalAnchor: number
  },
): AssertionLink[] | null {
  return adapter.findPath(db, options.namespace, options.fromAssertionId, options.toAssertionId, {
    temporalAnchor: options.temporalAnchor,
    maxDepth: options.maxDepth ?? 5,
  })
}
