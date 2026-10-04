import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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
