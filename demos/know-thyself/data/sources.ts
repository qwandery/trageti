import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const citationSources: Readonly<Record<string, string>> = {
  'sources/kf-1.md': readFileSync(join(here, 'sources', 'kf-1.md'), 'utf8'),
  'sources/kf-1..kf-2.md': readFileSync(join(here, 'sources', 'kf-1..kf-2.md'), 'utf8'),
  'sources/kf-2..kf-3.md': readFileSync(join(here, 'sources', 'kf-2..kf-3.md'), 'utf8'),
}
