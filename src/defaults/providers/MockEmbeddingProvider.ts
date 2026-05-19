import type { EmbeddingProvider, EmbedOptions } from '../../domain/types.js'
import { emitOnce, getDefaultLogger } from '../../internal/logger.js'
import { createHash } from 'node:crypto'

/**
 * Deterministic hashed-embedding provider. Intended for tests and zero-dependency
 * quickstarts; explicitly NOT suitable for real semantic retrieval.
 *
 * Spec §979: emits TRGT_MOCK_PROVIDER_NON_PRODUCTION exactly once per process
 * when used outside `NODE_ENV === 'test'`.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock'
  readonly dimension: number

  constructor(dimension = 384) {
    this.dimension = dimension
  }

  embed(texts: readonly string[], _options?: EmbedOptions): Promise<Float32Array[]> {
    if (process.env['NODE_ENV'] !== 'test' && emitOnce('TRGT_MOCK_PROVIDER_NON_PRODUCTION')) {
      getDefaultLogger().warn('TRGT_MOCK_PROVIDER_NON_PRODUCTION', {
        message: 'MockEmbeddingProvider is for tests/quickstarts only; do not use in production.',
      })
    }

    return Promise.resolve(texts.map((text) => {
      const out = new Float32Array(this.dimension)
      const hash = createHash('sha256').update(text).digest()
      // Spread the 32-byte digest across `dimension` floats deterministically.
      for (let i = 0; i < this.dimension; i++) {
        const byte = hash[i % hash.length] ?? 0
        // Map [0, 255] → [-1, 1] (centered at zero so cosine-distance behaves well).
        out[i] = (byte / 127.5) - 1
      }
      return out
    }))
  }
}
