import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Assertion, EmbeddingProvider, NewEpisodeInput } from 'trageti';
import { resolveCitationExcerpts, validateExtractionResult, type ExtractionResult } from './ingest.js';
import { parseExtraction } from './parse.js';
import { buildExtractionPrompt } from './prompt.js';
import type { ExtractionProvider } from './providers.js';

export interface GenerateFixtureFilesOptions {
  demoName: string;
  episodes: readonly NewEpisodeInput[];
  citationSources?: Record<string, string>;
  queryTexts: readonly string[];
  embeddingDimension: number;
  extractor: ExtractionProvider;
  embedder: EmbeddingProvider;
  writeCommitted: boolean;
  committedFixturesPath: string;
  committedEmbeddingsPath: string;
}

export async function generateFixtureFiles(options: GenerateFixtureFilesOptions): Promise<void> {
  const fixtures: Record<string, string> = {};
  const assertionEmbeddings: Record<string, number[]> = {};
  const allAssertions: Array<{ id: string; content: string }> = [];
  const priorAssertions: Assertion[] = [];

  for (const episode of options.episodes) {
    const prompt = buildExtractionPrompt(
      episode.content,
      priorAssertions,
      episode,
      episode.namespace,
      options.citationSources,
    );
    const raw = await options.extractor.extract(prompt, { episodeId: episode.id });
    const result = parseExtraction(raw);
    const cited = resolveCitationExcerpts(result, episode.content, options.citationSources);
    validateExtractionResult(cited, priorAssertions);
    fixtures[episode.id] = raw;
    for (const assertion of cited.assertions) {
      allAssertions.push({ id: assertion.id, content: assertion.content });
      priorAssertions.push(toPromptAssertion(assertion, episode));
    }
  }

  const assertionVectors = await options.embedder.embed(allAssertions.map((a) => a.content));
  for (let i = 0; i < allAssertions.length; i++) {
    const assertion = allAssertions[i];
    const vector = assertionVectors[i];
    if (!assertion || !vector) {
      throw new Error(`generate-fixtures: assertion/vector misalignment at ${String(i)}`);
    }
    assertionEmbeddings[assertion.id] = Array.from(vector);
  }

  const queryEmbeddings: Record<string, number[]> = {};
  const queryVectors = await options.embedder.embed(options.queryTexts);
  for (let i = 0; i < options.queryTexts.length; i++) {
    const text = options.queryTexts[i];
    const vector = queryVectors[i];
    if (!text || !vector) throw new Error(`generate-fixtures: query/vector misalignment at ${String(i)}`);
    queryEmbeddings[text] = Array.from(vector);
  }

  const fixturesContent = renderFixtures(fixtures);
  const embeddingsContent = renderEmbeddings(
    options.embeddingDimension,
    options.queryTexts,
    assertionEmbeddings,
    queryEmbeddings,
  );
  const reviewFixturesPath = resolve(`demos/.local/${options.demoName}/generated-fixtures.ts`);
  const reviewEmbeddingsPath = resolve(`demos/.local/${options.demoName}/generated-embeddings.ts`);
  writeGenerated(reviewFixturesPath, fixturesContent);
  writeGenerated(reviewEmbeddingsPath, embeddingsContent);

  console.log(`-> wrote review file ${reviewFixturesPath} (${String(Object.keys(fixtures).length)} entries)`);
  console.log(
    `-> wrote review file ${reviewEmbeddingsPath} (${String(allAssertions.length)} assertion vectors, ${String(options.queryTexts.length)} query vectors)`,
  );
  if (options.writeCommitted) {
    writeGenerated(resolve(options.committedFixturesPath), fixturesContent);
    writeGenerated(resolve(options.committedEmbeddingsPath), embeddingsContent);
    console.log(`-> updated committed ${options.demoName} fixture files because --write was supplied`);
  } else {
    console.log('(review .local generated files, then rerun with --write to replace committed fixture files)');
  }
}

function toPromptAssertion(assertion: ExtractionResult['assertions'][number], episode: NewEpisodeInput): Assertion {
  return {
    id: assertion.id,
    namespace: assertion.namespace,
    type: assertion.type,
    content: assertion.content,
    validFrom: assertion.validFrom,
    validUntil: assertion.validUntil ?? null,
    confidence: assertion.confidence,
    sourceEpisodeId: assertion.sourceEpisodeId,
    supersedesId: assertion.supersedesId ?? null,
    entityId: assertion.entityId ?? null,
    entityType: assertion.entityType ?? null,
    citations: assertion.citations.map((citation) => ({
      ...citation,
      assertionId: assertion.id,
      episodeId: citation.episodeId ?? episode.id,
      createdAt: '',
    })),
    createdAt: '',
    extensions: {},
  };
}

function writeGenerated(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function renderFixtures(fixtures: Record<string, string>): string {
  return `export const fixtures: Record<string, string> = ${JSON.stringify(fixtures, null, 2)}\n`;
}

function renderEmbeddings(
  embeddingDimension: number,
  queryTexts: readonly string[],
  assertionEmbeddings: Record<string, number[]>,
  queryEmbeddings: Record<string, number[]>,
): string {
  return [
    `export const EMBEDDING_DIMENSION = ${String(embeddingDimension)}`,
    '',
    `export const QUERY_TEXTS: readonly string[] = ${JSON.stringify(queryTexts, null, 2)}`,
    '',
    `export const assertionEmbeddings: Readonly<Record<string, number[]>> = ${JSON.stringify(assertionEmbeddings, null, 2)}`,
    '',
    `export const queryEmbeddings: Readonly<Record<string, number[]>> = ${JSON.stringify(queryEmbeddings, null, 2)}`,
    '',
  ].join('\n');
}
