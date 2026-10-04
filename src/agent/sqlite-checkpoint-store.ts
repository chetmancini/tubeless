import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { agentError } from "./agent-state.js";
import type { AgentCheckpointStore } from "./checkpoint-types.js";
import { checkCheckpointKey } from "./checkpoint-key.js";

/** File-backed checkpoint storage using Node's built-in SQLite and per-key process ownership. */
export interface SqliteAgentCheckpointStore extends AgentCheckpointStore {
  /** Close after all execution leases have been released. */
  close(): void;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}

/** Open durable SQLite checkpoints; dead owners on this host are reclaimed atomically. */
export async function openSqliteAgentCheckpointStore(
  file: string
): Promise<SqliteAgentCheckpointStore> {
  const { DatabaseSync } = await import("node:sqlite");
  const path = resolve(file);
  await mkdir(dirname(path), { recursive: true });
  try {
    await (await open(path, "wx", 0o600)).close();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const database = new DatabaseSync(path);
  try {
    database.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;"
    );
    database.exec(
      "CREATE TABLE IF NOT EXISTS agent_checkpoints (key TEXT PRIMARY KEY, checkpoint TEXT, host TEXT, pid INTEGER, owner TEXT) STRICT"
    );
  } catch (error) {
    database.close();
    throw error;
  }
  const host = hostname();
  let active = 0;
  let closed = false;
  const transaction = <T>(work: () => T): T => {
    if (closed) throw new Error("Agent checkpoint store is closed");
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      database.exec("COMMIT");
      return value;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };
  return {
    acquire: async (key) => {
      checkCheckpointKey(key);
      const owner = randomUUID();
      transaction(() => {
        const row = database
          .prepare("SELECT host, pid, owner FROM agent_checkpoints WHERE key = ?")
          .get(key);
        if (
          row?.owner !== null &&
          row?.owner !== undefined &&
          (row.host !== host || typeof row.pid !== "number" || alive(row.pid))
        )
          throw agentError(
            "TUBELESS_AGENT_EXECUTION_BUSY",
            `Agent execution ${key} is already owned`
          );
        database
          .prepare(
            "INSERT INTO agent_checkpoints (key, host, pid, owner) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET host = excluded.host, pid = excluded.pid, owner = excluded.owner"
          )
          .run(key, host, process.pid, owner);
      });
      active++;
      let released = false;
      const check = () => {
        if (released || closed) throw new Error("Agent checkpoint lease is closed");
        const row = database.prepare("SELECT owner FROM agent_checkpoints WHERE key = ?").get(key);
        if (row?.owner !== owner) throw new Error("Agent checkpoint ownership was lost");
      };
      return {
        read: async () => {
          check();
          const row = database
            .prepare("SELECT checkpoint FROM agent_checkpoints WHERE key = ?")
            .get(key);
          return typeof row?.checkpoint === "string" ? row.checkpoint : undefined;
        },
        write: async (checkpoint) => {
          check();
          const result = database
            .prepare("UPDATE agent_checkpoints SET checkpoint = ? WHERE key = ? AND owner = ?")
            .run(checkpoint, key, owner);
          if (result.changes !== 1) throw new Error("Agent checkpoint ownership was lost");
        },
        close: async () => {
          if (released) return;
          database
            .prepare(
              "UPDATE agent_checkpoints SET owner = NULL, host = NULL, pid = NULL WHERE key = ? AND owner = ?"
            )
            .run(key, owner);
          released = true;
          active--;
        },
      };
    },
    close: () => {
      if (closed) return;
      if (active)
        throw new Error("Close agent execution leases before closing the checkpoint store");
      database.close();
      closed = true;
    },
  };
}
