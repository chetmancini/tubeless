import { DatabaseSync } from "node:sqlite";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlitePipelineRunStore } from "./run-store-sqlite.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function openTempStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
  directories.push(directory);
  return openSqlitePipelineRunStore(path.join(directory, "runs.sqlite"));
}

function startedEvent(runId: string, timestampMs: number, pipelineId = "import") {
  return {
    attributes: { dry_run: false },
    name: "pipeline.started" as const,
    pipelineId,
    runId,
    timestampMs,
    version: 1 as const,
  };
}

describe("SQLite pipeline run store", () => {
  it("persists ordered events and rejects mutation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);

    await store.export({
      attributes: { dry_run: false },
      name: "pipeline.started",
      pipelineId: "import",
      runId: "run-1",
      timestampMs: 10,
      version: 1,
    });
    await store.export({
      attemptId: "attempt-1",
      attributes: { level: "warn", message: "slow source" },
      name: "pipeline.log",
      pipelineId: "import",
      runId: "run-1",
      stepId: "load",
      timestampMs: 11,
      version: 1,
    });

    expect(await store.listEvents({ runId: "run-1" })).toEqual([
      expect.objectContaining({ id: 1, name: "pipeline.started" }),
      expect.objectContaining({
        attemptId: "attempt-1",
        attributes: { level: "warn", message: "slow source" },
        id: 2,
      }),
    ]);
    await store.close();

    const database = new DatabaseSync(filename);
    expect(() => database.exec("UPDATE pipeline_run_events SET pipeline_id = 'changed'")).toThrow(
      "pipeline_run_events is append-only"
    );
    expect(() => database.exec("DELETE FROM pipeline_run_events")).toThrow(
      "pipeline_run_events is append-only"
    );
    database.close();

    const reopened = await openSqlitePipelineRunStore(filename);
    expect(await reopened.listEvents()).toHaveLength(2);
    await reopened.close();
  });

  it("refuses a database created by a newer store schema", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-version-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const database = new DatabaseSync(filename);
    database.exec("PRAGMA user_version = 2");
    database.close();

    await expect(openSqlitePipelineRunStore(filename)).rejects.toThrow(
      "Unsupported pipeline run store schema version 2"
    );
  });

  it("clears all history while preserving append-only protection", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-clear-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export({
      attributes: { dry_run: false },
      name: "pipeline.started",
      pipelineId: "import",
      runId: "run-1",
      timestampMs: 10,
      version: 1,
    });

    await store.clearHistory();
    expect(await store.listEvents()).toEqual([]);
    await store.export({
      attributes: { dry_run: false },
      name: "pipeline.started",
      pipelineId: "import",
      runId: "run-2",
      timestampMs: 20,
      version: 1,
    });
    expect(await store.listEvents()).toEqual([expect.objectContaining({ id: 2, runId: "run-2" })]);
    await store.close();

    const database = new DatabaseSync(filename);
    expect(() => database.exec("DELETE FROM pipeline_run_events")).toThrow(
      "pipeline_run_events is append-only"
    );
    database.close();
  });

  it("treats afterId as an exclusive ascending cursor", async () => {
    const store = await openTempStore();
    await store.export(startedEvent("run-1", 10));
    await store.export(startedEvent("run-1", 11));
    await store.export(startedEvent("run-1", 12));

    const [first, second, third] = await store.listEvents();
    expect(await store.listEvents({ afterId: first!.id })).toEqual([
      expect.objectContaining({ id: second!.id, timestampMs: 11 }),
      expect.objectContaining({ id: third!.id, timestampMs: 12 }),
    ]);
    await store.close();
  });

  it("clamps listEvents limit to a non-empty page", async () => {
    const store = await openTempStore();
    for (let timestampMs = 10; timestampMs <= 14; timestampMs += 1) {
      await store.export(startedEvent("run-1", timestampMs));
    }

    expect(await store.listEvents({ limit: 2 })).toEqual([
      expect.objectContaining({ id: 1, timestampMs: 10 }),
      expect.objectContaining({ id: 2, timestampMs: 11 }),
    ]);
    expect(await store.listEvents({ limit: 0 })).toEqual([
      expect.objectContaining({ id: 1, timestampMs: 10 }),
    ]);
    expect(await store.listEvents({ limit: 999_999 })).toHaveLength(5);
    await store.close();
  });

  it("composes runId and pipelineId filters with afterId", async () => {
    const store = await openTempStore();
    await store.export(startedEvent("run-1", 10, "import"));
    await store.export(startedEvent("run-2", 11, "publish"));
    await store.export(startedEvent("run-1", 12, "import"));
    await store.export(startedEvent("run-2", 13, "publish"));

    const [first] = await store.listEvents({ runId: "run-1" });
    expect(await store.listEvents({ afterId: first!.id, runId: "run-1" })).toEqual([
      expect.objectContaining({ id: 3, runId: "run-1", pipelineId: "import" }),
    ]);
    expect(await store.listEvents({ afterId: first!.id, pipelineId: "import" })).toEqual([
      expect.objectContaining({ id: 3, pipelineId: "import", runId: "run-1" }),
    ]);
    await store.close();
  });

  it("returns every stored row when the default limit is used", async () => {
    const store = await openTempStore();
    await store.export(startedEvent("run-1", 10));
    await store.export(startedEvent("run-1", 11));
    await store.export(startedEvent("run-1", 12));

    expect(await store.listEvents()).toHaveLength(3);
    await store.close();
  });

  it("keeps the first inserted row when paging after id 0", async () => {
    const store = await openTempStore();
    await store.export(startedEvent("run-1", 10));
    await store.export(startedEvent("run-1", 11));

    const events = await store.listEvents();
    expect(events[0]?.id).toBe(1);
    expect(await store.listEvents({ afterId: 0 })).toEqual(events);
    await store.close();
  });

  it("can reopen an existing store without initializing it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();

    const reopened = await openSqlitePipelineRunStore(filename, { initialize: false });
    expect(await reopened.listEvents()).toHaveLength(1);
    await reopened.close();
  });

  it("reads an initialized store from a read-only file and directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await chmod(filename, 0o444);
    await chmod(directory, 0o555);
    try {
      const reopened = await openSqlitePipelineRunStore(filename, {
        initialize: false,
        readOnly: true,
      });
      expect(await reopened.listEvents()).toHaveLength(1);
      await reopened.close();
    } finally {
      await chmod(directory, 0o755);
      await chmod(filename, 0o644);
    }
  });

  it("does not create a shared-memory sidecar during a read-only open of a WAL snapshot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await unlink(`${filename}-shm`).catch(() => {});
    const reopened = await openSqlitePipelineRunStore(filename, {
      initialize: false,
      readOnly: true,
    });
    expect(await reopened.listEvents()).toHaveLength(1);
    await reopened.close();
    await expect(stat(`${filename}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create a shared-memory sidecar when a WAL snapshot is opened through a symlink", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const alias = path.join(directory, "alias", "store.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await mkdir(path.dirname(alias));
    await symlink(filename, alias);
    await unlink(`${filename}-shm`).catch(() => {});
    const reopened = await openSqlitePipelineRunStore(alias, {
      initialize: false,
      readOnly: true,
    });
    expect(await reopened.listEvents()).toHaveLength(1);
    await reopened.close();
    await expect(stat(`${filename}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${alias}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not mutate an existing shared-memory sidecar during a read-only open", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    const marker = Buffer.alloc(32_768, 0x5a);
    await writeFile(`${filename}-shm`, marker);
    const reopened = await openSqlitePipelineRunStore(filename, {
      initialize: false,
      readOnly: true,
    });
    expect(await reopened.listEvents()).toHaveLength(1);
    await reopened.close();
    expect(await readFile(`${filename}-shm`)).toEqual(marker);
  });

  it("refuses a read-only open when a WAL sidecar still has pending bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    const shmBefore = await readFile(`${filename}-shm`).catch(() => undefined);
    await writeFile(`${filename}-wal`, "not a checkpointed wal");
    const walBefore = await readFile(`${filename}-wal`);
    await expect(
      openSqlitePipelineRunStore(filename, { initialize: false, readOnly: true })
    ).rejects.toThrow(/write-ahead|journal|sidecar/i);
    expect(await readFile(`${filename}-wal`)).toEqual(walBefore);
    if (shmBefore === undefined) {
      await expect(stat(`${filename}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await readFile(`${filename}-shm`)).toEqual(shmBefore);
    }
  });

  it("refuses a read-only open when a WAL sidecar beside the realpath has pending bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const alias = path.join(directory, "alias", "store.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await mkdir(path.dirname(alias));
    await symlink(filename, alias);
    const shmBefore = await readFile(`${filename}-shm`).catch(() => undefined);
    await writeFile(`${filename}-wal`, "not a checkpointed wal");
    await expect(
      openSqlitePipelineRunStore(alias, { initialize: false, readOnly: true })
    ).rejects.toThrow(/write-ahead|journal|sidecar/i);
    if (shmBefore === undefined) {
      await expect(stat(`${filename}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await readFile(`${filename}-shm`)).toEqual(shmBefore);
    }
    await expect(stat(`${alias}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("surfaces the first append failure from flush and close", async () => {
    const store = await openTempStore();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => {
      void store.export({
        ...startedEvent("run-1", 10),
        attributes: cycle,
      });
    }).toThrow(/circular/i);
    expect(() => store.flush()).toThrow(/circular/i);
    expect(() => store.close()).toThrow(/circular/i);
  });

  it("does not treat a dangling WAL sidecar symlink as absent", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await unlink(`${filename}-wal`).catch(() => {});
    await unlink(`${filename}-shm`).catch(() => {});
    const missingWal = path.join(directory, "missing-wal");
    await symlink(missingWal, `${filename}-wal`);
    expect((await lstat(`${filename}-wal`)).isSymbolicLink()).toBe(true);
    await expect(stat(`${filename}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      openSqlitePipelineRunStore(filename, { initialize: false, readOnly: true })
    ).rejects.toThrow(/shared-memory|sidecar|write-ahead/i);
    await expect(stat(`${filename}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf("Bun" in globalThis)(
    "does not hide events behind an immutable fallback when a WAL sidecar is a dangling symlink",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
      directories.push(directory);
      const filename = path.join(directory, "runs.sqlite");
      const store = await openSqlitePipelineRunStore(filename);
      await store.export(startedEvent("run-1", 10));
      await store.close();
      await unlink(`${filename}-wal`).catch(() => {});
      const missingWal = path.join(directory, "missing-wal");
      await symlink(missingWal, `${filename}-wal`);
      expect((await lstat(`${filename}-wal`)).isSymbolicLink()).toBe(true);
      await expect(stat(`${filename}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
      await chmod(filename, 0o444);
      await chmod(directory, 0o555);
      try {
        await expect(
          openSqlitePipelineRunStore(filename, { initialize: false, readOnly: true })
        ).rejects.toThrow();
      } finally {
        await chmod(directory, 0o755);
        await chmod(filename, 0o644);
      }
    }
  );

  it("refuses a read-only open when a rollback journal still has pending bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "runs.sqlite");
    const store = await openSqlitePipelineRunStore(filename);
    await store.export(startedEvent("run-1", 10));
    await store.close();
    await writeFile(`${filename}-journal`, "not a recovered journal");
    const journalBefore = await readFile(`${filename}-journal`);
    await expect(
      openSqlitePipelineRunStore(filename, { initialize: false, readOnly: true })
    ).rejects.toThrow(/write-ahead|journal|sidecar/i);
    expect(await readFile(`${filename}-journal`)).toEqual(journalBefore);
  });

  it("rejects a missing path when initialize is false without creating it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const nested = path.join(directory, "missing", "runs.sqlite");
    const sibling = path.join(directory, "runs.sqlite");
    await expect(openSqlitePipelineRunStore(nested, { initialize: false })).rejects.toThrow(
      "is not a pipeline run store"
    );
    await expect(openSqlitePipelineRunStore(sibling, { initialize: false })).rejects.toThrow(
      "is not a pipeline run store"
    );
    await expect(stat(nested)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.dirname(nested))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(sibling)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an uninitialized file when initialize is false", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "empty.sqlite");
    const database = new DatabaseSync(filename);
    database.close();
    await expect(openSqlitePipelineRunStore(filename, { initialize: false })).rejects.toThrow(
      "is not a pipeline run store"
    );
  });
});
