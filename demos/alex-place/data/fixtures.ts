import { citationSources } from './sources.js';

type AssertionFixture = {
  id: string;
  namespace: string;
  type: string;
  content: string;
  validFrom: number;
  confidence: number;
  sourceEpisodeId: string;
  supersedesId?: string | null;
  entityId?: string | null;
  entityType?: string | null;
  citations: Array<{
    id: string;
    episodeId: string;
    sourceRef: string;
    excerpt: null;
    excerptStart: string;
    excerptEnd: string;
  }>;
};

type LinkFixture = {
  id: string;
  namespace: string;
  fromId: string;
  toId: string;
  linkType: string;
  validFrom: number;
  validUntil: null;
  sourceEpisodeId: string;
};

const NAMESPACE = 'alex-journal';

function citation(
  id: string,
  episodeId: string,
  sourceRef: string,
  quoteText: string,
): AssertionFixture['citations'][number] {
  const baseRef = sourceRef.split('#')[0] ?? sourceRef;
  const source = citationSources[baseRef];
  if (!source) throw new Error(`missing citation source ${sourceRef}`);
  const start = source.indexOf(quoteText);
  if (start < 0) throw new Error(`quote not found in ${sourceRef}: ${quoteText}`);
  return {
    id,
    episodeId,
    sourceRef,
    excerpt: null,
    excerptStart: String(start),
    excerptEnd: String(start + quoteText.length),
  };
}

function assertion(
  input: Omit<AssertionFixture, 'namespace' | 'validFrom' | 'sourceEpisodeId'> & {
    episodeId: string;
    position: number;
  },
): AssertionFixture {
  const { episodeId, position, ...rest } = input;
  return {
    ...rest,
    namespace: NAMESPACE,
    validFrom: position,
    sourceEpisodeId: episodeId,
    supersedesId: rest.supersedesId ?? null,
    entityId: rest.entityId ?? null,
    entityType: rest.entityType ?? null,
  };
}

function link(input: Omit<LinkFixture, 'namespace' | 'validUntil'>): LinkFixture {
  return { ...input, namespace: NAMESPACE, validUntil: null };
}

