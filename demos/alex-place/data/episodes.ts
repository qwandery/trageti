// Committed episode stand-ins for the alex-place skeleton. In the full demo
// these would be derived from alex.md by a chunking/segmentation step; for the
// skeleton they are hand-written and short.

import type { Episode } from 'trageti'

export const NAMESPACE = 'alex-journal'

export const episodes: ReadonlyArray<Omit<Episode, 'createdAt'>> = [
  {
    id: 'journal-1',
    namespace: NAMESPACE,
    position: 1,
    occurredAt: '2026-01-05T20:00:00Z',
    type: 'journal',
    content:
      'Started the sourdough starter — flour and water in a jar. Mention of doing this at ' +
      'school before "everything stopped." Brief offhand reference to Dad and the jar.',
  },
  {
    id: 'journal-2',
    namespace: NAMESPACE,
    position: 2,
    occurredAt: '2026-01-20T21:00:00Z',
    type: 'journal',
    content:
      'First real bake. Dense and way too sour. Alex suspects multiple causes: a long cold ' +
      'retard, a very mature levain (refreshed twice daily for two weeks), and possibly ' +
      'too-low hydration for the desired crumb. Not blaming any one variable.',
  },
  {
    id: 'ref-field',
    namespace: NAMESPACE,
    position: 3,
    occurredAt: '2026-01-22T10:00:00Z',
    type: 'reference',
    content:
      'Mara Field, Sourdough Notes — chapter on fermentation acidity. Acidity in a finished ' +
      'loaf is the sum of starter maturity, inoculation rate, total fermentation time, and ' +
      'temperature schedule. No single dial. The productive move is rarely to isolate one ' +
      'variable; look at the schedule end to end.',
  },
  {
    id: 'journal-4',
    namespace: NAMESPACE,
    position: 4,
    occurredAt: '2026-02-08T18:00:00Z',
    type: 'journal',
    content:
      'Room-temp proof bake. Open crumb, mild flavor, light tang. Alex shortened bulk, ' +
      'dropped the cold retard, and used a younger levain. Acidity dropped to the target — ' +
      'at least with this starter; technique transferability is still unknown.',
  },
  {
    id: 'journal-5',
    namespace: NAMESPACE,
    position: 5,
    occurredAt: '2026-02-15T22:00:00Z',
    type: 'journal',
    content:
      'Ate miso ramen at Kintaro. Broth was opaque and almost milky — fat AND gelatin ' +
      'suspended through it, not just an emulsified fat slick on top. The vigorous boil ' +
      'pulled body out of the bones.',
  },
]
