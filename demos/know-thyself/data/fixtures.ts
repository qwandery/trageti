// Committed extraction-output stand-ins, raw-JSON ExtractionResult per episode.
// fixtures[episodeId] is the exact string the fixture extractor returns for that
// episode (keyed by episode ID, not call index).

export const fixtures: Record<string, string> = {
  'kf-1': JSON.stringify({
    assertions: [
      {
        id: 'a-kf-1-0',
        namespace: 'trageti-history',
        type: 'fact',
        content:
          'v0.1 uses a weighted hybrid scoring formula combining semantic similarity, BM25, and recency.',
        validFrom: 1,
        confidence: 0.9,
        sourceEpisodeId: 'kf-1',
        citations: [
          {
            id: 'c-a-kf-1-0',
            episodeId: 'kf-1',
            sourceRef: 'sources/kf-1.md',
            excerpt: null,
            excerptStart: '1341',
            excerptEnd: '1421',
          },
        ],
      },
      {
        id: 'a-kf-1-1',
        namespace: 'trageti-history',
        type: 'fact',
        content: 'The temporal model in v0.1 uses an Episode.sequenceNumber ordinal field.',
        validFrom: 1,
        confidence: 0.95,
        sourceEpisodeId: 'kf-1',
        citations: [
          {
            id: 'c-a-kf-1-1',
            episodeId: 'kf-1',
            sourceRef: 'sources/kf-1.md',
            excerpt: null,
            excerptStart: '965',
            excerptEnd: '987',
          },
        ],
      },
      {
        id: 'a-kf-1-2',
        namespace: 'trageti-history',
        type: 'fact',
        content:
          'v0.1 supports retrieval by namespace with optional vector signals and a temporal anchor position.',
        validFrom: 1,
        confidence: 0.9,
        sourceEpisodeId: 'kf-1',
        citations: [
          {
            id: 'c-a-kf-1-2',
            episodeId: 'kf-1',
            sourceRef: 'sources/kf-1.md',
            excerpt: null,
            excerptStart: '699',
            excerptEnd: '728',
          },
        ],
      },
    ],
    links: [],
  }),
  'kf-2': JSON.stringify({
    assertions: [
      {
        id: 'a-kf-2-0',
        namespace: 'trageti-history',
        type: 'fact',
        content:
          'Citations are introduced as an optional but recommended field on assertions, supporting source traceability.',
        validFrom: 2,
        confidence: 0.9,
        sourceEpisodeId: 'kf-2',
        citations: [
          {
            id: 'c-a-kf-2-0',
            episodeId: 'kf-2',
            sourceRef: 'sources/kf-1..kf-2.md',
            excerpt: null,
            excerptStart: '2540',
            excerptEnd: '2689',
          },
        ],
      },
      {
        id: 'a-kf-2-1',
        namespace: 'trageti-history',
        type: 'update',
        content:
          'The temporal field sequenceNumber is renamed to position and generalized; callers define their own ordinal scheme.',
        validFrom: 2,
        confidence: 0.95,
        sourceEpisodeId: 'kf-2',
        supersedesId: 'a-kf-1-1',
        citations: [
          {
            id: 'c-a-kf-2-1',
            episodeId: 'kf-2',
            sourceRef: 'sources/kf-1..kf-2.md',
            excerpt: null,
            excerptStart: '2721',
            excerptEnd: '2758',
          },
        ],
      },
      {
        id: 'a-kf-2-2',
        namespace: 'trageti-history',
        type: 'fact',
        content:
          'Trajectory retrieval mode is added so callers can reconstruct supersession chains across an entity history.',
        validFrom: 2,
        confidence: 0.9,
        sourceEpisodeId: 'kf-2',
        citations: [
          {
            id: 'c-a-kf-2-2',
            episodeId: 'kf-2',
            sourceRef: 'sources/kf-1..kf-2.md',
            excerpt: null,
            excerptStart: '2831',
            excerptEnd: '2938',
          },
        ],
      },
    ],
    links: [
      {
        id: 'link-kf-2-0',
        namespace: 'trageti-history',
        fromId: 'a-kf-2-2',
        toId: 'a-kf-1-2',
        linkType: 'deepens',
        validFrom: 2,
        validUntil: null,
        sourceEpisodeId: 'kf-2',
      },
    ],
  }),
  'kf-3': JSON.stringify({
    assertions: [
      {
        id: 'a-kf-3-0',
        namespace: 'trageti-history',
        type: 'update',
        content:
          'v0.3 reworks the DefaultScorer into a four-case formula with weight renormalization across the vector and BM25 signals.',
        validFrom: 3,
        confidence: 0.95,
        sourceEpisodeId: 'kf-3',
        supersedesId: 'a-kf-1-0',
        citations: [
          {
            id: 'c-a-kf-3-0',
            episodeId: 'kf-3',
            sourceRef: 'sources/kf-2..kf-3.md',
            excerpt: null,
            excerptStart: '1754',
            excerptEnd: '1830',
          },
        ],
      },
      {
        id: 'a-kf-3-1',
        namespace: 'trageti-history',
        type: 'update',
        content:
          'Citations become a structural invariant: every assertion carries at least one citation. Foreign key enforcement and structural validation guard the store end to end.',
        validFrom: 3,
        confidence: 0.95,
        sourceEpisodeId: 'kf-3',
        supersedesId: 'a-kf-2-0',
        citations: [
          {
            id: 'c-a-kf-3-1',
            episodeId: 'kf-3',
            sourceRef: 'sources/kf-2..kf-3.md',
            excerpt: null,
            excerptStart: '2012',
            excerptEnd: '2060',
          },
        ],
      },
    ],
    links: [],
  }),
}