const byEpisode: Record<string, { assertions: AssertionFixture[]; links: LinkFixture[] }> = {
  'journal-1': {
    assertions: [
      assertion({
        id: 'a-journal-1-0',
        episodeId: 'journal-1',
        position: 1,
        type: 'fact',
        content: 'Alex started a sourdough starter with flour and water in a jar.',
        confidence: 0.95,
        entityId: 'alex-sourdough',
        citations: [
          citation('c-a-journal-1-0', 'journal-1', 'alex.md#2026-01-05', 'Mixed flour and water in a jar tonight.'),
        ],
      }),
      assertion({
        id: 'a-journal-1-1',
        episodeId: 'journal-1',
        position: 1,
        type: 'absence',
        content: 'Alex references Dad briefly, but the journal does not dwell on him directly.',
        confidence: 0.35,
        entityId: 'alex-father',
        citations: [
          citation('c-a-journal-1-1', 'journal-1', 'alex.md#2026-01-05', "Dad would've made fun of me for the jar."),
        ],
      }),
    ],
    links: [],
  },
  'journal-2': {
    assertions: [
      assertion({
        id: 'a-journal-2-0',
        episodeId: 'journal-2',
        position: 2,
        type: 'fact',
        content:
          "Alex's first sourdough bake was dense and too sour, with cold retard, mature levain, and hydration all suspected.",
        confidence: 0.9,
        entityId: 'alex-sourdough',
        citations: [
          citation(
            'c-a-journal-2-0',
            'journal-2',
            'alex.md#2026-01-20',
            'Lined up my suspects: cold retard probably ran too long, the levain is very mature at this point, and the hydration was maybe too low for the crumb I was going for.',
          ),
        ],
      }),
    ],
    links: [],
  },
  'ref-field': {
    assertions: [
      assertion({
        id: 'a-ref-field-0',
        episodeId: 'ref-field',
        position: 3,
        type: 'fact',
        content:
          'Sourdough acidity is governed by starter maturity, inoculation, fermentation time, and temperature schedule rather than one dial.',
        confidence: 0.95,
        entityId: 'sourdough-fermentation',
        citations: [
          citation(
            'c-a-ref-field-0',
            'ref-field',
            'references/field-fermentation.md',
            'Sourness in a finished loaf is not the property of any one variable; it is\nthe sum of starter maturity, inoculation rate, total fermentation time, and\nthe temperature schedule across bulk and proof.',
          ),
        ],
      }),
    ],
    links: [],
  },
  'journal-4': {
    assertions: [
      assertion({
        id: 'a-journal-4-0',
        episodeId: 'journal-4',
        position: 4,
        type: 'update',
        content:
          "Shorter bulk, no cold retard, and younger levain brought Alex's sourdough acidity to target with this starter.",
        confidence: 0.9,
        supersedesId: 'a-journal-2-0',
        entityId: 'alex-sourdough',
        citations: [
          citation(
            'c-a-journal-4-0',
            'journal-4',
            'alex.md#2026-02-08',
            'I shortened the bulk, dropped the cold retard entirely, and used a younger levain. Acidity dropped down to where I wanted it.',
          ),
        ],
      }),
      assertion({
        id: 'a-journal-4-1',
        episodeId: 'journal-4',
        position: 4,
        type: 'qualifies',
        content: 'Alex does not yet know whether the improved sourdough technique transfers beyond this starter.',
        confidence: 0.8,
        entityId: 'alex-sourdough',
        citations: [
          citation(
            'c-a-journal-4-1',
            'journal-4',
            'alex.md#2026-02-08',
            'At least with this starter, I do not know yet if the technique transfers.',
          ),
        ],
      }),
    ],
    links: [
      link({
        id: 'link-journal-4-0',
        fromId: 'a-ref-field-0',
        toId: 'a-journal-4-0',
        linkType: 'contextualizes',
        validFrom: 4,
        sourceEpisodeId: 'journal-4',
      }),
      link({
        id: 'link-journal-4-1',
        fromId: 'a-journal-4-1',
        toId: 'a-journal-4-0',
        linkType: 'qualifies',
        validFrom: 4,
        sourceEpisodeId: 'journal-4',
      }),
    ],
  },
  'journal-5': {
    assertions: [
      assertion({
        id: 'a-journal-5-0',
        episodeId: 'journal-5',
        position: 5,
        type: 'fact',
        content:
          'Kintaro ramen broth was milky because fat and gelatin were suspended through it, not just floating on top.',
        confidence: 0.9,
        entityId: 'miso-ramen-broth',
        citations: [
          citation(
            'c-a-journal-5-0',
            'journal-5',
            'alex.md#2026-02-15',
            'Fat AND gelatin suspended through it, both, not just an emulsified fat slick on top.',
          ),
        ],
      }),
    ],
    links: [],
  },
  'journal-6': {
    assertions: [
      assertion({
        id: 'a-journal-6-0',
        episodeId: 'journal-6',
        position: 6,
        type: 'fact',
        content: 'Alex learned pinch grip and claw hand but found high rocking cuts awkward with a santoku.',
        confidence: 0.85,
        entityId: 'alex-knife-skills',
        citations: [
          citation(
            'c-a-journal-6-0',
            'journal-6',
            'alex.md#2026-02-23',
            'The grip makes sense, but the rocking motion felt wrong with my santoku, like I was fighting the blade instead of guiding it.',
          ),
        ],
      }),
    ],
    links: [],
  },
  'journal-7': {
    assertions: [
      assertion({
        id: 'a-journal-7-0',
        episodeId: 'journal-7',
        position: 7,
        type: 'fact',
        content:
          'Alex first ramen broth attempt was thin and weak, likely from short cook time, water ratio, and insufficient boil.',
        confidence: 0.88,
        entityId: 'miso-ramen-broth',
        citations: [
          citation(
            'c-a-journal-7-0',
            'journal-7',
            'alex.md#2026-03-01',
            'The broth was thin and cloudy but not the right kind of cloudy. Jordan said it tasted like pork water.',
          ),
        ],
      }),
    ],
    links: [],
  },
  'journal-8': {
    assertions: [
      assertion({
        id: 'a-journal-8-0',
        episodeId: 'journal-8',
        position: 8,
        type: 'update',
        content:
          'Alex learned that a santoku often works better with push cuts, chops, and shorter slicing than with high rocking.',
        confidence: 0.9,
        supersedesId: 'a-journal-6-0',
        entityId: 'alex-knife-skills',
        citations: [
          citation(
            'c-a-journal-8-0',
            'journal-8',
            'alex.md#2026-03-06',
            "a santoku's flatter profile often works better with push cuts, chops, and shorter slicing motions than with a high rock.",
          ),
        ],
      }),
    ],
    links: [],
  },
  'ref-ito': {
    assertions: [
      assertion({
        id: 'a-ref-ito-0',
        episodeId: 'ref-ito',
        position: 9,
        type: 'fact',
        content: 'A sustained rolling boil disperses fat, gelatin, and tiny solids into paitan broth suspension.',
        confidence: 0.95,
        entityId: 'paitan-broth',
        citations: [
          citation(
            'c-a-ref-ito-0',
            'ref-ito',
            'references/ito-paitan.md',
            'A sustained rolling boil helps disperse fat, gelatin, and tiny protein-rich solids through the liquid.',
          ),
        ],
      }),
    ],
    links: [
      link({
        id: 'link-ref-ito-0',
        fromId: 'a-ref-ito-0',
        toId: 'a-journal-7-0',
        linkType: 'contextualizes',
        validFrom: 9,
        sourceEpisodeId: 'ref-ito',
      }),
    ],
  },
  'journal-10': {
    assertions: [
      assertion({
        id: 'a-journal-10-0',
        episodeId: 'journal-10',
        position: 10,
        type: 'regression',
        content: "Alex's whole wheat sourdough failed because hydration was not yet adjusted for the flour.",
        confidence: 0.85,
        entityId: 'alex-sourdough',
        citations: [
          citation(
            'c-a-journal-10-0',
            'journal-10',
            'alex.md#2026-03-18',
            'The whole wheat flour wrecked everything: dense, gummy, would not rise properly.',
          ),
        ],
      }),
    ],
    links: [],
  },
  'journal-11': {
    assertions: [
      assertion({
        id: 'a-journal-11-0',
        episodeId: 'journal-11',
        position: 11,
        type: 'fact',
        content:
          'Kansui is probably part of the ramen noodle texture Alex is missing, but flour, hydration, sheeting, and resting also matter.',
        confidence: 0.8,
        entityId: 'ramen-noodles',
        citations: [
          citation(
            'c-a-journal-11-0',
            'journal-11',
            'alex.md#2026-03-25',
            'Kansui is probably part of what I am missing, but it cannot be the whole thing. Flour, hydration, sheeting, resting.',
          ),
        ],
      }),
    ],
    links: [],
  },
  'journal-12': {
    assertions: [
      assertion({
        id: 'a-journal-12-0',
        episodeId: 'journal-12',
        position: 12,
        type: 'update',
        content: 'An eight-hour rolling boil made Alex ramen broth white, thick, and dramatically closer to Kintaro.',
        confidence: 0.92,
        supersedesId: 'a-journal-7-0',
        entityId: 'miso-ramen-broth',
        citations: [
          citation(
            'c-a-journal-12-0',
            'journal-12',
            'alex.md#2026-04-02',
            'Rolling boil for eight hours. The broth is white and thick. It coats the back of a spoon.',
          ),
        ],
      }),
    ],
    links: [
      link({
        id: 'link-journal-12-0',
        fromId: 'a-ref-ito-0',
        toId: 'a-journal-12-0',
        linkType: 'contextualizes',
        validFrom: 12,
        sourceEpisodeId: 'journal-12',
      }),
    ],
  },
  'journal-13': {
    assertions: [
      assertion({
        id: 'a-journal-13-0',
        episodeId: 'journal-13',
        position: 13,
        type: 'update',
        content:
          "Eighty percent hydration works for Alex's current whole wheat flour, but bread-flour technique does not transfer directly.",
        confidence: 0.9,
        supersedesId: 'a-journal-10-0',
        entityId: 'alex-sourdough',
        citations: [
          citation(
            'c-a-journal-13-0',
            'journal-13',
            'alex.md#2026-04-09',
            'Eighty percent hydration works for this whole wheat flour. The bread finally rose and the crumb was not gummy.',
          ),
        ],
      }),
    ],
    links: [
      link({
        id: 'link-journal-13-0',
        fromId: 'a-journal-13-0',
        toId: 'a-journal-4-0',
        linkType: 'qualifies',
        validFrom: 13,
        sourceEpisodeId: 'journal-13',
      }),
    ],
  },
  'journal-14': {
    assertions: [
      assertion({
        id: 'a-journal-14-0',
        episodeId: 'journal-14',
        position: 14,
        type: 'fact',
        content: 'At the first dinner party, Sam thought Alex bread was a little sour.',
        confidence: 0.9,
        entityId: 'sam-feedback',
        citations: [
          citation(
            'c-a-journal-14-0',
            'journal-14',
            'alex.md#2026-04-16',
            'Sam said the bread was a little sour for him.',
          ),
        ],
      }),
      assertion({
        id: 'a-journal-14-1',
        episodeId: 'journal-14',
        position: 14,
        type: 'pattern',
        content: 'Jordan preference at the first dinner points toward simpler dishes being strongest.',
        confidence: 0.75,
        entityId: 'jordan-feedback',
        citations: [
          citation(
            'c-a-journal-14-1',
            'journal-14',
            'alex.md#2026-04-16',
            'Jordan said the salad dressing was the best thing on the table.',
          ),
        ],
      }),
      assertion({
        id: 'a-journal-14-2',
        episodeId: 'journal-14',
        position: 14,
        type: 'fact',
        content: 'Priya explained Maillard browning while discussing Alex chicken skin at the first dinner party.',
        confidence: 0.88,
        entityId: 'maillard-browning',
        citations: [
          citation(
            'c-a-journal-14-2',
            'journal-14',
            'alex.md#2026-04-16',
            'Priya explained Maillard browning offhand while talking about the chicken skin, and I started taking mental notes.',
          ),
        ],
      }),
    ],
    links: [],
  },
  'ref-maillard': {
    assertions: [
      assertion({
        id: 'a-ref-maillard-0',
        episodeId: 'ref-maillard',
        position: 15,
        type: 'fact',
        content: 'Maillard browning depends on dry surface heat, enough time, proteins, and reducing sugars.',
        confidence: 0.95,
        entityId: 'maillard-browning',
        citations: [
          citation(
            'c-a-ref-maillard-0',
            'ref-maillard',
            'references/maillard-browning.md',
            'Maillard browning needs dry surface heat, enough time, and the right reactants: proteins and reducing sugars.',
          ),
        ],
      }),
    ],
    links: [
      link({
        id: 'link-ref-maillard-0',
        fromId: 'a-ref-maillard-0',
        toId: 'a-journal-14-2',
        linkType: 'contextualizes',
        validFrom: 15,
        sourceEpisodeId: 'ref-maillard',
      }),
    ],
  },
  'journal-16': {
    assertions: [
      assertion({
        id: 'a-journal-16-0',
        episodeId: 'journal-16',
        position: 16,
        type: 'regression',
        content: 'Alex baked-baking-soda noodle experiment produced rubbery texture and slightly metallic flavor.',
        confidence: 0.88,
        entityId: 'ramen-noodles',
        citations: [
          citation(
            'c-a-journal-16-0',
            'journal-16',
            'alex.md#2026-04-25',
            'The texture was rubbery and the flavor was slightly metallic.',
          ),
        ],
      }),
    ],
    links: [
      link({
        id: 'link-journal-16-0',
        fromId: 'a-journal-16-0',
        toId: 'a-journal-11-0',
        linkType: 'qualifies',
        validFrom: 16,
        sourceEpisodeId: 'journal-16',
      }),
    ],
  },
  'journal-17': {
    assertions: [
      assertion({
        id: 'a-journal-17-0',
        episodeId: 'journal-17',
        position: 17,
        type: 'contradicts',
        content: 'Mrs. Park says Alex kimchi jjigae recipe has too much sugar and not enough gochugaru.',
        confidence: 0.9,
        entityId: 'mrs-park-feedback',
        citations: [
          citation(
            'c-a-journal-17-0',
            'journal-17',
            'alex.md#2026-05-05',
            'Later she said the recipe had too much sugar and not enough gochugaru.',
          ),
        ],
      }),
      assertion({
        id: 'a-journal-17-1',
        episodeId: 'journal-17',
        position: 17,
        type: 'fact',
        content: 'Mrs. Park teaches that aged kimchi is the base of kimchi jjigae, not a garnish.',
        confidence: 0.92,
        entityId: 'mrs-park-feedback',
        citations: [
          citation(
            'c-a-journal-17-1',
            'journal-17',
            'alex.md#2026-05-05',
            'Mrs. Park said aged kimchi is the base, not a garnish.',
          ),
        ],
      }),
    ],
    links: [],
  },
  'journal-18': {
    assertions: [
      assertion({
        id: 'a-journal-18-0',
        episodeId: 'journal-18',
        position: 18,
        type: 'resolution',
        content: 'Alex corrected kimchi jjigae with older kimchi, more gochugaru, and much less sugar.',
        confidence: 0.9,
        supersedesId: 'a-journal-17-0',
        entityId: 'kimchi-jjigae',
        citations: [
          citation(
            'c-a-journal-18-0',
            'journal-18',
            'alex.md#2026-05-20',
            'Used older kimchi, more gochugaru, and much less sugar.',
          ),
        ],
      }),
    ],
    links: [
      link({
        id: 'link-journal-18-0',
        fromId: 'a-journal-17-1',
        toId: 'a-journal-18-0',
        linkType: 'contextualizes',
        validFrom: 18,
        sourceEpisodeId: 'journal-18',
      }),
    ],
  },
  'journal-19': {
    assertions: [
      assertion({
        id: 'a-journal-19-0',
        episodeId: 'journal-19',
        position: 19,
        type: 'fact',
        content: 'Mrs. Park teaches Alex to toast miso for tare, making the flavor more dimensional.',
        confidence: 0.92,
        entityId: 'mrs-park-feedback',
        citations: [
          citation(
            'c-a-journal-19-0',
            'journal-19',
            'alex.md#2026-05-27',
            'Mrs. Park watched me make the tare and said, gently, toast the miso first.',
          ),
        ],
      }),
    ],
    links: [],
  },
  'journal-20': {
    assertions: [
      assertion({
        id: 'a-journal-20-0',
        episodeId: 'journal-20',
        position: 20,
        type: 'resolution',
        content: 'At the third dinner party, Sam says Alex sourdough is perfect.',
        confidence: 0.95,
        supersedesId: 'a-journal-14-0',
        entityId: 'sam-feedback',
        citations: [
          citation('c-a-journal-20-0', 'journal-20', 'alex.md#2026-06-03', 'Sam said the sourdough was perfect.'),
        ],
      }),
      assertion({
        id: 'a-journal-20-1',
        episodeId: 'journal-20',
        position: 20,
        type: 'fact',
        content: 'Priya notices Alex improved knife work at the third dinner party.',
        confidence: 0.9,
        entityId: 'alex-knife-skills',
        citations: [
          citation('c-a-journal-20-1', 'journal-20', 'alex.md#2026-06-03', 'Priya noticed my knife work had improved.'),
        ],
      }),
      assertion({
        id: 'a-journal-20-2',
        episodeId: 'journal-20',
        position: 20,
        type: 'pattern',
        content: 'Jordan again validates simple food by making the best salad dressing.',
        confidence: 0.8,
        entityId: 'jordan-feedback',
        citations: [
          citation(
            'c-a-journal-20-2',
            'journal-20',
            'alex.md#2026-06-03',
            'Jordan made the salad dressing this time and it was better than mine.',
          ),
        ],
      }),
    ],
    links: [
      link({
        id: 'link-journal-20-0',
        fromId: 'a-journal-20-0',
        toId: 'a-journal-4-0',
        linkType: 'measures',
        validFrom: 20,
        sourceEpisodeId: 'journal-20',
      }),
      link({
        id: 'link-journal-20-1',
        fromId: 'a-journal-20-2',
        toId: 'a-journal-14-1',
        linkType: 'deepens',
        validFrom: 20,
        sourceEpisodeId: 'journal-20',
      }),
    ],
  },
};

export const fixtures: Record<string, string> = Object.fromEntries(
  Object.entries(byEpisode).map(([episodeId, value]) => [episodeId, JSON.stringify(value)]),
);
