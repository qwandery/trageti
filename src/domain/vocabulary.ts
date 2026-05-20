export const RecommendedAssertionTypes = Object.freeze({
  FACT: 'fact',
  UPDATE: 'update',
  RECONTEXTUALIZATION: 'recontextualization',
  RESOLUTION: 'resolution',
  REGRESSION: 'regression',
  ABSENCE: 'absence',
  PATTERN: 'pattern',
} as const)

export type RecommendedAssertionType =
  (typeof RecommendedAssertionTypes)[keyof typeof RecommendedAssertionTypes]

/**
 * Recommended link-type vocabulary. Two families:
 *
 *   Structural / sequential — relationships about the *position* of an
 *   assertion in a sequence (RELATED, GENERATIVE, INHIBITORY, SEQUENTIAL,
 *   SUPERSEDES). These were in v0.1.
 *
 *   Accumulation — relationships about how new information *layers on* an
 *   earlier assertion without replacing it (DEEPENS, CONTRADICTS,
 *   CONTEXTUALIZES, QUALIFIES, MEASURES). New in v0.2.
 *
 * The library treats `linkType` as an opaque string; the vocabulary is a
 * recommendation, not enforcement. The accumulation family was added in v0.2
 * to give callers a clearly-named alternative to overusing `supersedesId`
 * for nuanced layering — replacement removes the predecessor from snapshot
 * retrieval; layering keeps both assertions valid and connects them by link.
 */
export const RecommendedLinkTypes = Object.freeze({
  // Structural / sequential
  RELATED: 'related',
  GENERATIVE: 'generative',
  INHIBITORY: 'inhibitory',
  SEQUENTIAL: 'sequential',
  SUPERSEDES: 'supersedes',
  // Accumulation (v0.2)
  DEEPENS: 'deepens',
  CONTRADICTS: 'contradicts',
  CONTEXTUALIZES: 'contextualizes',
  QUALIFIES: 'qualifies',
  MEASURES: 'measures',
} as const)

export type RecommendedLinkType = (typeof RecommendedLinkTypes)[keyof typeof RecommendedLinkTypes]
