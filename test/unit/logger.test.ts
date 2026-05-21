import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ConsoleLogger,
  NoopLogger,
  emitOnce,
  resetEmitOnceRegistry,
  structuredWarn,
  setDefaultLogger,
  getDefaultLogger,
  incr,
  observe,
} from '../../src/internal/logger.js'
import type { Logger, Metrics } from '../../src/internal/logger.js'

afterEach(() => {
  vi.restoreAllMocks()
  resetEmitOnceRegistry()
  setDefaultLogger(new ConsoleLogger())
})

describe('ConsoleLogger', () => {
  it('writes warn and error records to stderr; debug and info are silent', () => {
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    })
    const logger = new ConsoleLogger()
    logger.debug('TRGT_DEBUG')
    logger.info('TRGT_INFO')
    logger.warn('TRGT_WARN', { namespace: 'ns', count: 3 })
    logger.error('TRGT_ERROR')
    expect(writes.some((w) => w.includes('TRGT_DEBUG'))).toBe(false)
    expect(writes.some((w) => w.includes('TRGT_INFO'))).toBe(false)
    expect(writes.some((w) => w.includes('TRGT_WARN') && w.includes('namespace=ns'))).toBe(true)
    expect(writes.some((w) => w.includes('TRGT_ERROR'))).toBe(true)
  })

  it('skips undefined field values and serialises objects', () => {
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    })
    new ConsoleLogger().warn('TRGT_FIELDS', { a: undefined, b: { nested: 1 } })
    const line = writes.join('')
    expect(line).not.toContain('a=')
    expect(line).toContain('b={"nested":1}')
  })
})

describe('NoopLogger', () => {
  it('drops every level without writing to stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const logger: Logger = new NoopLogger()
    logger.debug('x')
    logger.info('x')
    logger.warn('x')
    logger.error('x')
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('emitOnce / resetEmitOnceRegistry', () => {
  it('returns true only the first time a key is seen', () => {
    expect(emitOnce('unit-key')).toBe(true)
    expect(emitOnce('unit-key')).toBe(false)
    resetEmitOnceRegistry()
    expect(emitOnce('unit-key')).toBe(true)
  })
})

describe('structuredWarn / default logger', () => {
  it('routes through the active default logger with a TRGT_ prefix', () => {
    const warn = vi.fn()
    setDefaultLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() })
    expect(getDefaultLogger()).toBeDefined()
    structuredWarn('SOMETHING', { namespace: 'ns' })
    expect(warn).toHaveBeenCalledWith('TRGT_SOMETHING', { namespace: 'ns' })
  })
})

describe('metrics guards', () => {
  it('incr / observe are no-ops when metrics is undefined', () => {
    expect(() => incr(undefined, 'm')).not.toThrow()
    expect(() => observe(undefined, 'm', 1)).not.toThrow()
  })

  it('incr / observe forward to a supplied Metrics sink', () => {
    const incrFn = vi.fn()
    const observeFn = vi.fn()
    const metrics: Metrics = { incr: incrFn, observe: observeFn }
    incr(metrics, 'trageti.count', { count: 2 })
    observe(metrics, 'trageti.ms', 42)
    expect(incrFn).toHaveBeenCalledWith('trageti.count', { count: 2 })
    expect(observeFn).toHaveBeenCalledWith('trageti.ms', 42, undefined)
  })
})
