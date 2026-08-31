import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { PipelineTraceEvent } from "./tracing.js";
import type {
  PipelineRunEventQuery,
  PipelineRunEventStore,
  StoredPipelineEvent,
} from "./run-store.js";

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): void;
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare?(sql: string): SqliteStatement;
  query?(sql: string): SqliteStatement;
}

interface SqliteOpenOptions {
  create?: boolean;
  readOnly?: boolean;
  readonly?: boolean;
  readwrite?: boolean;
}

interface SqliteModule {
  Database?: new (filename: string, options?: SqliteOpenOptions) => SqliteDatabase;
  DatabaseSync?: new (filename: string, options?: SqliteOpenOptions) => SqliteDatabase;
}

interface StoredEventRow {
  attempt_id: string | null;
  attributes_json: string;
  duration_ms: number | null;
  error_json: string | null;
  event_name: PipelineTraceEvent["name"];
  id: number | bigint;
  item_key: string | null;
  parent_run_id: string | null;
  pipeline_id: string;
  run_id: string;
  step_id: string | null;
  timestamp_ms: number | bigint;
  version: 1;
}

const RUN_EVENT_STORE_VERSION = 1;

const RUN_EVENT_STORE_APPEND_ONLY_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS pipeline_run_events_no_update
  BEFORE UPDATE ON pipeline_run_events
  BEGIN
    SELECT RAISE(ABORT, 'pipeline_run_events is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS pipeline_run_events_no_delete
  BEFORE DELETE ON pipeline_run_events
  BEGIN
    SELECT RAISE(ABORT, 'pipeline_run_events is append-only');
  END;
`;

const RUN_EVENT_STORE_SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS pipeline_run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    parent_run_id TEXT,
    pipeline_id TEXT NOT NULL,
    step_id TEXT,
    attempt_id TEXT,
    item_key TEXT,
    event_name TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    duration_ms REAL,
    attributes_json TEXT NOT NULL,
    error_json TEXT
  );

  CREATE INDEX IF NOT EXISTS pipeline_run_events_run_id_idx
    ON pipeline_run_events(run_id, id);
  CREATE INDEX IF NOT EXISTS pipeline_run_events_pipeline_id_idx
    ON pipeline_run_events(pipeline_id, id DESC);
  CREATE INDEX IF NOT EXISTS pipeline_run_events_timestamp_idx
    ON pipeline_run_events(timestamp_ms DESC);

  ${RUN_EVENT_STORE_APPEND_ONLY_TRIGGERS}
`;

/** SQLite event store plus the explicit all-history maintenance operation. */
export interface SqlitePipelineRunStore extends PipelineRunEventStore {
  /** Delete every recorded event and compact the database; individual mutation stays forbidden. */
  clearHistory(): void | Promise<void>;
}

function statement(database: SqliteDatabase, sql: string): SqliteStatement {
  const prepared = database.query?.(sql) ?? database.prepare?.(sql);
  if (!prepared) throw new Error("The current SQLite runtime does not support prepared queries.");
  return prepared;
}

async function loadSqliteModule(): Promise<SqliteModule> {
  const specifier = "Bun" in globalThis ? "bun:sqlite" : "node:sqlite";
  // SAFETY: The dynamic import resolves to the built-in sqlite module whose
  // runtime shape is the `SqliteModule` interface we depend on.
  return (await import(specifier)) as SqliteModule;
}

async function openDatabase(
  filename: string,
  options: { create?: boolean; readOnly?: boolean } = {}
): Promise<SqliteDatabase> {
  const module = await loadSqliteModule();
  const Database = module.Database ?? module.DatabaseSync;
  if (!Database) throw new Error("No synchronous SQLite database implementation is available.");
  const bunSqlite = "Bun" in globalThis;
  const create = options.create !== false;
  const readOnly = options.readOnly === true;
  if (readOnly) {
    await sqliteAssertImmutableInspect(filename);
    const database = openReadableDatabase(
      Database,
      `${pathToFileURL(filename).href}?mode=ro&immutable=1`
    );
    try {
      await sqliteAssertImmutableInspect(filename);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
  if (!create) {
    if (bunSqlite) {
      return openReadableDatabase(Database, filename, { create: false, readwrite: true });
    }
    // Node's DatabaseSync ignores `{ create: false }` and creates an empty
    // file. `mode=rw` fails closed when the path is missing.
    return openReadableDatabase(Database, `${pathToFileURL(filename).href}?mode=rw`);
  }
  return new Database(filename);
}

function isMissingDirectoryEntry(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT";
}

async function sqliteSidecarExists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    // SAFETY: Node fs rejects with ErrnoException. Only ENOENT is a missing
    // directory entry; EACCES/EPERM and other inspect failures stay present.
    if (isMissingDirectoryEntry(error as NodeJS.ErrnoException) === false) return true;
  }
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    // SAFETY: Same Node fs ErrnoException contract as the stat() branch.
    return isMissingDirectoryEntry(error as NodeJS.ErrnoException) === false;
  }
}

