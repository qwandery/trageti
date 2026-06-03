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

  it('appends sanitized LLM stream text without adding trace headers', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const trace = createLlmTraceOptions(['node', 'demo', '--llm-trace=full'], {});
      trace.append?.('hello\u001B[31m world');
      expect(log).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledWith('hello world');
    } finally {
      log.mockRestore();
      write.mockRestore();
    }
  });

  it('accepts --llm-trace-full as an alias for full trace mode', () => {
    const trace = createLlmTraceOptions(['node', 'demo', '--llm-trace-full'], {});

    expect(trace.enabled).toBe(true);
    expect(trace.includePayloads).toBe(true);
  });

  it('updates LLM status in place and clears it before normal trace logs', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const originalColumns = process.stdout.columns;
    try {
      Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 60 });
      const trace = createLlmTraceOptions(['node', 'demo', '--llm-trace'], {});
      trace.status?.('stream progress: 1 chunk with a long status that should be trimmed before wrapping');
      trace.status?.('stream progress: 2 chunks with a long status that should be trimmed before wrapping');
      trace.log('complete');

      const writes = write.mock.calls.map((call) => String(call[0]));
      expect(writes.filter((value) => value.startsWith('\r[LLM '))).toHaveLength(2);
      expect(writes.filter((value) => value.startsWith('\r[LLM ')).every((value) => value.length <= 61)).toBe(true);
      expect(writes.some((value) => /^\r +\r$/.test(value))).toBe(true);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('[LLM '));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('complete'));
    } finally {
      Object.defineProperty(process.stdout, 'columns', { configurable: true, value: originalColumns });
      log.mockRestore();
      write.mockRestore();
    }
  });
});
