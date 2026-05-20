import type { Database } from 'better-sqlite3'
import type {
  AssertionValidator,
  NormalizedNewAssertion,
  ValidationResult,
} from '../../domain/types.js'
import type { Logger } from '../../internal/logger.js'
import { getDefaultLogger } from '../../internal/logger.js'

export interface DefaultAssertionValidatorOptions {
  /** When true, citations with null excerpt fail validation. Default false. */
  requireCitationExcerpt?: boolean
  /** Store-scoped logger for TRGT_CITATION_EXCERPT_MISSING warnings.
   *  Falls back to the process-default logger when omitted. */
  logger?: Logger
}

/**
 * Default user-facing validator. Enforces baseline checks (required fields,
 * ranges, FK on sourceEpisodeId) and emits the CITATION_EXCERPT_MISSING
 * warning per citation with a null excerpt.
 *
 * NOTE: structural integrity (citation presence, citation episode namespace,
 * predecessor existence/namespace/ordering) is enforced by
 * TemporalStore.writeAssertion() and runs *before* this validator. This
 * validator does not re-check those — by the time it is reached, the
 * structural invariants have already passed (decision §2 ordering rule).
 */
export class DefaultAssertionValidator implements AssertionValidator {
  private readonly db: Database
  private readonly requireCitationExcerpt: boolean
  private readonly logger: Logger

  constructor(db: Database, options: DefaultAssertionValidatorOptions = {}) {
    this.db = db
    this.requireCitationExcerpt = options.requireCitationExcerpt ?? false
    this.logger = options.logger ?? getDefaultLogger()
  }

  validate(assertion: NormalizedNewAssertion): ValidationResult {
    const errors: string[] = []

    if (!assertion.id.trim()) errors.push('id is required')
    if (!assertion.namespace.trim()) errors.push('namespace is required')
    if (!assertion.type.trim()) errors.push('type is required')
    if (!assertion.content.trim()) errors.push('content is required')
    if (!assertion.sourceEpisodeId.trim()) errors.push('sourceEpisodeId is required')

    if (assertion.validUntil !== null && assertion.validUntil <= assertion.validFrom) {
      errors.push('validUntil must be strictly greater than validFrom')
    }

    if (assertion.confidence < 0 || assertion.confidence > 1) {
      errors.push('confidence must be a number in [0.0, 1.0]')
    }

    // FK check on sourceEpisodeId only if basic fields are valid
    if (errors.length === 0) {
      const episode = this.db
        .prepare<
          [string, string],
          { id: string }
        >('SELECT id FROM trl_episodes WHERE id = ? AND namespace = ?')
        .get(assertion.sourceEpisodeId, assertion.namespace)
      if (!episode) {
        errors.push(
          `sourceEpisodeId "${assertion.sourceEpisodeId}" does not reference a known episode in namespace "${assertion.namespace}"`,
        )
      }
    }

    // Excerpt handling. v0.3: opt-in strict mode promotes null excerpts to
    // validation failures; default behavior is to warn only.
    if (errors.length === 0) {
      for (const cit of assertion.citations) {
        if (cit.excerpt === null) {
          if (this.requireCitationExcerpt) {
            errors.push(`citation "${cit.id}" excerpt is required`)
          } else {
            this.logger.warn('TRGT_CITATION_EXCERPT_MISSING', {
              assertionId: assertion.id,
              citationId: cit.id,
            })
          }
        }
      }
    }

    return { valid: errors.length === 0, errors }
  }
}
