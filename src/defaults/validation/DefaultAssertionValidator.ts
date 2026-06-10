import type { Database } from 'better-sqlite3';
import type { AssertionValidator, NormalizedNewAssertion, ValidationResult } from '../../domain/types.js';
import type { Logger } from '../../internal/logger.js';
import { getDefaultLogger } from '../../internal/logger.js';
import { finiteNumberError } from '../../internal/validate.js';

function requiredStringError(value: unknown, label: string): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return `${label} is required`;
  }
  return null;
}

export interface DefaultAssertionValidatorOptions {
  /** When true, citations with null excerpt fail validation. Default false.
   *  Only consulted when `enforceCitationExcerptPolicy` is not false. */
  requireCitationExcerpt?: boolean;
  /** When false, the validator skips citation-excerpt handling entirely
   *  (neither the `requireCitationExcerpt` hard-fail nor the
   *  `TRGT_CITATION_EXCERPT_MISSING` warning). Default true.
   *
   *  `TragetiStore` sets this false on the validator it auto-installs because
   *  the store now owns excerpt policy (it enforces it in `writeAssertion()`
   *  so a custom validators array cannot bypass it) — this prevents a double
   *  warning/error. A `DefaultAssertionValidator` constructed directly keeps
   *  the default `true` and its documented standalone behavior. */
  enforceCitationExcerptPolicy?: boolean;
  /** Store-scoped logger for TRGT_CITATION_EXCERPT_MISSING warnings.
   *  Falls back to the process-default logger when omitted. */
  logger?: Logger;
}

/**
 * Default user-facing validator. Enforces baseline checks (required fields,
 * ranges, FK on sourceEpisodeId) and emits the CITATION_EXCERPT_MISSING
 * warning per citation with a null excerpt.
 *
 * NOTE: structural integrity (citation presence, citation episode namespace,
 * predecessor existence/namespace/ordering) is enforced by
 * TragetiStore.writeAssertion() and runs *before* this validator. This
 * validator does not re-check those — by the time it is reached, the
 * structural invariants have already passed (decision §2 ordering rule).
 */
export class DefaultAssertionValidator implements AssertionValidator {
  private readonly db: Database;
  private readonly requireCitationExcerpt: boolean;
  private readonly enforceCitationExcerptPolicy: boolean;
  private readonly logger: Logger;

  constructor(db: Database, options: DefaultAssertionValidatorOptions = {}) {
    this.db = db;
    this.requireCitationExcerpt = options.requireCitationExcerpt ?? false;
    this.enforceCitationExcerptPolicy = options.enforceCitationExcerptPolicy ?? true;
    this.logger = options.logger ?? getDefaultLogger();
  }

  validate(assertion: NormalizedNewAssertion): ValidationResult {
    const errors: string[] = [];

    for (const [value, label] of [
      [assertion.id, 'id'],
      [assertion.namespace, 'namespace'],
      [assertion.type, 'type'],
      [assertion.content, 'content'],
      [assertion.sourceEpisodeId, 'sourceEpisodeId'],
    ] as const) {
      const err = requiredStringError(value, label);
      if (err) errors.push(err);
    }

    const validFromError = finiteNumberError(assertion.validFrom, 'validFrom');
    if (validFromError) errors.push(validFromError);
    if (assertion.validUntil !== null) {
      const validUntilError = finiteNumberError(assertion.validUntil, 'validUntil');
      if (validUntilError) errors.push(validUntilError);
    }
    if (
      Number.isFinite(assertion.validFrom) &&
      assertion.validUntil !== null &&
      Number.isFinite(assertion.validUntil) &&
      assertion.validUntil <= assertion.validFrom
    ) {
      errors.push('validUntil must be strictly greater than validFrom');
    }

    if (!Number.isFinite(assertion.confidence) || assertion.confidence < 0 || assertion.confidence > 1) {
      errors.push('confidence must be a number in [0.0, 1.0]');
    }

    // FK check on sourceEpisodeId only if basic fields are valid
    if (errors.length === 0) {
      const episode = this.db
        .prepare<[string, string], { id: string }>('SELECT id FROM trageti_episodes WHERE id = ? AND namespace = ?')
        .get(assertion.sourceEpisodeId, assertion.namespace);
      if (!episode) {
        errors.push(
          `sourceEpisodeId "${assertion.sourceEpisodeId}" does not reference a known episode in namespace "${assertion.namespace}"`,
        );
      }
    }

    // Excerpt handling. v0.3: opt-in strict mode promotes null excerpts to
    // validation failures; default behavior is to warn only. Skipped entirely
    // when enforceCitationExcerptPolicy is false (the store owns the policy).
    if (errors.length === 0 && this.enforceCitationExcerptPolicy) {
      for (const cit of assertion.citations) {
        if (cit.excerpt === null) {
          if (this.requireCitationExcerpt) {
            errors.push(`citation "${cit.id}" excerpt is required`);
          } else {
            this.logger.warn('TRGT_CITATION_EXCERPT_MISSING', {
              assertionId: assertion.id,
              citationId: cit.id,
            });
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
