import { describe, expect, it } from 'vitest';
import { validatePreparedArtifact } from '../shared/artifacts.js';
import { resolveCitationExcerpts, validateExtractionResult } from '../shared/ingest.js';
import {
  bigBrotherMetadata,
  parseBigBrotherCliOptions,
  prepareBigBrotherArtifact,
  resolveBigBrotherProviders,
} from './big-brother.js';
import { dropUnknownEndpointLinks } from './scenario.js';

const trace = {
  enabled: false,
  includePayloads: false,
  includeRawVectors: false,
  log() {
    return undefined;
  },
};

describe('big-brother demo', () => {
  it('parses capture and multimodal options', () => {
    expect(
      parseBigBrotherCliOptions([
        'node',
        'index.ts',
        '--capture',
        '--captures',
        '3',
        '--duration-minutes=0.25',
        '--multimodal',
        '--query',
        'What next?',
      ]),
    ).toMatchObject({
      capture: true,
      captures: 3,
      durationMinutes: 0.25,
      multimodal: true,
      query: 'What next?',
    });
  });

  it('rejects unexpected positional options with npm separator guidance', () => {
    expect(() => parseBigBrotherCliOptions(['node', 'index.ts', '12', '1'])).toThrow(
      'npm run trageti-demo -- big-brother prepare',
    );
  });

  it('creates an offline synthetic prepared artifact', async () => {
    const artifact = await prepareBigBrotherArtifact({
      cli: parseBigBrotherCliOptions(['node', 'index.ts']),
      env: {},
      trace,
    });

    expect(validatePreparedArtifact(artifact)).toBe(artifact);
    expect(artifact.scenario).toBe('big-brother');
    expect(artifact.units).toHaveLength(2);
    expect(bigBrotherMetadata(artifact).fixtureData).toBeDefined();
  });

  it('resolves synthetic fixture providers with query vectors', async () => {
    const artifact = await prepareBigBrotherArtifact({
      cli: parseBigBrotherCliOptions(['node', 'index.ts', '--query', 'What should I do next?']),
      env: {},
      trace,
    });
    const providers = resolveBigBrotherProviders({
      cli: parseBigBrotherCliOptions(['node', 'index.ts', '--query', 'What should I do next?']),
      artifact,
      env: {},
      trace,
    });

    expect(providers.extractor.provenance.kind).toBe('fixture');
    await expect(providers.embedder.provider.embed(['What should I do next?'])).resolves.toHaveLength(1);
  });

  it('allows image citations to omit text offsets', () => {
    const result = resolveCitationExcerpts(
      {
        assertions: [
          {
            id: 'a-screen-1-0',
            namespace: 'screen-activity',
            type: 'fact',
            content: 'The screen shows a code editor.',
            validFrom: 1,
            confidence: 0.8,
            sourceEpisodeId: 'screen-1',
            citations: [
              {
                id: 'c-a-screen-1-0-0',
                episodeId: 'screen-1',
                sourceRef: 'demos/.local/big-brother/screen.png',
                excerpt: null,
              },
            ],
          },
        ],
        links: [],
      },
      'metadata',
      {},
      { 'demos/.local/big-brother/screen.png': { path: 'demos/.local/big-brother/screen.png', mimeType: 'image/png' } },
    );

    expect(result.assertions[0]?.citations[0]?.excerptStart).toBeUndefined();
    expect(() => {
      validateExtractionResult(result, []);
    }).not.toThrow();
  });

  it('drops hallucinated links to unknown assertion ids before validation', () => {
    const result = dropUnknownEndpointLinks(
      {
        assertions: [
          {
            id: 'a-screen-01-0',
            namespace: 'screen-activity',
            type: 'fact',
            content: 'The screen shows terminal work.',
            validFrom: 1,
            confidence: 0.8,
            sourceEpisodeId: 'screen-01',
            citations: [
              {
                id: 'c-a-screen-01-0-0',
                episodeId: 'screen-01',
                sourceRef: 'episode document',
                excerpt: 'The screen shows terminal work.',
              },
            ],
          },
        ],
        links: [
          {
            id: 'link-screen-01-0',
            namespace: 'screen-activity',
            fromId: 'a-screen-01-0',
            toId: 'a-prior-claim-id',
            linkType: 'related',
            validFrom: 1,
            validUntil: null,
            sourceEpisodeId: 'screen-01',
          },
        ],
      },
      [],
    );

    expect(result.links).toEqual([]);
    expect(() => {
      validateExtractionResult(result, []);
    }).not.toThrow();
  });
});
