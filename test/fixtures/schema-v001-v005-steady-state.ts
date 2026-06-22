export interface ExpectedSchemaObject {
  type: string;
  name: string;
  tableName: string;
  sql: string;
}

export interface ExpectedSchemaColumn {
  name: string;
  type: string;
  notnull: number;
  defaultValue: string | null;
  pk: number;
}

export const EXPECTED_STEADY_STATE_OBJECTS: readonly ExpectedSchemaObject[] = [
  {
    type: 'index',
    name: 'trageti_idx_assertions_entity',
    tableName: 'trageti_assertions',
    sql: 'CREATE INDEX trageti_idx_assertions_entity ON trageti_assertions(namespace, entity_id, entity_type)',
  },
  {
    type: 'index',
    name: 'trageti_idx_assertions_episode',
    tableName: 'trageti_assertions',
    sql: 'CREATE INDEX trageti_idx_assertions_episode ON trageti_assertions(source_episode_id)',
  },
  {
    type: 'index',
    name: 'trageti_idx_assertions_ns_pos',
    tableName: 'trageti_assertions',
    sql: 'CREATE INDEX trageti_idx_assertions_ns_pos ON trageti_assertions(namespace, valid_from, valid_until)',
  },
  {
    type: 'index',
    name: 'trageti_idx_assertions_supersedes',
    tableName: 'trageti_assertions',
    sql: 'CREATE INDEX trageti_idx_assertions_supersedes ON trageti_assertions(namespace, supersedes_id)',
  },
  {
    type: 'index',
    name: 'trageti_idx_citations_assertion',
    tableName: 'trageti_citations',
    sql: 'CREATE INDEX trageti_idx_citations_assertion ON trageti_citations(assertion_id)',
  },
  {
    type: 'index',
    name: 'trageti_idx_episodes_ns_pos',
    tableName: 'trageti_episodes',
    sql: 'CREATE INDEX trageti_idx_episodes_ns_pos ON trageti_episodes(namespace, position)',
  },
  {
    type: 'index',
    name: 'trageti_idx_links_from',
    tableName: 'trageti_links',
    sql: 'CREATE INDEX trageti_idx_links_from ON trageti_links(namespace, from_id, valid_until)',
  },
  {
    type: 'index',
    name: 'trageti_idx_links_source_episode',
    tableName: 'trageti_links',
    sql: 'CREATE INDEX trageti_idx_links_source_episode ON trageti_links(source_episode_id)',
  },
  {
    type: 'index',
    name: 'trageti_idx_links_to',
    tableName: 'trageti_links',
    sql: 'CREATE INDEX trageti_idx_links_to ON trageti_links(namespace, to_id, valid_until)',
  },
  {
    type: 'index',
    name: 'trageti_idx_namespace_locks_heartbeat',
    tableName: 'trageti_namespace_locks',
    sql: 'CREATE INDEX trageti_idx_namespace_locks_heartbeat ON trageti_namespace_locks(heartbeat_at)',
  },
  {
    type: 'table',
    name: 'trageti_assertions',
    tableName: 'trageti_assertions',
    sql: "CREATE TABLE trageti_assertions ( id TEXT PRIMARY KEY, namespace TEXT NOT NULL REFERENCES trageti_namespaces(namespace), type TEXT NOT NULL, content TEXT NOT NULL, valid_from REAL NOT NULL, valid_until REAL, confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0), source_episode_id TEXT NOT NULL REFERENCES trageti_episodes(id), supersedes_id TEXT REFERENCES trageti_assertions(id), entity_id TEXT, entity_type TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), CHECK (valid_until IS NULL OR valid_until > valid_from) )",
  },
  {
    type: 'table',
    name: 'trageti_citations',
    tableName: 'trageti_citations',
    sql: "CREATE TABLE trageti_citations ( id TEXT PRIMARY KEY, assertion_id TEXT NOT NULL REFERENCES trageti_assertions(id), episode_id TEXT NOT NULL REFERENCES trageti_episodes(id), source_ref TEXT NOT NULL, excerpt TEXT, excerpt_start TEXT, excerpt_end TEXT, metadata TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')) )",
  },
  {
    type: 'table',
    name: 'trageti_episodes',
    tableName: 'trageti_episodes',
    sql: "CREATE TABLE trageti_episodes ( id TEXT PRIMARY KEY, namespace TEXT NOT NULL REFERENCES trageti_namespaces(namespace), position REAL NOT NULL, occurred_at TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')) )",
  },
  {
    type: 'table',
    name: 'trageti_fulltext',
    tableName: 'trageti_fulltext',
    sql: "CREATE VIRTUAL TABLE trageti_fulltext USING fts5( assertion_id UNINDEXED, content, content='trageti_assertions', content_rowid='rowid', tokenize='unicode61 remove_diacritics 1' )",
  },
  {
    type: 'table',
    name: 'trageti_links',
    tableName: 'trageti_links',
    sql: "CREATE TABLE trageti_links ( id TEXT PRIMARY KEY, namespace TEXT NOT NULL REFERENCES trageti_namespaces(namespace), from_id TEXT NOT NULL REFERENCES trageti_assertions(id), to_id TEXT NOT NULL REFERENCES trageti_assertions(id), link_type TEXT NOT NULL, valid_from REAL NOT NULL, valid_until REAL, source_episode_id TEXT NOT NULL REFERENCES trageti_episodes(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), CHECK (valid_until IS NULL OR valid_until > valid_from) )",
  },
  {
    type: 'table',
    name: 'trageti_namespace_locks',
    tableName: 'trageti_namespace_locks',
    sql: 'CREATE TABLE trageti_namespace_locks ( namespace TEXT PRIMARY KEY REFERENCES trageti_namespaces(namespace) ON DELETE CASCADE, operation TEXT NOT NULL, owner TEXT NOT NULL, acquired_at TEXT NOT NULL , heartbeat_at TEXT)',
  },
  {
    type: 'table',
    name: 'trageti_namespaces',
    tableName: 'trageti_namespaces',
    sql: "CREATE TABLE trageti_namespaces ( namespace TEXT PRIMARY KEY, embedding_dimension INTEGER, embedding_table TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), config TEXT NOT NULL DEFAULT '{}', CHECK ( (embedding_dimension IS NULL AND embedding_table IS NULL) OR (embedding_dimension IS NOT NULL AND embedding_table IS NOT NULL) ) )",
  },
  {
    type: 'table',
    name: 'trageti_schema_version',
    tableName: 'trageti_schema_version',
    sql: "CREATE TABLE trageti_schema_version ( version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')), description TEXT NOT NULL )",
  },
  {
    type: 'table',
    name: 'trageti_tokenizer',
    tableName: 'trageti_tokenizer',
    sql: "CREATE TABLE trageti_tokenizer ( id INTEGER PRIMARY KEY CHECK (id = 1), tokenizer TEXT NOT NULL, tokenizer_args TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL DEFAULT (datetime('now')) )",
  },
];

