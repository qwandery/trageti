import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openTestDb } from '../helpers/openTestDb.js';
import { MigrationRunner } from '../../src/db/migrations/runner.js';
import {
  EXPECTED_STEADY_STATE_COLUMNS,
  EXPECTED_STEADY_STATE_OBJECTS,
  type ExpectedSchemaColumn,
  type ExpectedSchemaObject,
} from '../fixtures/schema-v001-v005-steady-state.js';

interface SqliteMasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

function normalizeSql(sql: string): string {
  return sql.replace(/"/g, '').replace(/\s+/g, ' ').trim();
}

function getSchemaObjects(db: Database): ExpectedSchemaObject[] {
  return db
    .prepare<[], SqliteMasterRow>(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_master
        WHERE sql IS NOT NULL
          AND name NOT LIKE 'sqlite_%'
          AND name NOT GLOB 'trageti_fulltext_*'
        ORDER BY type, name`,
    )
    .all()
    .map((row) => ({
      type: row.type,
      name: row.name,
      tableName: row.tbl_name,
      sql: normalizeSql(row.sql),
    }));
}

function getSchemaColumns(db: Database): Record<string, ExpectedSchemaColumn[]> {
  const tables = db
    .prepare<[], { name: string }>(
      `SELECT name
         FROM sqlite_master
        WHERE type IN ('table', 'virtual table')
          AND name NOT LIKE 'sqlite_%'
          AND name NOT GLOB 'trageti_fulltext_*'
        ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
  const columns: Record<string, ExpectedSchemaColumn[]> = {};
  for (const table of tables) {
    columns[table] = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => {
        const col = row as {
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        };
        return {
          name: col.name,
          type: col.type,
          notnull: col.notnull,
          defaultValue: col.dflt_value,
          pk: col.pk,
        };
      });
  }
  return columns;
}

function getObjects(db: Database, type: string): string[] {
  return db
    .prepare<[string], { name: string }>(`SELECT name FROM sqlite_master WHERE type = ?`)
    .all(type)
    .map((row) => row.name);
}

describe('MigrationRunner baseline schema', () => {
  let db: Database;

  beforeEach(() => {
    db = openTestDb();
  });

  it('applies the v0.3 baseline on a fresh database', () => {
    const runner = new MigrationRunner();
    runner.applyMigrations(db);

    expect(runner.getCurrentVersion(db)).toBe(2);
    expect(getObjects(db, 'table')).toEqual(
      expect.arrayContaining([
        'trageti_namespaces',
        'trageti_episodes',
        'trageti_assertions',
        'trageti_links',
        'trageti_citations',
        'trageti_tokenizer',
        'trageti_schema_version',
        'trageti_namespace_locks',
        'trageti_fulltext',
      ]),
    );
    expect(getObjects(db, 'table').some((name) => name.startsWith('trl_'))).toBe(false);
  });

  it('is idempotent', () => {
    const runner = new MigrationRunner();
    runner.applyMigrations(db);
    runner.applyMigrations(db);

    expect(runner.getCurrentVersion(db)).toBe(2);
    const versionRows = db.prepare<[], { cnt: number }>('SELECT COUNT(*) AS cnt FROM trageti_schema_version').get();
    expect(versionRows?.cnt).toBe(2);
  });

  it('matches the pre-flattening v001-to-v005 steady-state schema', () => {
    const runner = new MigrationRunner();
    runner.applyMigrations(db);

    expect(getSchemaObjects(db)).toEqual(EXPECTED_STEADY_STATE_OBJECTS);
    expect(getSchemaColumns(db)).toEqual(EXPECTED_STEADY_STATE_COLUMNS);
  });

  it('creates all required FTS triggers and indexes', () => {
    const runner = new MigrationRunner();
    runner.applyMigrations(db);

    expect(getObjects(db, 'trigger')).toEqual(
      expect.arrayContaining(['trageti_fulltext_ai', 'trageti_fulltext_ad', 'trageti_fulltext_au']),
    );
    expect(getObjects(db, 'index')).toEqual(
      expect.arrayContaining([
        'trageti_idx_assertions_ns_pos',
        'trageti_idx_assertions_entity',
        'trageti_idx_assertions_episode',
        'trageti_idx_assertions_supersedes',
        'trageti_idx_links_from',
        'trageti_idx_links_source_episode',
        'trageti_idx_links_to',
        'trageti_idx_episodes_ns_pos',
        'trageti_idx_citations_assertion',
      ]),
    );
  });

  it('records tokenizer args in metadata and FTS5 DDL', () => {
    const runner = new MigrationRunner({
      tokenizer: 'unicode61',
      tokenizerArgs: ['remove_diacritics', '1'],
    });
    runner.applyMigrations(db);

    const metadata = db
      .prepare<
        [],
        { tokenizer: string; tokenizer_args: string }
      >('SELECT tokenizer, tokenizer_args FROM trageti_tokenizer WHERE id = 1')
      .get();
    const fts = getSchemaObjects(db).find((obj) => obj.name === 'trageti_fulltext');

    expect(metadata?.tokenizer).toBe('unicode61');
    expect(JSON.parse(metadata?.tokenizer_args ?? '[]') as string[]).toEqual(['remove_diacritics', '1']);
    expect(fts?.sql).toContain("tokenize='unicode61 remove_diacritics 1'");
  });

  it('supports vectorless namespaces from the baseline', () => {
    const runner = new MigrationRunner();
    runner.applyMigrations(db);

    expect(() => {
      db.prepare(
        'INSERT INTO trageti_namespaces (namespace, embedding_dimension, embedding_table) VALUES (?, ?, ?)',
      ).run('vectorless', null, null);
    }).not.toThrow();
  });
});
