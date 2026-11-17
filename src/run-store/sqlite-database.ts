/** Common prepared-query surface of the built-in Node and Bun SQLite drivers. */
export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): void;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare?(sql: string): SqliteStatement;
  query?(sql: string): SqliteStatement;
}

export function sqliteStatement(database: SqliteDatabase, sql: string): SqliteStatement {
  const prepared = database.query?.(sql) ?? database.prepare?.(sql);
  if (!prepared) throw new Error("The current SQLite runtime does not support prepared queries.");
  return prepared;
}

/** Keep mutations atomic, and use a deferred transaction for a consistent read snapshot. */
export function sqliteTransaction<T>(
  database: SqliteDatabase,
  change: () => T,
  mode: "IMMEDIATE" | "DEFERRED" = "IMMEDIATE"
): T {
  database.exec(`BEGIN ${mode}`);
  try {
    const result = change();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Best-effort rollback; the original error is rethrown below.
    }
    throw error;
  }
}
