// Committed extraction-output stand-ins, raw-JSON ExtractionResult per episode.
// fixtures[episodeId] is the exact string the fixture extractor returns for that
// episode (keyed by episode ID, not call index).

export const fixtures: Record<string, string> = {
  'journal-1': JSON.stringify({
    assertions: [
      {
        id: 'a-journal-1-0',
        namespace: 'alex-journal',
        type: 'fact',
        content: 'Alex started a sourdough starter — flour and water in a jar.',
        validFrom: 1,
        confidence: 0.95,
        sourceEpisodeId: 'journal-1',
        entityId: 'alex-sourdough',
        citations: [
          {
            id: 'c-a-journal-1-0',
            episodeId: 'journal-1',
            sourceRef: 'alex.md 2026-01-05',
            excerpt: 'Mixed flour and water in a jar tonight.',
          },
        ],
      },
      {
        id: 'a-journal-1-1',
        namespace: 'alex-journal',
        type: 'absence',
        content: 'Alex references their father obliquely; the journal does not dwell on him directly.',
        validFrom: 1,
        confidence: 0.3,
        sourceEpisodeId: 'journal-1',
        entityId: 'alex-father',
        citations: [
          {
            id: 'c-a-journal-1-1',
            episodeId: 'journal-1',
            sourceRef: 'alex.md 2026-01-05',
            excerpt: "Dad would've made fun of me for the jar.",
          },
        ],
      },
    ],
    links: [],
  }),
  'journal-2': JSON.stringify({
    assertions: [
      {
        id: 'a-journal-2-0',
        namespace: 'alex-journal',
        type: 'fact',
        content:
          "Alex's first sourdough bake was dense and too sour. Suspected causes: a long cold retard, a very mature levain (twice-daily refresh for two weeks), and possibly too-low hydration. No single variable identified.",
        validFrom: 2,
        confidence: 0.85,
        sourceEpisodeId: 'journal-2',
        entityId: 'alex-sourdough',
        citations: [
          {
            id: 'c-a-journal-2-0',
            episodeId: 'journal-2',
            sourceRef: 'alex.md 2026-01-20',
            excerpt:
              'Lined up my suspects: cold retard probably ran too long, the levain is very mature at this point ... and the hydration was maybe too low',
          },
        ],
      },
    ],
    links: [],
  }),
  'ref-field': JSON.stringify({
    assertions: [
      {
        id: 'a-ref-field-0',
        namespace: 'alex-journal',
        type: 'fact',
        content:
          'Acidity in a finished sourdough loaf is the sum of starter maturity, inoculation rate, total fermentation time, and temperature schedule. There is no single dial.',
        validFrom: 3,
        confidence: 0.95,
        sourceEpisodeId: 'ref-field',
        entityId: 'sourdough-fermentation',
        citations: [
          {
            id: 'c-a-ref-field-0',
            episodeId: 'ref-field',
            sourceRef: 'Field — Sourdough Notes, fermentation chapter',
            excerpt:
              'Sourness in a finished loaf is not the property of any one variable; it is the sum of starter maturity, inoculation rate, total fermentation time, and the temperature schedule',
          },
        ],
      },
    ],
    links: [],
  }),
  'journal-4': JSON.stringify({
    assertions: [
      {
        id: 'a-journal-4-0',
        namespace: 'alex-journal',
        type: 'update',
        content:
          'Shortening the bulk, dropping the cold retard, and using a younger levain brought sourdough acidity to the target — at least with this starter. Technique transferability is still unknown.',
        validFrom: 4,
        confidence: 0.9,
        sourceEpisodeId: 'journal-4',
        supersedesId: 'a-journal-2-0',
        entityId: 'alex-sourdough',
        citations: [
          {
            id: 'c-a-journal-4-0',
            episodeId: 'journal-4',
            sourceRef: 'alex.md 2026-02-08',
            excerpt:
              'I shortened the bulk, dropped the cold retard entirely, and used a younger levain. Acidity dropped down to where I wanted it.',
          },
        ],
      },
    ],
    links: [
      {
        id: 'link-journal-4-0',
        namespace: 'alex-journal',
        fromId: 'a-ref-field-0',
        toId: 'a-journal-4-0',
        linkType: 'contextualizes',
        validFrom: 4,
        validUntil: null,
        sourceEpisodeId: 'journal-4',
      },
    ],
  }),
  'journal-5': JSON.stringify({
    assertions: [
      {
        id: 'a-journal-5-0',
        namespace: 'alex-journal',
        type: 'fact',
        content:
          'Opaque miso ramen broth at Kintaro: fat AND gelatin suspended through it, with body the vigorous boil pulled from the bones — not just an emulsified fat slick on top.',
        validFrom: 5,
        confidence: 0.9,
        sourceEpisodeId: 'journal-5',
        entityId: 'miso-ramen-broth',
        citations: [
          {
            id: 'c-a-journal-5-0',
            episodeId: 'journal-5',
            sourceRef: 'alex.md 2026-02-15',
            excerpt:
              'Fat AND gelatin suspended through it, both — not just an emulsified fat slick on top.',
          },
        ],
      },
    ],
    links: [],
  }),
}