async function sqliteSidecarTargets(filename: string): Promise<readonly string[]> {
  const targets: string[] = [];
  try {
    targets.push(await realpath(filename));
  } catch {
    // Missing or unresolvable; still check the given name.
  }
  if (targets.includes(filename) === false) targets.push(filename);
  return targets;
}

async function sqliteDatabaseHasMultipleLinks(filename: string): Promise<boolean> {
  for (const target of await sqliteSidecarTargets(filename)) {
    try {
      if ((await stat(target)).nlink > 1) return true;
    } catch {
      return true;
    }
  }
  return false;
}

async function sqliteAssertImmutableInspect(filename: string): Promise<void> {
  const pending = await sqlitePendingTransactionalSidecar(filename);
  if (pending !== undefined) {
    throw new Error(
      `${filename} has a write-ahead log or rollback journal that a read-only open cannot apply without writing a sidecar.`
    );
  }
  if (await sqliteDatabaseHasMultipleLinks(filename)) {
    throw new Error(
      `${filename} has multiple hard links; a read-only open cannot locate a writer's write-ahead log beside another name.`
    );
  }
}

async function sqlitePendingTransactionalSidecar(filename: string): Promise<string | undefined> {
  for (const target of await sqliteSidecarTargets(filename)) {
    for (const suffix of ["-journal", "-wal"] as const) {
      const sidecar = `${target}${suffix}`;
      if ((await sqliteSidecarExists(sidecar)) === false) continue;
      try {
        if ((await stat(sidecar)).size > 0) return sidecar;
      } catch {
        return sidecar;
      }
    }
  }
  return undefined;
}

