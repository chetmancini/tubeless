import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
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
});
