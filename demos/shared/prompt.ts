import type { Assertion, NewEpisodeInput } from 'trageti';

/**
 * Default extraction prompt. Instructs the LLM to extract self-contained,
 * citable assertions; classify each; choose supersession vs. accumulation
 * (default accumulation); attach at least one citation; emit JSON matching the
 * ExtractionResult schema.
 */
export function buildExtractionPrompt(
  document: string,
  existingAssertions: readonly Assertion[],
  episode?: NewEpisodeInput,
  namespace?: string,
  citationSources?: Record<string, string>,
  imageSources?: Record<string, { path: string; mimeType: string }>,
): string {
  const existing =
    existingAssertions.length === 0
      ? '(no prior assertions)'
      : existingAssertions
          .slice(-12)
          .map((a) => `- ${a.id}: ${truncateOneLine(a.content, 200)}`)
          .join('\n');
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
  const linkExample = renderLinkExample(existingAssertions.at(-1), {
    idPattern,
    linkPattern,
    namespaceValue,
    validFromValue,
    sourceEpisodeValue,
  });
  const sourceText = citationSources
    ? `\nRegistered citation spans. Copy sourceRef, excerptStart, and excerptEnd exactly from one of these spans; do not calculate offsets yourself:\n${renderCitationSpans(citationSources)}\n\nRegistered citation source documents:\n${Object.entries(
        citationSources,
      )
        .map(([sourceRef, text]) => `--- sourceRef: ${sourceRef} ---\n${truncateSource(text)}`)
        .join('\n\n')}\n`
    : '';
  const imageText =
    imageSources && Object.keys(imageSources).length > 0
      ? `\nRegistered image citation sources. You may cite these sourceRef values without excerptStart/excerptEnd offsets:\n${Object.entries(
          imageSources,
        )
          .map(([sourceRef, image]) => `- sourceRef=${sourceRef}; path=${image.path}; mimeType=${image.mimeType}`)
          .join('\n')}\n`
      : '';
  return `You are extracting structured temporal assertions from a document.

Existing assertions (for supersession or link decisions):
${existing}

${episodeContext}
Document:
${document}
${sourceText}
${imageText}

Output a single JSON object shaped like this example in the final visible assistant message. Do not put the JSON only in hidden reasoning, analysis, tool calls, or provider-specific reasoning fields. Replace the example values with claims from the current document:
{
  "assertions": [
    {
      "id": "${idPattern.replace('<index>', '0')}",
      "namespace": "${namespaceValue}",
      "type": "fact",
      "content": "A self-contained claim grounded in the current document.",
      "validFrom": ${validFromValue},
      "confidence": 0.82,
      "sourceEpisodeId": "${sourceEpisodeValue}",
      "supersedesId": null,
      "entityId": null,
      "entityType": null,
      "citations": [
        {
          "id": "${citationPattern.replace('<index>', '0')}",
          "episodeId": "${sourceEpisodeValue}",
          "sourceRef": "copy one listed sourceRef",
          "excerpt": null,
          "excerptStart": "copy listed excerptStart",
          "excerptEnd": "copy listed excerptEnd"
        }
      ]
    }
  ],
  "links": ${linkExample}
}

Citation rules:
- Every assertion needs at least one citation.
- Do not supply citation.excerpt text. Always set "excerpt": null.
- Supply sourceRef, excerptStart, and excerptEnd so the demo runner can derive the stored citation excerpt from registered source text.
- When registered citation spans are listed above, choose a span and copy its sourceRef, excerptStart, and excerptEnd exactly.
- For registered image citation sources only, use the image sourceRef and omit excerptStart/excerptEnd; set excerpt to null.
- If no external source document is provided, offsets refer to the Document text above.
- If sourceRef names an external source document, offsets refer to that external source document, not this episode summary.
- If the offsets do not resolve to source text, ingestion will fail.

Rules:
- The current document is the source of truth. If it contains any substantive information, emit at least one cited assertion; do not return an empty assertions array for a non-empty document.
- New assertion IDs must not reuse any ID listed under Existing assertions.
- Allowed assertion types: fact, update, recontextualization, resolution, regression, absence, pattern.
- Allowed link types: deepens, qualifies, contradicts, contextualizes, measures, related.
- Default to accumulation (typed link) over replacement (supersedesId).
- Only set supersedesId when the new assertion clearly invalidates an existing one.
- Links may only reference new assertion IDs emitted in this JSON object or exact IDs listed under Existing assertions. If there is no real target assertion, emit an empty links array.
- Emit JSON only in the final answer content - no prose, no markdown fences.`;
}

function renderLinkExample(
  prior: Assertion | undefined,
  values: {
    idPattern: string;
    linkPattern: string;
    namespaceValue: string;
    validFromValue: string;
    sourceEpisodeValue: string;
  },
): string {
  if (!prior) return '[]';
  return `[
    {
      "id": "${values.linkPattern.replace('<index>', '0')}",
      "namespace": "${values.namespaceValue}",
      "fromId": "${values.idPattern.replace('<index>', '0')}",
      "toId": "${prior.id}",
      "linkType": "related",
      "validFrom": ${values.validFromValue},
      "validUntil": null,
      "sourceEpisodeId": "${values.sourceEpisodeValue}"
    }
  ]`;
}

function renderCitationSpans(citationSources: Record<string, string>): string {
  return Object.entries(citationSources)
    .flatMap(([sourceRef, text]) => sourceToSpans(sourceRef, text))
    .join('\n');
}

function sourceToSpans(sourceRef: string, text: string): string[] {
  const sectionSpans = markdownSectionSpans(sourceRef, text);
  if (sectionSpans.length > 0) return sectionSpans;
  return paragraphSpans(sourceRef, text);
}

function markdownSectionSpans(sourceRef: string, text: string): string[] {
  const spans: string[] = [];
  const headingPattern = /^(#{1,6})\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(text)) !== null) {
    const level = match[1]?.length ?? 0;
    const heading = match[2]?.trim() ?? '';
    const anchor = heading.match(/\d{4}-\d{2}-\d{2}/u)?.[0];
    if (!anchor) continue;

    let start = headingPattern.lastIndex;
    while (text[start] === '\r' || text[start] === '\n') start++;

    const nextHeadingPattern = new RegExp(`^#{1,${String(level)}}\\s+`, 'gm');
    nextHeadingPattern.lastIndex = start;
    const next = nextHeadingPattern.exec(text);
    const end = next?.index ?? text.length;
    const section = text.slice(start, end).replace(/[\r\n]+$/u, '');
    spans.push(...paragraphSpans(`${sourceRef}#${anchor}`, section));
  }
  return spans;
}

function paragraphSpans(sourceRef: string, text: string): string[] {
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

function truncateSource(text: string): string {
  const limit = 3000;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n... [truncated for prompt display]`;
}

function truncateOneLine(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 3)}...`;
}
