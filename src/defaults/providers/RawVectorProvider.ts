import type { EmbeddingProvider, EmbedOptions } from '../../domain/types.js';
import { EmbeddingProviderError } from '../../errors/index.js';

/**
 * Zero-dependency provider for callers who already have embeddings on hand.
 *
 * Callers register pre-computed embeddings via `set(text, embedding)` and the
 * indexer reads them back at index time. Embeds an unknown text fails fast
 * with EmbeddingProviderError; the calling layer turns this into a sanitized
 * skipped[] entry under `onProviderError: 'skip'`.
 */
export class RawVectorProvider implements EmbeddingProvider {
  readonly name = 'raw-vector';
  readonly dimension: number;
  private readonly vectors = new Map<string, Float32Array>();

  constructor(dimension: number) {
    this.dimension = dimension;
  }

  set(text: string, embedding: Float32Array | number[]): void {
    const vec = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
    if (vec.length !== this.dimension) {
      throw new EmbeddingProviderError(
        this.name,
        0,
        `embedding length ${String(vec.length)} does not match dimension ${String(this.dimension)}`,
      );
    }
    this.vectors.set(text, vec);
  }

  // `async` so an unknown-text failure surfaces as a rejected promise rather
  // than a synchronous throw — consistent with the EmbeddingProvider contract.
  // eslint-disable-next-line @typescript-eslint/require-await -- async-by-contract: a sync throw inside an async fn is the intended rejection
  async embed(texts: readonly string[], _options?: EmbedOptions): Promise<Float32Array[]> {
    return texts.map((text) => {
      const vec = this.vectors.get(text);
      if (!vec) {
        throw new EmbeddingProviderError(this.name, 0, `no pre-registered embedding for text`);
      }
      return vec;
    });
  }
}