function openReadableDatabase(
  Database: new (filename: string, options?: SqliteOpenOptions) => SqliteDatabase,
  filename: string,
  options?: SqliteOpenOptions
): SqliteDatabase {
  const database = options === undefined ? new Database(filename) : new Database(filename, options);
  try {
    statement(database, "PRAGMA user_version").all();
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function mapRow(row: StoredEventRow): StoredPipelineEvent {
  const event: StoredPipelineEvent = {
    // SAFETY: attributes_json was written by this store via JSON.stringify of a
    // PipelineTraceEvent["attributes"] value, so parsing yields the same shape.
    attributes: JSON.parse(row.attributes_json) as PipelineTraceEvent["attributes"],
    id: Number(row.id),
    name: row.event_name,
    pipelineId: row.pipeline_id,
    runId: row.run_id,
    timestampMs: Number(row.timestamp_ms),
    version: row.version,
  };
  if (row.attempt_id) event.attemptId = row.attempt_id;
  if (row.duration_ms !== null) event.durationMs = Number(row.duration_ms);
  if (row.error_json) {
    // SAFETY: error_json was written by this store via JSON.stringify of a
    // NonNullable<PipelineTraceEvent["error"]> value, so parsing yields the same shape.
    event.error = JSON.parse(row.error_json) as NonNullable<PipelineTraceEvent["error"]>;
  }
  if (row.item_key) event.itemKey = row.item_key;
  if (row.parent_run_id) event.parentRunId = row.parent_run_id;
  if (row.step_id) event.stepId = row.step_id;
  return event;
}

/** Options for `openSqlitePipelineRunStore`. */
export interface OpenSqlitePipelineRunStoreOptions {
  /**
   * When `false`, reject a path that is not already a versioned run store
   * and do not create parent directories or a database file.
   * Defaults to `true` so `run --store` and `ui` can create the database.
   */
  readonly initialize?: boolean;
  /**
   * Open the file without creating it or writing WAL/sidecars.
   * A leftover empty `-wal` is ignored and the main file is opened
   * immutable. A non-empty `-wal` or `-journal`, a multiply linked
   * database file, or a WAL that appears during the open or a later
   * `listEvents` is refused so pending events are not dropped.
   * `history` uses this so a supplied finished artifact can be inspected
   * without rewriting `-shm`.
   */
  readonly readOnly?: boolean;
}

/**
 * Open the optional local SQLite trace store used by `tubeless run --store`,
 * `tubeless history`, and `tubeless ui`. The main executor never imports this module.
 */
export async function openSqlitePipelineRunStore(
  filename: string,
  options: OpenSqlitePipelineRunStoreOptions = {}
): Promise<SqlitePipelineRunStore> {
  const readOnly = options.readOnly === true;
  const initialize = options.initialize !== false && !readOnly;
  const resolvedFilename = filename === ":memory:" ? filename : path.resolve(filename);
  if (resolvedFilename !== ":memory:" && initialize) {
    await mkdir(path.dirname(resolvedFilename), { recursive: true });
  }
  if (resolvedFilename !== ":memory:" && !initialize) {
    try {
      await stat(resolvedFilename);
    } catch {
      throw new Error(`${resolvedFilename} is not a pipeline run store.`);
    }
  }
  const database = await openDatabase(resolvedFilename, { create: initialize, readOnly });
  try {
    // SAFETY: `PRAGMA user_version` always returns a single row with a
    // `user_version` column, so the first result row matches this shape.
    const versionRow = statement(database, "PRAGMA user_version").all()[0] as
      | { user_version?: number | bigint }
      | undefined;
    const version = Number(versionRow?.user_version ?? 0);
    if (version !== 0 && version !== RUN_EVENT_STORE_VERSION) {
      throw new Error(
        `Unsupported pipeline run store schema version ${version}; expected ${RUN_EVENT_STORE_VERSION}.`
      );
    }
    if (!initialize && version !== RUN_EVENT_STORE_VERSION) {
      throw new Error(`${resolvedFilename} is not a pipeline run store.`);
    }
    if (initialize) {
      database.exec(RUN_EVENT_STORE_SCHEMA);
      database.exec(`PRAGMA user_version = ${RUN_EVENT_STORE_VERSION}`);
    }
  } catch (error) {
    database.close();
    throw error;
  }
  const insert = statement(
    database,
    `INSERT INTO pipeline_run_events (
      version, run_id, parent_run_id, pipeline_id, step_id, attempt_id, item_key,
      event_name, timestamp_ms, duration_ms, attributes_json, error_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let closed = false;
  let exportError: Error | undefined;

  return {
    export(event) {
      if (closed) throw new Error("Cannot append to a closed pipeline run store.");
      if (exportError) throw exportError;
      try {
        insert.run(
          event.version,
          event.runId,
          event.parentRunId ?? null,
          event.pipelineId,
          event.stepId ?? null,
          event.attemptId ?? null,
          event.itemKey ?? null,
          event.name,
          event.timestampMs,
          event.durationMs ?? null,
          JSON.stringify(event.attributes),
          event.error ? JSON.stringify(event.error) : null
        );
      } catch (error) {
        exportError = error instanceof Error ? error : new Error(String(error));
        throw exportError;
      }
    },
    flush() {
      if (exportError) throw exportError;
    },
    async listEvents(query: PipelineRunEventQuery = {}) {
      if (closed) throw new Error("Cannot query a closed pipeline run store.");
      if (readOnly && resolvedFilename !== ":memory:") {
        await sqliteAssertImmutableInspect(resolvedFilename);
      }
      const predicates: string[] = [];
      const params: unknown[] = [];
      if (query.afterId !== undefined) {
        predicates.push("id > ?");
        params.push(query.afterId);
      }
      if (query.pipelineId !== undefined) {
        predicates.push("pipeline_id = ?");
        params.push(query.pipelineId);
      }
      if (query.runId !== undefined) {
        predicates.push("run_id = ?");
        params.push(query.runId);
      }
      const limit = Math.max(1, Math.min(100_000, Math.floor(query.limit ?? 20_000)));
      params.push(limit);
      const where = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
      // SAFETY: The SELECT * columns match the StoredEventRow interface exactly
      // (the table schema is owned by this module), so each result row is one.
      const rows = statement(
        database,
        `SELECT * FROM pipeline_run_events ${where} ORDER BY id ASC LIMIT ?`
      ).all(...params) as StoredEventRow[];
      if (readOnly && resolvedFilename !== ":memory:") {
        await sqliteAssertImmutableInspect(resolvedFilename);
      }
      return rows.map(mapRow);
    },
    clearHistory() {
      if (closed) throw new Error("Cannot clear a closed pipeline run store.");
      try {
        database.exec(`
          BEGIN IMMEDIATE;
          DROP TRIGGER IF EXISTS pipeline_run_events_no_update;
          DROP TRIGGER IF EXISTS pipeline_run_events_no_delete;
          DELETE FROM pipeline_run_events;
          ${RUN_EVENT_STORE_APPEND_ONLY_TRIGGERS}
          COMMIT;
        `);
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {}
        throw error;
      }
      database.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
      if (exportError) throw exportError;
    },
  };
}
