/**
 * Serialises an assertion ID list as a JSON array string for use with
 * SQLite's json_each(). Candidate IDs are passed as a single bound parameter,
 * keeping all intermediate data in memory with no disk I/O.
 *
 * Usage:
 *   WHERE assertion_id IN (SELECT value FROM json_each(:candidateIds))
 */
export function buildCandidateJson(ids: readonly string[]): string {
  return JSON.stringify(ids);
}
