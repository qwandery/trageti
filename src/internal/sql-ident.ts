/** Returns a safely double-quoted SQL identifier. Escapes embedded double-quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
