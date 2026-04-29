import type { Database } from 'better-sqlite3'
import type { Assertion, AssertionValidator, ValidationResult } from '../../domain/types.js'

export class DefaultAssertionValidator implements AssertionValidator {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  validate(assertion: Omit<Assertion, 'createdAt' | 'extensions'>): ValidationResult {
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

    // Only check FK if basic fields are valid
    if (errors.length === 0) {
      const episode = this.db
        .prepare<[string, string], { id: string }>(
          'SELECT id FROM trl_episodes WHERE id = ? AND namespace = ?',
        )
        .get(assertion.sourceEpisodeId, assertion.namespace)
      if (!episode) {
        errors.push(
          `sourceEpisodeId "${assertion.sourceEpisodeId}" does not reference a known episode in namespace "${assertion.namespace}"`,
        )
      }
    }

    return { valid: errors.length === 0, errors }
  }
}
