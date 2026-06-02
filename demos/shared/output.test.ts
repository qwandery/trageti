import { describe, expect, it, vi } from 'vitest';
import { printAssembledAnswer } from './output.js';

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
