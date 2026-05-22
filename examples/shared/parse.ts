import type { ExtractionResult } from './ingest.js'

/**
 * Parse an LLM extraction response into ExtractionResult. Tolerates:
 *  - markdown code fences (```json ... ```)
 *  - leading/trailing prose around the JSON object
 *  - missing assertions/links arrays
 *
 * Throws a plain Error if the response cannot be parsed.
 */
export function parseExtraction(raw: string): ExtractionResult {
  const trimmed = raw.trim()
  const stripped = trimmed.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`parseExtraction: no JSON object in response: ${trimmed.slice(0, 200)}`)
  }
  const slice = stripped.slice(start, end + 1)
  let obj: unknown
  try {
    obj = JSON.parse(slice)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`parseExtraction: JSON.parse failed (${msg}): ${slice.slice(0, 200)}`)
  }
  const o = obj as { assertions?: unknown; links?: unknown }
  return {
    assertions: Array.isArray(o.assertions) ? (o.assertions as ExtractionResult['assertions']) : [],
    links: Array.isArray(o.links) ? (o.links as ExtractionResult['links']) : [],
  }
}
