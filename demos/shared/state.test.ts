import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicWriteJson, readJsonOrNull } from './state.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('atomic demo state files', () => {
  it('writes and reads JSON through a validator', () => {
    const dir = tempDir();
    const path = join(dir, 'state.json');

    atomicWriteJson(path, { version: 1, value: 'ok' });

    expect(readJsonOrNull(path, validateState)).toEqual({ version: 1, value: 'ok' });
  });

  it('quarantines invalid JSON and returns null', () => {
    const dir = tempDir();
    const path = join(dir, 'state.json');
    writeFileSync(path, '{not-json');

    expect(readJsonOrNull(path, validateState)).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true);
  });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trageti-state-'));
  dirs.push(dir);
  return dir;
}

function validateState(value: unknown, path: string): { version: 1; value: string } {
  if (value === null || typeof value !== 'object') throw new Error(`${path} must be an object`);
  const row = value as { version?: unknown; value?: unknown };
  if (row.version !== 1 || typeof row.value !== 'string') throw new Error(`${path} is invalid`);
  return { version: 1, value: row.value };
}