export const EXPECTED_STEADY_STATE_COLUMNS: Readonly<Record<string, readonly ExpectedSchemaColumn[]>> = {
  trageti_assertions: [
    { name: 'id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'namespace', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'type', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'content', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'valid_from', type: 'REAL', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'valid_until', type: 'REAL', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'confidence', type: 'REAL', notnull: 1, defaultValue: '1.0', pk: 0 },
    { name: 'source_episode_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'supersedes_id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'entity_id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'entity_type', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, defaultValue: "datetime('now')", pk: 0 },
  ],
  trageti_citations: [
    { name: 'id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'assertion_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'episode_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'source_ref', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'excerpt', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'excerpt_start', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'excerpt_end', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'metadata', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, defaultValue: "datetime('now')", pk: 0 },
  ],
  trageti_episodes: [
    { name: 'id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'namespace', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'position', type: 'REAL', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'occurred_at', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'type', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'content', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, defaultValue: "datetime('now')", pk: 0 },
  ],
  trageti_fulltext: [
    { name: 'assertion_id', type: '', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'content', type: '', notnull: 0, defaultValue: null, pk: 0 },
  ],
  trageti_links: [
    { name: 'id', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'namespace', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'from_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'to_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'link_type', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'valid_from', type: 'REAL', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'valid_until', type: 'REAL', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'source_episode_id', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, defaultValue: "datetime('now')", pk: 0 },
  ],
  trageti_namespace_locks: [
    { name: 'namespace', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'operation', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'owner', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'acquired_at', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'heartbeat_at', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
  ],
  trageti_namespaces: [
    { name: 'namespace', type: 'TEXT', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'embedding_dimension', type: 'INTEGER', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'embedding_table', type: 'TEXT', notnull: 0, defaultValue: null, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, defaultValue: "datetime('now')", pk: 0 },
    { name: 'config', type: 'TEXT', notnull: 1, defaultValue: "'{}'", pk: 0 },
  ],
  trageti_schema_version: [
    { name: 'version', type: 'INTEGER', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'applied_at', type: 'TEXT', notnull: 1, defaultValue: "datetime('now')", pk: 0 },
    { name: 'description', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
  ],
  trageti_tokenizer: [
    { name: 'id', type: 'INTEGER', notnull: 0, defaultValue: null, pk: 1 },
    { name: 'tokenizer', type: 'TEXT', notnull: 1, defaultValue: null, pk: 0 },
    { name: 'tokenizer_args', type: 'TEXT', notnull: 1, defaultValue: "'[]'", pk: 0 },
    { name: 'updated_at', type: 'TEXT', notnull: 1, defaultValue: "datetime('now')", pk: 0 },
  ],
};
