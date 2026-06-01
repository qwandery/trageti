import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const refs = [
  'kf-1.md',
  'kf-1..kf-2.md',
  'kf-2..kf-3.md',
  'kf-3..kf-4.md',
  'kf-4..kf-5.md',
  'kf-5..kf-6.md',
  'kf-6..kf-7.md',
  'kf-7..kf-8.md',
  'kf-8..kf-9.md',
  'kf-9..kf-10.md',
] as const;

export const citationSources: Readonly<Record<string, string>> = Object.fromEntries(
  refs.map((ref) => [`sources/${ref}`, readFileSync(join(here, 'sources', ref), 'utf8')]),
);
