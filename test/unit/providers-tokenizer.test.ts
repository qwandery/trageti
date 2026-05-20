import { describe, it, expect } from 'vitest'
import { MockEmbeddingProvider } from '../../src/defaults/providers/MockEmbeddingProvider.js'
import { RawVectorProvider } from '../../src/defaults/providers/RawVectorProvider.js'
import { validateTokenizer } from '../../src/internal/tokenizer.js'
import { EmbeddingProviderError, MigrationCompatibilityError } from '../../src/errors/index.js'

describe('MockEmbeddingProvider', () => {
  it('defaults to dimension 384', () => {
    expect(new MockEmbeddingProvider().dimension).toBe(384)
  })

  it('honours an explicit dimension and produces vectors of that length', async () => {
    const provider = new MockEmbeddingProvider({ dimension: 8 })
    expect(provider.dimension).toBe(8)
    const [vec] = await provider.embed(['hello'])
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec?.length).toBe(8)
  })

  it('is deterministic — the same text yields the same embedding', async () => {
    const provider = new MockEmbeddingProvider({ dimension: 16 })
    const [a] = await provider.embed(['stable text'])
    const [b] = await provider.embed(['stable text'])
    expect(Array.from(a ?? [])).toEqual(Array.from(b ?? []))
  })

  it('distinct texts yield distinct embeddings', async () => {
    const provider = new MockEmbeddingProvider({ dimension: 16 })
    const [a] = await provider.embed(['one'])
    const [b] = await provider.embed(['two'])
    expect(Array.from(a ?? [])).not.toEqual(Array.from(b ?? []))
  })

  it('embeds a batch in input order', async () => {
    const provider = new MockEmbeddingProvider({ dimension: 4 })
    const out = await provider.embed(['x', 'y', 'z'])
    expect(out).toHaveLength(3)
    const [solo] = await provider.embed(['y'])
    expect(Array.from(out[1] ?? [])).toEqual(Array.from(solo ?? []))
  })
})

describe('RawVectorProvider', () => {
  it('returns pre-registered embeddings by text', async () => {
    const provider = new RawVectorProvider(3)
    expect(provider.name).toBe('raw-vector')
    expect(provider.dimension).toBe(3)
    provider.set('alpha', [1, 0, 0])
    const [vec] = await provider.embed(['alpha'])
    expect(Array.from(vec ?? [])).toEqual([1, 0, 0])
  })

  it('accepts a Float32Array directly', async () => {
    const provider = new RawVectorProvider(2)
    provider.set('beta', new Float32Array([0.5, 0.25]))
    const [vec] = await provider.embed(['beta'])
    expect(Array.from(vec ?? [])).toEqual([0.5, 0.25])
  })

  it('rejects a set() whose embedding length does not match the dimension', () => {
    const provider = new RawVectorProvider(3)
    expect(() => provider.set('bad', [1, 0])).toThrow(EmbeddingProviderError)
  })

  it('embed() rejects (not sync-throws) for an unknown text', async () => {
    const provider = new RawVectorProvider(3)
    await expect(provider.embed(['never-registered'])).rejects.toThrow(EmbeddingProviderError)
  })
})

describe('validateTokenizer', () => {
  it('accepts every allow-listed tokenizer', () => {
    for (const tokenizer of ['unicode61', 'ascii', 'porter', 'trigram'] as const) {
      expect(() => validateTokenizer({ tokenizer })).not.toThrow()
    }
  })

  it('accepts safe tokenizer args', () => {
    expect(() =>
      validateTokenizer({ tokenizer: 'unicode61', tokenizerArgs: ['remove_diacritics', '1'] }),
    ).not.toThrow()
  })

  it('rejects an unknown tokenizer name', () => {
    expect(() => validateTokenizer({ tokenizer: 'evil' })).toThrow(MigrationCompatibilityError)
  })

  it('rejects a tokenizer arg with unsafe characters', () => {
    let thrown: unknown
    try {
      validateTokenizer({ tokenizer: 'unicode61', tokenizerArgs: ["1'; DROP TABLE x; --"] })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(MigrationCompatibilityError)
    expect((thrown as MigrationCompatibilityError).kind).toBe('fts-tokenizer')
  })
})
