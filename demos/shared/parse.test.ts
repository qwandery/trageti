import { describe, expect, it } from 'vitest';
import { parseExtraction } from './parse.js';

describe('parseExtraction', () => {
  it('reports non-JSON extraction responses with a concise preview', () => {
    const raw = `\u001B[31m${'not json '.repeat(80)}`;

    expect(() => parseExtraction(raw)).toThrow(/no JSON object in response \(\d+ chars\): not json/);
    expect(() => parseExtraction(raw)).not.toThrow(/not json (?:not json ){40}/);
  });

  it('reports malformed JSON with a concise preview', () => {
    const raw = `{"assertions":[${' '.repeat(300)}}`;

    expect(() => parseExtraction(raw)).toThrow(/JSON\.parse failed/);
    expect(() => parseExtraction(raw)).not.toThrow(/ {200}/);
  });
});
