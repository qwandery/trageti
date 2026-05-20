import type { FTS5TokenizerConfig } from '../domain/types.js'
import { MigrationCompatibilityError } from '../errors/index.js'

/**
 * FTS5 tokenizers trageti is willing to embed into `CREATE VIRTUAL TABLE`
 * DDL. The tokenizer name and its args are interpolated into a SQL string,
 * so they are validated against an allow-list and a strict character class
 * before any DDL is generated (spec — tokenizer config is validated before
 * migration DDL is built, never inside a migration body).
 */
const ALLOWED_TOKENIZERS = new Set(['unicode61', 'ascii', 'porter', 'trigram'])

/** Tokenizer args may only contain word characters, asterisk, and spaces. */
const SAFE_ARG = /^[A-Za-z0-9_* ]+$/

/**
 * Validate an FTS5 tokenizer config. Throws `MigrationCompatibilityError`
 * (kind `'fts-tokenizer'`) when the tokenizer name is not on the allow-list
 * or an arg contains characters that are unsafe to interpolate into DDL.
 */
export function validateTokenizer(config: FTS5TokenizerConfig): void {
  if (!ALLOWED_TOKENIZERS.has(config.tokenizer)) {
    throw new MigrationCompatibilityError(
      'fts-tokenizer',
      `FTS5 tokenizer "${config.tokenizer}" is not supported. Allowed: ${[...ALLOWED_TOKENIZERS].join(', ')}.`,
      { tokenizer: config.tokenizer },
    )
  }
  for (const arg of config.tokenizerArgs ?? []) {
    if (!SAFE_ARG.test(arg)) {
      throw new MigrationCompatibilityError(
        'fts-tokenizer',
        `FTS5 tokenizer argument "${arg}" contains characters that are not safe to embed in DDL.`,
        { tokenizer: config.tokenizer, arg },
      )
    }
  }
}
