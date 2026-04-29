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

export const RecommendedLinkTypes = Object.freeze({
  RELATED: 'related',
  GENERATIVE: 'generative',
  INHIBITORY: 'inhibitory',
  SEQUENTIAL: 'sequential',
  SUPERSEDES: 'supersedes',
} as const)

export type RecommendedLinkType =
  (typeof RecommendedLinkTypes)[keyof typeof RecommendedLinkTypes]
