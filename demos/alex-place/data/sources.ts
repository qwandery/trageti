import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const citationSources: Readonly<Record<string, string>> = {
  'alex.md': readFileSync(join(here, 'alex.md'), 'utf8'),
  'references/field-fermentation.md': readFileSync(join(here, 'references', 'field-fermentation.md'), 'utf8'),
  'references/gluten-free-sourdough.md': readFileSync(
    join(here, 'references', 'gluten-free-sourdough.md'),
    'utf8',
  ),
  'references/ito-paitan.md': readFileSync(join(here, 'references', 'ito-paitan.md'), 'utf8'),
  'references/maillard-browning.md': readFileSync(join(here, 'references', 'maillard-browning.md'), 'utf8'),
};
