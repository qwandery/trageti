import type { Database } from 'better-sqlite3';
import type { SchemaExtensions, ColumnExtension, LibraryTable } from '../../domain/types.js';
import { SchemaExtensionError } from '../../errors/index.js';
import { LIBRARY_COLUMNS } from './columns.js';
import { quoteIdent } from '../../internal/sql-ident.js';

interface PragmaTableInfoRow {
  name: string;
}

const SIDE_EFFECTING_SQL = /\b(ALTER|ATTACH|CREATE|DELETE|DETACH|DROP|INSERT|PRAGMA|REINDEX|REPLACE|SELECT|UPDATE|VACUUM)\b/i;
const UNSAFE_COLUMN_CONSTRAINTS = /\b(REFERENCES|PRIMARY\s+KEY|UNIQUE|GENERATED|AS)\b/i;
const SAFE_COLUMN_DEFINITION =
  /^(?:[A-Za-z][A-Za-z0-9_]*(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)(?:\s+(?:NOT\s+NULL|NULL|COLLATE\s+[A-Za-z_][A-Za-z0-9_]*|DEFAULT\s+(?:NULL|CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP|[-+]?\d+(?:\.\d+)?|'[^']*'|"[^"]*")|CHECK\s*\([^;]*\)))*$/i;

function containsUnsafeControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) return true;
  }
  return false;
}

function getExistingColumnNames(db: Database, table: string): string[] {
  const rows = db.prepare<[], PragmaTableInfoRow>(`PRAGMA table_info(${quoteIdent(table)})`).all();
  return rows.map((r) => r.name);
}

function getExistingColumns(db: Database, table: string): Set<string> {
  return new Set(getExistingColumnNames(db, table).map((name) => name.toLowerCase()));
}

export class SchemaExtensionApplier {
  /**
   * Validates extensions against safety rules. Throws SchemaExtensionError if
   * any violation is found. Must be called before apply().
   */
  validate(extensions: SchemaExtensions | undefined): void {
    if (!extensions) return;
    const violations: string[] = [];

    for (const col of extensions.columns ?? []) {
      if (col.column.toLowerCase().startsWith('trageti_')) {
        violations.push(
          `Column "${col.column}" on ${col.table}: names starting with "trageti_" are reserved for library use`,
        );
      }
      // No SQLite-reserved-keyword check: every identifier is `quoteIdent`-
      // quoted before interpolation into DDL (spec §1044-1046 forbids only the
      // `trageti_` prefix and library-column collisions).
      const libraryColumns = LIBRARY_COLUMNS[col.table];
      if (libraryColumns.includes(col.column.toLowerCase())) {
        violations.push(`Column "${col.column}" on ${col.table}: shadows a library-managed column`);
      }
      const definitionError = this.validateColumnDefinition(col);
      if (definitionError) violations.push(definitionError);
    }

    for (const tbl of extensions.tables ?? []) {
      if (tbl.tableName.toLowerCase().startsWith('trageti_')) {
        violations.push(`Table "${tbl.tableName}": names starting with "trageti_" are reserved for library use`);
      }
      if (tbl.referencesNamespace && !tbl.namespaceColumn) {
        violations.push(`Table "${tbl.tableName}": referencesNamespace requires namespaceColumn`);
      }
      // namespaceColumn follows the same identifier rules as extension columns
      // (spec §1044-1046): only the `trageti_` prefix is rejected — it is
      // `quoteIdent`-quoted before interpolation into DDL.
      if (tbl.namespaceColumn && tbl.namespaceColumn.toLowerCase().startsWith('trageti_')) {
        violations.push(
          `Table "${tbl.tableName}": namespaceColumn "${tbl.namespaceColumn}" must not start with "trageti_" (reserved for library use)`,
        );
      }
    }

    if (violations.length > 0) {
      throw new SchemaExtensionError(violations);
    }
  }

  /**
   * Applies validated extensions to the database. Wrapped in a single
   * transaction — all-or-nothing. Must call validate() first.
   */
  apply(db: Database, extensions: SchemaExtensions | undefined): void {
    if (!extensions) return;

    db.transaction(() => {
      for (const col of extensions.columns ?? []) {
        this.addColumnIfAbsent(db, col);
      }
      for (const tbl of extensions.tables ?? []) {
        this.validateCreateTableSql(tbl.tableName, tbl.createSQL);
        db.exec(tbl.createSQL);
        if (tbl.referencesNamespace && tbl.namespaceColumn) {
          const columns = db.prepare<[], PragmaTableInfoRow>(`PRAGMA table_info(${quoteIdent(tbl.tableName)})`).all();
          if (!columns.some((column) => column.name === tbl.namespaceColumn)) {
            throw new SchemaExtensionError([
              `namespaceColumn "${tbl.namespaceColumn}" does not exist on table "${tbl.tableName}" after createSQL ran.`,
            ]);
          }
        }
      }
    })();
  }

  /**
   * Returns the caller-added column names for a given table, diffed against
   * the library column list. Used to populate the extensions bag on returned rows.
   */
  getExtensionColumns(db: Database, table: LibraryTable): string[] {
    const existing = getExistingColumnNames(db, table);
    const librarySet = new Set(LIBRARY_COLUMNS[table].map((c) => c.toLowerCase()));
    return existing.filter((c) => !librarySet.has(c.toLowerCase()));
  }

  private addColumnIfAbsent(db: Database, col: ColumnExtension): void {
    const existing = getExistingColumns(db, col.table);
    if (!existing.has(col.column.toLowerCase())) {
      const definitionError = this.validateColumnDefinition(col);
      if (definitionError) throw new SchemaExtensionError([definitionError]);
      db.exec(`ALTER TABLE ${quoteIdent(col.table)} ADD COLUMN ${quoteIdent(col.column)} ${col.definition}`);
    }
  }

  private validateColumnDefinition(col: ColumnExtension): string | null {
    const definition = col.definition.trim();
    const label = `Column "${col.column}" on ${col.table}`;
    if (definition.length === 0) return `${label}: definition is required`;
    if (containsUnsafeControlCharacter(definition)) {
      return `${label}: definition contains control characters`;
    }
    if (definition.includes(';')) return `${label}: definition must be a single column definition`;
    if (definition.includes('--') || /\/\*/.test(definition)) return `${label}: definition must not contain SQL comments`;
    if (SIDE_EFFECTING_SQL.test(definition)) return `${label}: definition contains unsupported SQL keywords`;
    if (UNSAFE_COLUMN_CONSTRAINTS.test(definition)) return `${label}: definition contains unsupported constraints`;
    if (!SAFE_COLUMN_DEFINITION.test(definition)) {
      return `${label}: definition is outside the supported ALTER TABLE ADD COLUMN subset`;
    }
    return null;
  }

  private validateCreateTableSql(tableName: string, createSQL: string): void {
    const trimmed = createSQL.trim().replace(/;+\s*$/, '');
    if (trimmed.includes(';')) {
      throw new SchemaExtensionError([`Table "${tableName}": createSQL must contain exactly one CREATE TABLE statement`]);
    }
    const match = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/i.exec(
      trimmed,
    );
    const declared = match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4] ?? null;
    if (!declared || declared.toLowerCase() !== tableName.toLowerCase()) {
      throw new SchemaExtensionError([
        `Table "${tableName}": createSQL must be a CREATE TABLE statement for the declared table`,
      ]);
    }
  }
}
