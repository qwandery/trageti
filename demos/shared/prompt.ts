import type { Assertion, Episode } from 'trageti';

/**
 * Default extraction prompt. Instructs the LLM to extract self-contained,
 * citable assertions; classify each; choose supersession vs. accumulation
 * (default accumulation); attach at least one citation; emit JSON matching the
 * ExtractionResult schema.
 */
export function buildExtractionPrompt(
  document: string,
  existingAssertions: readonly Assertion[],
  episode?: Omit<Episode, 'createdAt'>,
  namespace?: string,
  citationSources?: Record<string, string>,
): string {
  const existing =
    existingAssertions.length === 0
      ? '(no prior assertions)'
      : existingAssertions.map((a) => `- ${a.id}: ${a.content}`).join('\n');
  const episodeContext = episode
    ? `Current episode:
- id: ${episode.id}
- namespace: ${namespace ?? episode.namespace}
- position: ${String(episode.position)}
- type: ${episode.type}
- occurredAt: ${episode.occurredAt}

Use the current episode id in every new assertion, citation, and link id. For
example: a-${episode.id}-0, c-a-${episode.id}-0-0, link-${episode.id}-0.
`
    : '';
  const idPattern = episode ? `a-${episode.id}-<index>` : 'a-<episodeId>-<index>';
  const citationPattern = episode ? `c-a-${episode.id}-<index>-0` : 'c-<assertionId>-0';
  const linkPattern = episode ? `link-${episode.id}-<index>` : 'link-<episodeId>-<index>';
  const namespaceValue = namespace ?? episode?.namespace ?? '<same as episode>';
  const validFromValue = episode ? String(episode.position) : '<episode.position>';
  const sourceEpisodeValue = episode?.id ?? '<episode.id>';
  const sourceText = citationSources
    ? `\nRegistered citation spans. Copy sourceRef, excerptStart, and excerptEnd exactly from one of these spans; do not calculate offsets yourself:\n${renderCitationSpans(citationSources)}\n\nRegistered citation source documents:\n${Object.entries(
        citationSources,
      )
        .map(([sourceRef, text]) => `--- sourceRef: ${sourceRef} ---\n${text}`)
        .join('\n\n')}\n`
    : '';
  return `You are extracting structured temporal assertions from a document.

Existing assertions (for supersession or link decisions):
${existing}

${episodeContext}
Document:
${document}
${sourceText}

Output a single JSON object matching this schema:
{
  "assertions": [
    {
      "id": "${idPattern}",
      "namespace": "${namespaceValue}",
      "type": "fact|update|recontextualization|resolution|regression|absence|pattern",
      "content": "<self-contained claim>",
      "validFrom": ${validFromValue},
      "confidence": <0..1>,
      "sourceEpisodeId": "${sourceEpisodeValue}",
      "supersedesId": null | "<prior assertion id this replaces>",
      "entityId": null | "<entity grouping id>",
      "entityType": null | "<entity classification>",
      "citations": [
        {
          "id": "${citationPattern}",
          "episodeId": "${sourceEpisodeValue}",
          "sourceRef": "<stable locator>",
          "excerpt": null,
          "excerptStart": "<zero-based start character offset in sourceRef>",
          "excerptEnd": "<exclusive end character offset in sourceRef>"
        }
      ]
    }
  ],
  "links": [
    {
      "id": "${linkPattern}",
      "namespace": "${namespaceValue}",
      "fromId": "<assertion id>",
      "toId": "<prior assertion id>",
      "linkType": "deepens|qualifies|contradicts|contextualizes|measures|related",
      "validFrom": ${validFromValue},
      "validUntil": null,
      "sourceEpisodeId": "${sourceEpisodeValue}"
    }
  ]
}

Citation rules:
- Every assertion needs at least one citation.
- Do not supply citation.excerpt text. Always set "excerpt": null.
- Supply sourceRef, excerptStart, and excerptEnd so the demo runner can derive the stored citation excerpt from registered source text.
- When registered citation spans are listed above, choose a span and copy its sourceRef, excerptStart, and excerptEnd exactly.
- If no external source document is provided, offsets refer to the Document text above.
- If sourceRef names an external source document, offsets refer to that external source document, not this episode summary.
- If the offsets do not resolve to source text, ingestion will fail.

Rules:
- New assertion IDs must not reuse any ID listed under Existing assertions.
- Default to accumulation (typed link) over replacement (supersedesId).
- Only set supersedesId when the new assertion clearly invalidates an existing one.
- Emit JSON only - no prose, no markdown fences.`;
}

function renderCitationSpans(citationSources: Record<string, string>): string {
  return Object.entries(citationSources)
    .flatMap(([sourceRef, text]) => sourceToSpans(sourceRef, text))
    .join('\n');
}

function sourceToSpans(sourceRef: string, text: string): string[] {
  const spans: string[] = [];
  const paragraphPattern = /[^\n](?:.*(?:\n(?!\n).*)*)/g;
  for (const match of text.matchAll(paragraphPattern)) {
    const raw = match[0];
    const excerpt = raw?.trim();
    if (!excerpt || excerpt.length < 24 || excerpt.startsWith('```')) continue;
    const start = match.index ?? 0;
    const end = start + raw.length;
    spans.push(
      `- sourceRef=${sourceRef}; excerptStart=${String(start)}; excerptEnd=${String(end)}; text="${excerpt.replace(/\s+/g, ' ').slice(0, 280)}"`,
    );
  }
  return spans;
}
