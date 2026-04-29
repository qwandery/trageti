import { describe, it, expect, beforeEach } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openTestDb } from '../helpers/openTestDb.js'
import { TemporalStore } from '../../src/store/TemporalStore.js'
import { loadScenario } from '../fixtures/scenario.js'

const NS = 'test-ns'
const DIM = 4

describe('TemporalStore — graph traversal', () => {
  let db: Database
  let store: TemporalStore

  beforeEach(() => {
    db = openTestDb()
    store = new TemporalStore(db, { namespace: NS, embeddingDimension: DIM })
    store.init()
    loadScenario(store, NS)
  })

  // Scenario links:
  //   l-1: a-1 → a-2 (related, validFrom=1)
  //   l-2: a-1 → a-3 (sequential, validFrom=5)
  //   l-3: a-2 → a-4 (generative, validFrom=5)
  //   l-4: a-3 → a-5 (sequential, validFrom=10)
  //   l-5: a-6 → a-7 (supersedes, validFrom=5)

  it('getConnected returns directly linked assertions at depth 1', () => {
    const connected = store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-1',
      maxDepth: 1,
      temporalAnchor: 10,
    })
    const ids = connected.map((a) => a.id)
    expect(ids).toContain('a-2')
    expect(ids).toContain('a-3')
    expect(ids).not.toContain('a-1') // source excluded
  })

  it('getConnected respects depth boundary', () => {
    // At depth 1 from a-1, should not include a-4 (a-1→a-2→a-4 is depth 2)
    const depth1 = store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-1',
      maxDepth: 1,
      temporalAnchor: 10,
    })
    expect(depth1.map((a) => a.id)).not.toContain('a-4')

    // At depth 2 from a-1, a-4 should be reachable via a-1→a-2→a-4
    const depth2 = store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-1',
      maxDepth: 2,
      temporalAnchor: 10,
    })
    expect(depth2.map((a) => a.id)).toContain('a-4')
  })

  it('getConnected filters by link type', () => {
    const related = store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-1',
      maxDepth: 1,
      linkTypes: ['related'],
      temporalAnchor: 10,
    })
    const ids = related.map((a) => a.id)
    expect(ids).toContain('a-2')
    expect(ids).not.toContain('a-3') // l-2 is 'sequential', not 'related'
  })

  it('getConnected excludes links with validFrom > temporalAnchor', () => {
    // l-2 has validFrom=5; querying at anchor=4 should exclude it
    const connected = store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-1',
      maxDepth: 1,
      temporalAnchor: 4,
    })
    const ids = connected.map((a) => a.id)
    expect(ids).toContain('a-2') // l-1 validFrom=1, visible at anchor=4
    expect(ids).not.toContain('a-3') // l-2 validFrom=5, not yet valid at anchor=4
  })

  it('getConnected excludes expired links (valid_until <= temporalAnchor)', () => {
    // Add a link that expires at position 8
    store.writeLink({
      id: 'l-temp',
      namespace: NS,
      fromId: 'a-1',
      toId: 'a-5',
      linkType: 'temporary',
      validFrom: 1,
      validUntil: 8,
      sourceEpisodeId: 'ep-1',
    })

    // At anchor=7: link is still valid (validUntil=8 > 7)
    const before = store.getConnected({ namespace: NS, fromAssertionId: 'a-1', maxDepth: 1, temporalAnchor: 7 })
    expect(before.map((a) => a.id)).toContain('a-5')

    // At anchor=8: link has expired (validUntil=8, condition is valid_until > anchor fails for equal)
    const after = store.getConnected({ namespace: NS, fromAssertionId: 'a-1', maxDepth: 1, temporalAnchor: 8 })
    expect(after.map((a) => a.id)).not.toContain('a-5')
  })

  it('findPath returns links on the path between two assertions', () => {
    // a-1 → a-2 (l-1) is a direct 1-hop path
    const path = store.findPath({
      namespace: NS,
      fromAssertionId: 'a-1',
      toAssertionId: 'a-2',
      maxDepth: 3,
      temporalAnchor: 10,
    })
    expect(path).not.toBeNull()
    expect(path!.length).toBeGreaterThan(0)
    // Path should end at a-2
    const lastLink = path![path!.length - 1]!
    expect(lastLink.toId).toBe('a-2')
  })

  it('findPath returns null when no path exists within maxDepth', () => {
    // a-5 has no outgoing links in the fixture — no path from a-5 to a-1
    const path = store.findPath({
      namespace: NS,
      fromAssertionId: 'a-5',
      toAssertionId: 'a-1',
      maxDepth: 5,
      temporalAnchor: 10,
    })
    expect(path).toBeNull()
  })

  it('getConnected returns empty array when no links exist', () => {
    // a-5 has no outgoing links
    const connected = store.getConnected({
      namespace: NS,
      fromAssertionId: 'a-5',
      maxDepth: 3,
      temporalAnchor: 10,
    })
    expect(connected).toEqual([])
  })
})
