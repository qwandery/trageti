import { describe, expect, it } from 'vitest';
import { alexPlaceScenario } from './scenario.js';
import { createLlmTraceOptions } from '../shared/output.js';

describe('alex-place preparation', () => {
  it('prepares journal units with only the matching journal section as citation context', async () => {
    const artifact = await alexPlaceScenario.prepare({
      argv: ['node', 'demo', 'alex-place', 'prepare'],
      env: {},
      trace: createLlmTraceOptions(['node', 'demo'], {}),
      logger: noopLogger(),
      artifactPath: 'prepared.json',
    });

    const unit = artifact.units.find((candidate) => candidate.id === 'journal-1');

    expect(unit?.citationSources).toEqual({
      'alex.md#2026-01-05': expect.stringContaining('Mixed flour and water'),
    });
    expect(unit?.citationSources['alex.md#2026-01-05']).not.toContain('2026-01-20');
    expect(unit?.document).toBe('Alex starts a sourdough starter and briefly references Dad and the jar.');
  });
});

function noopLogger() {
  return {
    step() {},
    detail() {},
    success() {},
  };
}
