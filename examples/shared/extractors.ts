// LLM extractors (text -> JSON) and embedding providers (text -> vector).
// Three extractors (Anthropic, OpenAI-compatible, fixture) and two live
// embedders (Ollama, OpenAI-compatible) — kept in one file to hold the
// 250-line shared-infra budget.

import type { EmbeddingProvider, EmbedOptions } from 'trageti'

// ─── Extractors ────────────────────────────────────────────────────────────

/** Anthropic Messages API — different request format from OpenAI. */
export function anthropicExtractor(apiKey: string): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    const data = (await response.json()) as any
    return data.content[0].text
  }
}

/** OpenAI-compatible — OpenAI, OpenRouter, Ollama, llama.cpp, LM Studio. */
export function openaiExtractor(options: {
  baseUrl: string
  apiKey: string
  model: string
}): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
    })
    const data = (await response.json()) as any
    return data.choices[0].message.content
  }
}

/** Pre-generated fixtures — call-index keyed; episodes must iterate in
 *  fixture-key declaration order. async-by-contract to match the extractor type. */
export function fixtureExtractor(
  fixtures: Record<string, string>,
): (prompt: string) => Promise<string> {
  const keys = Object.keys(fixtures)
  let callIndex = 0
  // eslint-disable-next-line @typescript-eslint/require-await -- async by contract
  return async () => {
    const key = keys[callIndex++]
    if (key === undefined) {
      throw new Error(`fixtureExtractor: no fixture for call index ${callIndex - 1}`)
    }
    const value = fixtures[key]
    if (value === undefined) {
      throw new Error(`fixtureExtractor: fixture missing for key ${key}`)
    }
    return value
  }
}

// ─── Live embedders ────────────────────────────────────────────────────────

/** Ollama /api/embeddings is single-input — loop per text. */
export function ollamaEmbeddingProvider(opts: {
  host: string
  model: string
  dimension: number
}): EmbeddingProvider {
  return {
    name: 'ollama',
    dimension: opts.dimension,
    async embed(texts: readonly string[], _options?: EmbedOptions): Promise<Float32Array[]> {
      const out: Float32Array[] = []
      for (const text of texts) {
        const response = await fetch(`${opts.host}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: opts.model, prompt: text }),
        })
        const data = (await response.json()) as { embedding: number[] }
        out.push(new Float32Array(data.embedding))
      }
      return out
    },
  }
}

/** OpenAI-compatible /v1/embeddings — accepts an array of inputs. The
 *  `dimensions` parameter is sent regardless; if the endpoint ignores it and
 *  returns a different-size vector, the downstream dimension check surfaces
 *  the failure as a normal library error (do not wrap or swallow). */
export function openaiEmbeddingProvider(opts: {
  baseUrl: string
  apiKey: string
  model: string
  dimension: number
}): EmbeddingProvider {
  return {
    name: 'openai',
    dimension: opts.dimension,
    async embed(texts: readonly string[], _options?: EmbedOptions): Promise<Float32Array[]> {
      const response = await fetch(`${opts.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          input: texts,
          dimensions: opts.dimension,
        }),
      })
      const data = (await response.json()) as any
      return data.data.map((d: any) => new Float32Array(d.embedding))
    },
  }
}
