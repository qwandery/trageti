export type WarnMeta = Record<string, string | number | boolean>

/**
 * Emits a structured warning to stderr. Only accepts operational metadata —
 * never assertion content, embeddings, or query text.
 */
export function structuredWarn(code: string, meta: WarnMeta): void {
  const parts = Object.entries(meta)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
  process.stderr.write(`[trageti:warn] code=${code} ${parts}\n`)
}
