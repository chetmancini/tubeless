import { DatabaseSync } from "node:sqlite";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
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

  it("rejects a missing path when initialize is false without creating it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tubeless-run-store-"));
    directories.push(directory);
    const filename = path.join(directory, "missing", "runs.sqlite");
    await expect(openSqlitePipelineRunStore(filename, { initialize: false })).rejects.toThrow();
    await expect(stat(filename)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.dirname(filename))).rejects.toMatchObject({ code: "ENOENT" });
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
