/**
 * v0.3 logging surface.
 *
 * Public API:
 *   - Logger interface (debug/info/warn/error) — caller-supplied; defaults to ConsoleLogger.
 *   - ConsoleLogger — writes warn/error records to stderr; debug/info are silent.
 *   - NoopLogger — drops everything.
 *
 * Internal helpers:
 *   - structuredWarn(code, meta) — back-compat shim that routes through the
 *     active default-process logger for code paths that have not yet been
 *     plumbed with a TemporalStore-scoped logger.
 *   - emitOnce(code, scopeKey) — registers a one-shot suppression key so
 *     "once per process" warnings (TRGT_MOCK_PROVIDER_NON_PRODUCTION,
 *     TRGT_DEPRECATED_USAGE per-symbol, etc.) do not flood.
 */

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(code: string, fields?: LogFields): void;
  info(code: string, fields?: LogFields): void;
  warn(code: string, fields?: LogFields): void;
  error(code: string, fields?: LogFields): void;
  /** Optional. When present, called from TemporalStore.close(). */
  flush?(): void | Promise<void>;
}

export interface Metrics {
  incr(name: string, fields?: Record<string, string | number>): void;
  observe(name: string, value: number, fields?: Record<string, string | number>): void;
}

function formatFields(fields?: LogFields): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const s = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
    parts.push(`${k}=${s}`);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

function emit(level: string, code: string, fields?: LogFields): void {
  process.stderr.write(`[trageti:${level}] code=${code}${formatFields(fields)}\n`);
}

export class ConsoleLogger implements Logger {
  debug(_code: string, _fields?: LogFields): void {
    /* silent — debug/info emit only when callers wrap a more verbose logger */
  }
  info(_code: string, _fields?: LogFields): void {
    /* silent */
  }
  warn(code: string, fields?: LogFields): void {
    emit('warn', code, fields);
  }
  error(code: string, fields?: LogFields): void {
    emit('error', code, fields);
  }
}

export class NoopLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

// ─── Once-per-process suppression ───────────────────────────────────────────

const emittedOnce = new Set<string>();

/** Returns true if this is the first time the key has been seen this process. */
export function emitOnce(key: string): boolean {
  if (emittedOnce.has(key)) return false;
  emittedOnce.add(key);
  return true;
}

/** Test-only: reset the once-suppression registry. Not exported from package. */
export function resetEmitOnceRegistry(): void {
  emittedOnce.clear();
}

// ─── Process-default logger ─────────────────────────────────────────────────
//
// Audit note (R9 §4.4): every store-internal log call routes through the
// per-store `Logger` — `TemporalStore` threads `this.options.logger` into the
// connection verifier (`verify(db, logger)`), the auto-installed
// `DefaultAssertionValidator` (`{ logger }`), and all repository/pipeline code.
// The process-default below is NOT a store fallback; it exists only for
// default components constructed *standalone* (a `DefaultAssertionValidator` or
// `DefaultConnectionVerifier` created directly without a `logger` option) and
// for `MockEmbeddingProvider`, whose one-shot non-production warning fires at
// module scope before any store exists. `TemporalStore`'s constructor still
// calls `setDefaultLogger` so even those standalone fallbacks honor the most
// recent store's logger. Known limitation: with multiple stores the
// process-default reflects whichever was constructed last — acceptable, since
// it only affects standalone default components, never plumbed store calls.

let defaultLogger: Logger = new ConsoleLogger();

/** Internal: replace the process-default logger. Called by every
 *  `TemporalStore` constructor so standalone default components (see audit
 *  note above) honor the user's chosen logger. */
export function setDefaultLogger(logger: Logger): void {
  defaultLogger = logger;
}

export function getDefaultLogger(): Logger {
  return defaultLogger;
}

/** Phase-1 shim. Routes to the process-default logger as a warn. */
export function structuredWarn(code: string, meta: Record<string, string | number | boolean>): void {
  defaultLogger.warn(`TRGT_${code}`, meta);
}

// ─── Metrics no-op guard ────────────────────────────────────────────────────

/**
 * Safe-call wrapper for optional metrics. Avoids allocation when metrics is
 * unset (spec §1111-1121: "no default implementation; emission is a no-op
 * that must not allocate fallback collectors or write to the logger").
 */
export function incr(metrics: Metrics | undefined, name: string, fields?: Record<string, string | number>): void {
  if (metrics) metrics.incr(name, fields);
}

export function observe(
  metrics: Metrics | undefined,
  name: string,
  value: number,
  fields?: Record<string, string | number>,
): void {
  if (metrics) metrics.observe(name, value, fields);
}
