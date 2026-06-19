import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basenameForTemp(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function readJsonOrNull<T>(
  path: string,
  validate: (value: unknown, path: string) => T,
  options: { quarantineInvalid?: boolean } = {},
): T | null {
  if (!existsSync(path)) return null;
  try {
    return validate(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
  } catch {
    if (options.quarantineInvalid !== false) quarantineFile(path);
    return null;
  }
}

export function readJsonStrict<T>(path: string, validate: (value: unknown, path: string) => T): T {
  const value = readJsonOrNull(path, validate, { quarantineInvalid: true });
  if (value === null) throw new Error(`${path} is missing or invalid; run the prepare phase again.`);
  return value;
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForJson(value));
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortForJson(nested)]),
  );
}

function quarantineFile(path: string): void {
  if (!existsSync(path)) return;
  const target = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(path, target);
}

function basenameForTemp(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? 'state';
}
