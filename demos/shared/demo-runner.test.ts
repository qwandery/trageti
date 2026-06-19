import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoStageError } from './demo-runner.js';
import { printDemoStageFailure } from './output.js';
import type { DemoScenario } from './demo-runner.js';

const scenario = { name: 'know-thyself', title: 'Know Thyself' } as unknown as DemoScenario;

describe('DemoStageError', () => {
  it('maps a stage to its human title and preserves the cause', () => {
    const cause = new Error('citation offsets invalid');
    const err = new DemoStageError(scenario, 'ingest', cause);

    expect(err.demoTitle).toBe('Know Thyself');
    expect(err.stageTitle).toBe('Ingest');
    expect(err.scenarioName).toBe('know-thyself');
    expect(err.stageName).toBe('ingest');
    expect(err.message).toBe('citation offsets invalid');
    expect(err.cause).toBe(cause);
  });
});

describe('printDemoStageFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints a friendly title, resume command, reason, and details', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cause = new Error('Extraction failed for prepared unit "kf-3"');

    printDemoStageFailure({
      demoTitle: 'Know Thyself',
      stageTitle: 'Ingest',
      scenarioName: 'know-thyself',
      stageName: 'ingest',
      error: cause,
    });

    const output = spy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Know Thyself Demo failed during Stage Ingest.');
    expect(output).toContain('To resume/try again from this point, start the current stage again with:');
    expect(output).toContain('npm run trageti-demo -- know-thyself ingest');
    expect(output).toContain('Reason: Extraction failed for prepared unit "kf-3"');
    expect(output).toContain('Details:');
  });
});
