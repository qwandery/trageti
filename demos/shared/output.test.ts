import { describe, expect, it, vi } from 'vitest';
import { createDemoLogger, createLlmTraceOptions, printAssembledAnswer } from './output.js';

describe('printAssembledAnswer', () => {
  it('prints context metadata and sanitizes synthesized text', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let printed = '';
    try {
      printAssembledAnswer({
        text: 'Safe answer.\u001B[31m',
        mode: 'template',
        context: {
          includedAssertions: 2,
          totalAssertions: 4,
          tokenEstimate: 50,
          truncated: true,
          positionRange: { from: 1, to: 3 },
        },
      });
      printed = log.mock.calls.map((call) => call.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(printed).toContain('Assembled-context answer');
    expect(printed).toContain('2 of 4 assertion(s)');
    expect(printed).toContain('truncated');
    expect(printed).toContain('Safe answer.');
    expect(printed).not.toContain('\u001B');
  });
});

describe('demo timing prefixes', () => {
  it('prints wall-clock and elapsed time on standard logger entries', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let printed = '';
    try {
      const logger = createDemoLogger();
      logger.step('Preparing data');
      logger.detail('Resolved inputs');
      logger.success('Done');
      printed = log.mock.calls.map((call) => call.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(printed).toMatch(/\[\d{2}:\d{2}:\d{2} \+\d{2}:\d{2}\.\d\] \[1\] Preparing data/);
    expect(printed).toMatch(/\s+\[\d{2}:\d{2}:\d{2} \+\d{2}:\d{2}\.\d\] Resolved inputs/);
    expect(printed).toMatch(/\s+\[\d{2}:\d{2}:\d{2} \+\d{2}:\d{2}\.\d\] OK Done/);
  });

  it('prints wall-clock and elapsed time on LLM trace headers', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let printed = '';
    try {
      const trace = createLlmTraceOptions(['node', 'demo', '--llm-trace'], {});
      trace.log('request started');
      printed = log.mock.calls.map((call) => call.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }

    expect(printed).toMatch(/\[LLM \[\d{2}:\d{2}:\d{2} \+\d{2}:\d{2}\.\d\]\]/);
    expect(printed).toContain('request started');
  });
});
