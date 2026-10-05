import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { agentError } from "./agent-state.js";
import type { AgentCheckpointStore } from "./checkpoint-types.js";
import { checkCheckpointKey } from "./checkpoint-key.js";

/** File-backed checkpoint storage using Node's built-in SQLite and per-key file locks. */
export interface SqliteAgentCheckpointStore extends AgentCheckpointStore {
  /** Close after all execution leases have been released. */
  close(): void;
}

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

async function checkPrivatePath(path: string, directory = false) {
  const info = await lstat(path);
  if (
    !(directory ? info.isDirectory() : info.isFile() && info.nlink === 1) ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new Error(`Agent checkpoint path must be private: ${path}`);
}

async function privateFile(path: string) {
  try {
    await (await open(path, "wx", 0o600)).close();
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  await checkPrivatePath(path);
}

/** Open durable SQLite checkpoints; process exit automatically releases execution ownership. */
export async function openSqliteAgentCheckpointStore(
  file: string
): Promise<SqliteAgentCheckpointStore> {
  const { DatabaseSync } = await import("node:sqlite");
  const requested = resolve(file);
  await mkdir(dirname(requested), { recursive: true });
  await privateFile(requested);
  // Canonicalize parent aliases so every store reaches the same per-key locks.
  const path = await realpath(requested);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await checkPrivatePath(`${path}${suffix}`);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  const locks = `${path}.leases`;
  await mkdir(locks, { recursive: true, mode: 0o700 });
  await checkPrivatePath(locks, true);
  const database = new DatabaseSync(path);
  try {
    database.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;"
    );
    database.exec(
      "CREATE TABLE IF NOT EXISTS agent_checkpoints (key TEXT PRIMARY KEY, checkpoint TEXT) STRICT"
    );
  } catch (error) {
    database.close();
    throw error;
  }
  let active = 0;
  let closed = false;
  return {
    acquire: async (key) => {
      checkCheckpointKey(key);
      if (closed) throw new Error("Agent checkpoint store is closed");
      const lockPath = `${locks}/${createHash("sha256").update(key).digest("hex")}.sqlite`;
      await privateFile(lockPath);
      if (closed) throw new Error("Agent checkpoint store is closed");
      const lock = new DatabaseSync(lockPath);
      try {
        // Keep this transaction open for the lease. SQLite releases its OS locks on process death.
        // Separate lock databases let unrelated execution keys run concurrently.
        lock.exec("BEGIN IMMEDIATE");
      } catch (error) {
        lock.close();
        if (error instanceof Error && "errcode" in error && error.errcode === 5)
          throw agentError(
            "TUBELESS_AGENT_EXECUTION_BUSY",
            `Agent execution ${key} is already owned`
          );
        throw error;
      }
      active++;
      let released = false;
      const check = () => {
        if (released || closed) throw new Error("Agent checkpoint lease is closed");
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
          database
            .prepare(
              "INSERT INTO agent_checkpoints (key, checkpoint) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET checkpoint = excluded.checkpoint"
            )
            .run(key, checkpoint);
        },
        close: async () => {
          if (released) return;
          lock.close();
          released = true;
          active--;
          // Retain the lock file: unlinking it could give another owner a different inode to lock.
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
