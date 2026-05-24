import type { Assertion } from 'trageti'

/**
 * Default extraction prompt. Instructs the LLM to extract self-contained,
 * citable assertions; classify each; choose supersession vs. accumulation
 * (default accumulation); attach at least one citation; emit JSON matching the
 * ExtractionResult schema.
 */
export function buildExtractionPrompt(
  document: string,
  existingAssertions: readonly Assertion[],
): string {
  const existing =
    existingAssertions.length === 0
      ? '(no prior assertions)'
      : existingAssertions.map((a) => `- ${a.id}: ${a.content}`).join('\n')
  return `You are extracting structured temporal assertions from a document.

Existing assertions (for supersession or link decisions):
${existing}

Document:
${document}

Output a single JSON object matching this schema:
{
  "assertions": [
    {
      "id": "a-<episodeId>-<index>",
      "namespace": "<same as episode>",
      "type": "fact|update|recontextualization|resolution|regression|absence|pattern",
      "content": "<self-contained claim>",
      "validFrom": <episode.position>,
      "confidence": <0..1>,
      "sourceEpisodeId": "<episode.id>",
      "supersedesId": null | "<prior assertion id this replaces>",
      "entityId": null | "<entity grouping id>",
      "entityType": null | "<entity classification>",
      "citations": [
        {"id":"c-<assertionId>-0","episodeId":"<episode.id>","sourceRef":"<locator>","excerpt":"<verbatim>"}
      ]
    }
  ],
  "links": [
    {
      "id": "link-<episodeId>-<index>",
      "namespace": "<same as episode>",
      "fromId": "<assertion id>",
      "toId": "<prior assertion id>",
      "linkType": "deepens|qualifies|contradicts|contextualizes|measures|related",
      "validFrom": <episode.position>,
      "validUntil": null,
      "sourceEpisodeId": "<episode.id>"
    }
  ]
}

Rules:
- Every assertion needs at least one citation with a verbatim excerpt.
- Default to accumulation (typed link) over replacement (supersedesId).
- Only set supersedesId when the new assertion clearly invalidates an existing one.
- Emit JSON only — no prose, no markdown fences.`
}
