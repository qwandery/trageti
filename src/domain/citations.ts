import type { NewAssertionCitation } from './types.js';

export interface SelfCitationInput {
  assertionId: string;
  episodeId: string;
  content: string;
  id?: string;
  sourceRef?: string;
  excerptStart?: string;
  excerptEnd?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Build a minimal provenance citation for single-assertion ingest. This helper
 * keeps citation enforcement intact while avoiding hand-authored boilerplate.
 */
export function selfCitation(input: SelfCitationInput): NewAssertionCitation {
  const citation: NewAssertionCitation = {
    id: input.id ?? `${input.assertionId}:self`,
    episodeId: input.episodeId,
    sourceRef: input.sourceRef ?? `self:${input.assertionId}`,
    excerpt: input.content,
  };
  if (input.excerptStart !== undefined) citation.excerptStart = input.excerptStart;
  if (input.excerptEnd !== undefined) citation.excerptEnd = input.excerptEnd;
  if (input.metadata !== undefined) citation.metadata = input.metadata;
  return citation;
}
