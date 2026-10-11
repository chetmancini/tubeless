import { DatabaseSync } from "node:sqlite";
import type { DurableStorageLike } from "./cloudflare-storage.js";

const FORBIDDEN =
  /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA\s+(journal_mode|user_version))\b/i;

/** Mimic Durable Object storage rules that matter to Tubeless, backed by node:sqlite. */
export function createFakeDurableStorage(): DurableStorageLike & {
  alarmAtMs(): number | undefined;
} {
  let database = new DatabaseSync(":memory:");
  let values = new Map<string, unknown>();
  let alarm: number | undefined;
  return {
    sql: {
      exec(query, ...bindings) {
        if (FORBIDDEN.test(query))
          throw new Error("To execute a transaction, please use transactionSync().");
        if (bindings.length > 100) throw new Error("too many SQL variables");
        // SAFETY: node:sqlite accepts the same scalar binding types the store passes.
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
        const result = fn();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    async get<T>(key: string) {
      // SAFETY: tests read back the values they wrote.
      return values.get(key) as T | undefined;
    },
    async put(key, value) {
      values.set(key, structuredClone(value));
    },
    async setAlarm(time) {
      alarm = time;
    },
    async deleteAlarm() {
      alarm = undefined;
    },
    async deleteAll() {
      database = new DatabaseSync(":memory:");
      values = new Map();
    },
    alarmAtMs: () => alarm,
  };
}
