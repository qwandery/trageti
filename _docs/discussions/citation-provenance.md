# Citation Provenance and Source Spans

## Context

The demos exposed a provenance weakness: extraction output can provide citation
`excerpt` text directly. If an extractor supplies a summary instead of a
verbatim quote, trageti stores and returns that text as the citation excerpt.

That behavior is faithful to the current low-level API, but it is not the right
default posture for applications that need auditable grounding.

## Current Library Shape

`AssertionCitation` currently stores:

- `episodeId`
- `sourceRef`
- `excerpt`
- optional `excerptStart`
- optional `excerptEnd`

trageti validates that citations exist and that citation fields have the right
shape. It can require non-null excerpts. It does not currently verify that
`excerpt` is an exact substring of any source text, nor does it derive the
excerpt from source-span anchors.

## Problem

Allowing normal callers to supply citation text directly makes it easy for an
LLM extraction step to invent, paraphrase, or summarize a citation. That weakens
one of trageti's most important promises: retrieved assertions should remain
traceable to source material.

The issue is partly API presentation:

- `excerpt` looks like an ordinary field callers should populate.
- `excerptStart` and `excerptEnd` are opaque caller-defined fields.
- There is no first-class citation-span type that says "derive the citation text
  from this source range."

The demos also exposed a second issue: an episode is not always the verbatim
source. In the Alex demo, episodes are temporal ingestion units summarising
entries from `alex.md` and a fictional reference document. If citation spans are
resolved against those episode summaries, the citation may still be weaker than
it should be. The strongest provenance model distinguishes:

- source documents: verbatim material that can be quoted
- episodes: temporal ingestion units, possibly derived from source documents
- assertions: normalized claims derived from source material
- citations: references to verbatim source spans

## Demo Policy

The demos now use a stricter policy than the core library:

1. Extraction output must not supply citation excerpt text directly.
2. Extraction output must supply `excerptStart` and `excerptEnd`.
3. The demo ingestion layer resolves `sourceRef` to registered source text.
4. The derived source text becomes the stored `citation.excerpt`.
5. Invalid offsets or direct excerpt text fail ingestion before store writes.

For `alex-place`, `sourceRef` points to verbatim source files such as `alex.md`
or `references/field-fermentation.md`, and offsets are measured against those
files rather than the episode summaries. For `know-thyself`, the current
skeleton still uses keyframe text as its source corpus; that should be revisited
if the demo grows to cite real commits, diffs, or spec documents directly.

This keeps the demo honest without changing trageti's public API in this pass.

## Possible Future Library Direction

A future trageti API could make source spans the normal path and direct excerpt
overrides an explicit advanced path.

One possible shape:

```ts
interface SourceDocument {
  id: string
  namespace: string
  uri?: string
  contentHash: string
  content?: string
}

interface Episode {
  id: string
  namespace: string
  sourceDocumentId?: string
  sourceSpan?: {
    start: number
    end: number
    unit: 'utf16-code-unit' | 'byte' | 'line-column'
  }
}

type CitationInput =
  | {
      id: string
      episodeId: string
      sourceDocumentId: string
      sourceRef?: string
      sourceSpan: {
        start: number
        end: number
        unit: 'utf16-code-unit' | 'byte' | 'line-column'
      }
    }
  | {
      id: string
      episodeId: string
      sourceRef: string
      excerptOverride: string
      overrideReason: string
    }
```

Open design questions:

- Should source spans be measured in bytes, UTF-16 code units, Unicode scalar
  values, or line/column pairs?
- Does trageti need a first-class source/document table, or should source
  registries remain application-owned?
- Should the store verify spans against stored source documents by default?
- If episodes are summaries or chunks, should citations target the episode, the
  source document, or both?
- Should direct excerpt overrides require a separate method or option?
- How should citations work when source text is external and only a stable
  locator is stored in trageti?
- Should null excerpts remain valid for domains where source text cannot be
  embedded in the database?
- How should migration handle existing citation rows that contain direct
  excerpts without anchors?

## Recommendation

Do not remove low-level direct excerpt support without a specification pass.
Instead, design a first-class citation-span API and make it the preferred
high-level path. Keep direct excerpt override support, but make it visibly
exceptional and auditable.
