import { DatabaseSync } from "node:sqlite";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import {
  RUN_EVENT_INSERT_SQL,
  RUN_EVENT_TABLE_STATEMENTS,
  RUN_EVENT_TRIGGER_STATEMENTS,
  runEventRow,
  runEventListQuery,
  storedRunEvent,
  type RunEventRecord,
} from "../run-store/run-store-sql.js";
import { SqliteHostedLaunchStore, type SqliteLaunchStorage } from "./launch-store-sqlite.js";

/** A second, plain SQLite adapter: no Durable Object storage, alarms, KV or schema metadata. */
export function createSqliteLaunchStoreFixture(filename = ":memory:") {
  const database = new DatabaseSync(filename);
  for (const statement of [...RUN_EVENT_TABLE_STATEMENTS, ...RUN_EVENT_TRIGGER_STATEMENTS])
    database.exec(statement);
  const storage: SqliteLaunchStorage = {
    sql: {
      exec(query, ...bindings) {
        // SAFETY: fixtures supply SQLite scalar bindings and read row objects.
        const rows = database.prepare(query).all(...(bindings as never[])) as Record<
          string,
          unknown
        >[];
        return { toArray: () => rows };
      },
    },
    transactionSync(fn) {
      database.exec("BEGIN");
      try {
        const value = fn();
        database.exec("COMMIT");
        return value;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  let closed = false;
  const events = {
    append(events: readonly PipelineTraceEvent[]) {
      for (const event of events) storage.sql.exec(RUN_EVENT_INSERT_SQL, ...runEventRow(event));
    },
    async listEvents(query = {}) {
      const { sql, params } = runEventListQuery(query);
      // SAFETY: this query reads complete rows from the owned event table.
      return (storage.sql.exec(sql, ...params).toArray() as unknown as RunEventRecord[]).map(
        storedRunEvent
      );
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
  return {
    storage,
    events,
    store: new SqliteHostedLaunchStore(storage, events),
    readLaunch(launchId: string) {
      return storage.sql
        .exec("SELECT * FROM tubeless_launches WHERE launch_id = ?", launchId)
        .toArray()[0];
    },
  };
}
