import type { FTS5TokenizerConfig } from '../domain/types.js'
import { MigrationCompatibilityError, SchemaExtensionError } from '../errors/index.js'

/**
 * FTS5 tokenizers trageti is willing to embed into `CREATE VIRTUAL TABLE`
 * DDL. The tokenizer name and its args are interpolated into a SQL string,
 * so they are validated against an allow-list and a strict character class
 * before any DDL is generated — unless the caller opts out with
 * `trustedCustomTokenizer: true`.
 */
const ALLOWED_TOKENIZERS = new Set(['unicode61', 'ascii', 'porter', 'trigram'])

/** Tokenizer args may only contain word characters, `=`, and `-`. */
const SAFE_ARG = /^[A-Za-z0-9_=-]+$/

/**
 * Where `validateTokenizer` was called — selects the typed error for a
 * rejected tokenizer:
 *  - `'init'` (store / migration setup) → `SchemaExtensionError` (spec §986)
 *  - `'rebuild'` (`rebuildFts`) → `MigrationCompatibilityError` (spec §2348)
 */
export type TokenizerValidationContext = 'init' | 'rebuild'

/**
 * Validate an FTS5 tokenizer config before any DDL is generated. A
 * `trustedCustomTokenizer: true` config passes through unvalidated (the
 * caller's explicit opt-out). Otherwise the tokenizer name must be built-in
 * and each arg must match the safe character class.
 */
export function validateTokenizer(
  config: FTS5TokenizerConfig,
  context: TokenizerValidationContext,
): void {
  // Trusted custom tokenizer — the caller takes responsibility; no allow-list
  // check, no arg validation.
  if (config.trustedCustomTokenizer === true) return

  const reject = (message: string, details: Record<string, unknown>): never => {
    if (context === 'init') throw new SchemaExtensionError([message])
    throw new MigrationCompatibilityError('fts-tokenizer', message, details)
  }

  if (!ALLOWED_TOKENIZERS.has(config.tokenizer)) {
    reject(
      `FTS5 tokenizer "${config.tokenizer}" is not a built-in tokenizer. ` +
        `Allowed: ${[...ALLOWED_TOKENIZERS].join(', ')}. ` +
        `Set trustedCustomTokenizer: true to use a vetted custom tokenizer.`,
      { tokenizer: config.tokenizer },
    )
  }
  for (const arg of config.tokenizerArgs ?? []) {
    if (!SAFE_ARG.test(arg)) {
      reject(
        `FTS5 tokenizer argument "${arg}" contains characters that are not safe to embed in DDL.`,
        { tokenizer: config.tokenizer, arg },
      )
    }
  }
}
