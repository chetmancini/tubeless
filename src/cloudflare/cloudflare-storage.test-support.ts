import { DatabaseSync } from "node:sqlite";
import type { DurableStorageLike } from "./cloudflare-storage.js";

const FORBIDDEN =
  /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA\s+(journal_mode|user_version))\b/i;

function sqlSkeleton(query: string): string {
  return query.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (token) =>
    token.startsWith("'") ? "''" : " "
  );
}

/** Durable Objects run exactly one statement per exec; a trigger body may contain `;`. */
function hasMultipleStatements(skeleton: string): boolean {
  const statement = /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(skeleton)
    ? skeleton.replace(/\bBEGIN\b[\s\S]*\bEND\b(?=\s*;?\s*$)/i, " ")
    : skeleton;
  return /;\s*\S/.test(statement);
}

/**
 * Mimic Durable Object storage rules that matter to Tubeless, backed by node:sqlite.
 * SQL savepoints let a store's synchronous transaction join an outer storage transaction.
 */
export function createFakeDurableStorage(): DurableStorageLike & {
  alarmAtMs(): number | undefined;
} {
  const database = new DatabaseSync(":memory:");
  let values = new Map<string, unknown>();
  let alarm: number | undefined;
  let nextSavepoint = 0;
  let pending: Promise<unknown> = Promise.resolve();
  return {
    sql: {
      exec(query, ...bindings) {
        const skeleton = sqlSkeleton(query);
        if (FORBIDDEN.test(skeleton))
          throw new Error("To execute a transaction, please use transactionSync().");
        if (hasMultipleStatements(skeleton))
          throw new Error("SQL execution error: more than one statement per exec.");
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
      const savepoint = `sync_${nextSavepoint++}`;
      database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = fn();
        database.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        database.exec(`ROLLBACK TO ${savepoint}`);
        database.exec(`RELEASE ${savepoint}`);
        throw error;
      }
    },
    transaction(fn) {
      const result = pending.then(async () => {
        const savedValues = new Map(values);
        const savedAlarm = alarm;
        database.exec("BEGIN");
        try {
          const value = await fn();
          database.exec("COMMIT");
          return value;
        } catch (error) {
          database.exec("ROLLBACK");
          values = savedValues;
          alarm = savedAlarm;
          throw error;
        }
      });
      pending = result.catch(() => {});
      return result;
    },
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put(key, value) {
      values.set(key, structuredClone(value));
    },
    async delete(key) {
      return values.delete(key);
    },
    async getAlarm() {
      return alarm ?? null;
    },
    async setAlarm(time) {
      alarm = time;
    },
    async deleteAlarm() {
      alarm = undefined;
    },
    alarmAtMs: () => alarm,
  };
}
