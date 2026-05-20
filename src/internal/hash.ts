import { createHash } from 'node:crypto'

const TABLE_PREFIX = 'trageti_embeddings_'

/** Returns a stable 16-hex-char suffix derived from the namespace string. */
export function namespaceToTableSuffix(namespace: string): string {
  return createHash('sha256').update(namespace, 'utf8').digest('hex').slice(0, 16)
}

/** Returns the full vec0 virtual table name for a namespace. */
export function namespaceToEmbeddingTable(namespace: string): string {
  return `${TABLE_PREFIX}${namespaceToTableSuffix(namespace)}`
}
