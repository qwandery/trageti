import type { Database } from 'better-sqlite3'
import type { SchemaExtensions, ColumnExtension, LibraryTable } from '../../domain/types.js'
import { SchemaExtensionError } from '../../errors/index.js'
import { LIBRARY_COLUMNS } from './columns.js'
import { quoteIdent } from '../../internal/sql-ident.js'

interface PragmaTableInfoRow {
  name: string
}

function getExistingColumns(db: Database, table: string): Set<string> {
  const rows = db.prepare<[], PragmaTableInfoRow>(`PRAGMA table_info(${quoteIdent(table)})`).all()
  return new Set(rows.map((r) => r.name.toLowerCase()))
}

export class SchemaExtensionApplier {
  /**
   * Validates extensions against safety rules. Throws SchemaExtensionError if
   * any violation is found. Must be called before apply().
   */
  validate(extensions: SchemaExtensions | undefined): void {
    if (!extensions) return
    const violations: string[] = []

    for (const col of extensions.columns ?? []) {
      if (col.column.toLowerCase().startsWith('trageti_')) {
        violations.push(
          `Column "${col.column}" on ${col.table}: names starting with "trageti_" are reserved for library use`,
        )
      }
      // No SQLite-reserved-keyword check: every identifier is `quoteIdent`-
      // quoted before interpolation into DDL (spec §1044-1046 forbids only the
      // `trageti_` prefix and library-column collisions).
      const libraryColumns = LIBRARY_COLUMNS[col.table]
      if (libraryColumns.includes(col.column.toLowerCase())) {
        violations.push(`Column "${col.column}" on ${col.table}: shadows a library-managed column`)
      }
    }

    for (const tbl of extensions.tables ?? []) {
      if (tbl.tableName.toLowerCase().startsWith('trageti_')) {
        violations.push(
          `Table "${tbl.tableName}": names starting with "trageti_" are reserved for library use`,
        )
      }
      if (tbl.referencesNamespace && !tbl.namespaceColumn) {
        violations.push(`Table "${tbl.tableName}": referencesNamespace requires namespaceColumn`)
      }
      // namespaceColumn follows the same identifier rules as extension columns
      // (spec §1044-1046): only the `trageti_` prefix is rejected — it is
      // `quoteIdent`-quoted before interpolation into DDL.
      if (tbl.namespaceColumn && tbl.namespaceColumn.toLowerCase().startsWith('trageti_')) {
        violations.push(
          `Table "${tbl.tableName}": namespaceColumn "${tbl.namespaceColumn}" must not start with "trageti_" (reserved for library use)`,
        )
      }
    }

    if (violations.length > 0) {
      throw new SchemaExtensionError(violations)
    }
  }

  /**
   * Applies validated extensions to the database. Wrapped in a single
   * transaction — all-or-nothing. Must call validate() first.
   */
  apply(db: Database, extensions: SchemaExtensions | undefined): void {
    if (!extensions) return

    db.transaction(() => {
      for (const col of extensions.columns ?? []) {
        this.addColumnIfAbsent(db, col)
      }
      for (const tbl of extensions.tables ?? []) {
        db.exec(tbl.createSQL)
        if (tbl.referencesNamespace && tbl.namespaceColumn) {
          const columns = db
            .prepare<[], PragmaTableInfoRow>(`PRAGMA table_info(${quoteIdent(tbl.tableName)})`)
            .all()
          if (!columns.some((column) => column.name === tbl.namespaceColumn)) {
            throw new SchemaExtensionError([
              `namespaceColumn "${tbl.namespaceColumn}" does not exist on table "${tbl.tableName}" after createSQL ran.`,
            ])
          }
        }
      }
    })()
  }

  /**
   * Returns the caller-added column names for a given table, diffed against
   * the library column list. Used to populate the extensions bag on returned rows.
   */
  getExtensionColumns(db: Database, table: LibraryTable): string[] {
    const existing = getExistingColumns(db, table)
    const librarySet = new Set(LIBRARY_COLUMNS[table].map((c) => c.toLowerCase()))
    return [...existing].filter((c) => !librarySet.has(c))
  }

  private addColumnIfAbsent(db: Database, col: ColumnExtension): void {
    const existing = getExistingColumns(db, col.table)
    if (!existing.has(col.column.toLowerCase())) {
      db.exec(
        `ALTER TABLE ${quoteIdent(col.table)} ADD COLUMN ${quoteIdent(col.column)} ${col.definition}`,
      )
    }
  }
}
