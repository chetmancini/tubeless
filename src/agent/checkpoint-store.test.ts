import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMemoryAgentCheckpointStore } from "./memory-checkpoint-store.js";
import { openSqliteAgentCheckpointStore } from "./sqlite-checkpoint-store.js";

it.each(["memory", "sqlite"])(
  "%s leases are exclusive, isolated, persistent and closed after release",
  async (backend) => {
    const directory = await mkdtemp(join(tmpdir(), "tubeless-checkpoint-"));
    const store =
      backend === "sqlite"
        ? await openSqliteAgentCheckpointStore(join(directory, "state.db"))
        : createMemoryAgentCheckpointStore();
    try {
      for (const key of ["", " ", "x".repeat(4097)])
        await expect(store.acquire(key)).rejects.toMatchObject({
          code: "TUBELESS_AGENT_INVALID_CHECKPOINT_KEY",
        });
      const lease = await store.acquire("one");
      expect(await lease.read()).toBeUndefined();
      await lease.write("first");
      await expect(store.acquire("one")).rejects.toMatchObject({
        code: "TUBELESS_AGENT_EXECUTION_BUSY",
      });
      const other = await store.acquire("two");
      await other.write("second");
      expect(await lease.read()).toBe("first");
      expect(await other.read()).toBe("second");
      await other.close();
      await lease.close();
      await lease.close();
      await expect(lease.read()).rejects.toThrow("closed");
      await expect(lease.write("stale")).rejects.toThrow("closed");
      const resumed = await store.acquire("one");
      expect(await resumed.read()).toBe("first");
      await resumed.write("replacement");
      await resumed.close();
    } finally {
      if ("close" in store && typeof store.close === "function") store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

it("SQLite persists across store reopen and requires leases to drain before close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tubeless-checkpoint-"));
  try {
    const path = join(directory, "state.db");
    const store = await openSqliteAgentCheckpointStore(path);
    const lease = await store.acquire("one");
    expect(() => store.close()).toThrow("leases");
    await lease.write("committed");
    await lease.close();
    store.close();
    await expect(store.acquire("one")).rejects.toThrow("closed");
    const reopened = await openSqliteAgentCheckpointStore(path);
    const resumed = await reopened.acquire("one");
    expect(await resumed.read()).toBe("committed");
    await resumed.close();
    reopened.close();
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("SQLite rejects existing database files with group or other access before writing", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "tubeless-checkpoint-"));
  try {
    const path = join(directory, "state.db");
    const store = await openSqliteAgentCheckpointStore(path);
    store.close();
    const bytes = await readFile(path);
    for (const mode of [0o640, 0o604, 0o666]) {
      await chmod(path, mode);
      await expect(openSqliteAgentCheckpointStore(path)).rejects.toThrow("private");
      expect(await readFile(path)).toEqual(bytes);
      expect((await stat(path)).mode & 0o777).toBe(mode);
    }
    await chmod(path, 0o600);
    const reopened = await openSqliteAgentCheckpointStore(path);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("SQLite reclaims stale ownership even when its recorded PID belongs to a live process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tubeless-checkpoint-"));
  try {
    const path = join(directory, "state.db");
    await writeFile(path, "", { mode: 0o600 });
    const database = new DatabaseSync(path);
    database.exec(
      "CREATE TABLE agent_checkpoints (key TEXT PRIMARY KEY, checkpoint TEXT, host TEXT, pid INTEGER, owner TEXT) STRICT"
    );
    database
      .prepare("INSERT INTO agent_checkpoints VALUES (?, ?, ?, ?, ?)")
      .run("one", "committed", hostname(), process.pid, "dead-owner");
    database.close();
    const first = await openSqliteAgentCheckpointStore(path);
    const second = await openSqliteAgentCheckpointStore(path);
    try {
      const lease = await first.acquire("one");
      expect(await lease.read()).toBe("committed");
      await expect(second.acquire("one")).rejects.toMatchObject({
        code: "TUBELESS_AGENT_EXECUTION_BUSY",
      });
      const other = await second.acquire("two");
      await other.write("independent");
      await other.close();
      await lease.close();
      const resumed = await second.acquire("one");
      expect(await resumed.read()).toBe("committed");
      await resumed.close();
    } finally {
      first.close();
      second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("SQLite checks sidecar privacy and rejects database inode aliases", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "tubeless-checkpoint-"));
  try {
    const path = join(directory, "state.db");
    const store = await openSqliteAgentCheckpointStore(path);
    store.close();
    const sidecar = `${path}-wal`;
    await writeFile(sidecar, "sensitive", { mode: 0o600 });
    await chmod(sidecar, 0o644);
    await expect(openSqliteAgentCheckpointStore(path)).rejects.toThrow("private");
    expect(await readFile(sidecar, "utf8")).toBe("sensitive");
    await rm(sidecar);
    const alias = join(directory, "alias.db");
    await symlink(path, alias);
    await expect(openSqliteAgentCheckpointStore(alias)).rejects.toThrow("private");
    await rm(alias);
    await link(path, alias);
    await expect(openSqliteAgentCheckpointStore(alias)).rejects.toThrow("private");
    await expect(openSqliteAgentCheckpointStore(path)).rejects.toThrow("private");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("SQLite directory aliases share the same native ownership locks", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "tubeless-checkpoint-"));
  try {
    const alias = join(directory, "alias");
    await symlink(directory, alias);
    const first = await openSqliteAgentCheckpointStore(join(directory, "state.db"));
    const second = await openSqliteAgentCheckpointStore(join(alias, "state.db"));
    try {
      const lease = await first.acquire("one");
      await expect(second.acquire("one")).rejects.toMatchObject({
        code: "TUBELESS_AGENT_EXECUTION_BUSY",
      });
      await lease.close();
      const resumed = await second.acquire("one");
      await resumed.close();
    } finally {
      first.close();
      second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
