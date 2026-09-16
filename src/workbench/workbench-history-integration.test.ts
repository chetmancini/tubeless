import { chmod, link, mkdir, unlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { openSqlitePipelineRunStore } from "../run-store/run-store-sqlite.js";
import { TUBELESS_WORKBENCH_EXIT_CODE, runWorkbenchCli } from "./workbench.js";
import {
  captureIo,
  parseNdjson,
  writeActualPipelineCommandModule,
} from "./workbench.test-support.js";

describe("workbench history integration", () => {
  it("lists and shows projected history from the run store", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const databasePath = path.join(directory, "history", "runs.sqlite");

    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          databasePath,
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);

    const store = await openSqlitePipelineRunStore(databasePath);
    const events = await store.listEvents();
    await store.close();
    const runId = events[0]?.runId;
    expect(runId).toEqual(expect.any(String));

    const listIo = captureIo(directory);
    expect(await runWorkbenchCli(["history", "--store", databasePath], listIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(listIo.output.join("")).toContain(runId!);
    expect(listIo.output.join("")).toContain("command-fixture");
    expect(listIo.output.join("")).toContain("completed");

    const jsonListIo = captureIo(directory);
    expect(await runWorkbenchCli(["history", "--json", "--store", databasePath], jsonListIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(JSON.parse(jsonListIo.output.join(""))).toMatchObject({
      runs: [{ pipelineId: "command-fixture", runId, status: "completed" }],
    });

    const showIo = captureIo(directory);
    expect(await runWorkbenchCli(["history", "--store", databasePath, runId!], showIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(showIo.output.join("")).toContain(runId!);
    expect(showIo.output.join("")).toContain("work");
    expect(showIo.output.join("")).toContain("worked:hello");

    const jsonShowIo = captureIo(directory);
    expect(
      await runWorkbenchCli(["history", "--json", "--store", databasePath, runId!], jsonShowIo)
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(JSON.parse(jsonShowIo.output.join(""))).toMatchObject({
      logs: [expect.objectContaining({ message: "worked:hello", stepId: "work" })],
      pipelineId: "command-fixture",
      runId,
      status: "completed",
      steps: [expect.objectContaining({ id: "work", status: "completed" })],
    });
  });

  it("emits raw store events as NDJSON", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const databasePath = path.join(directory, "history", "runs.sqlite");

    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          databasePath,
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);

    const store = await openSqlitePipelineRunStore(databasePath);
    const stored = await store.listEvents();
    await store.close();
    const runId = stored[0]?.runId;

    const eventsIo = captureIo(directory);
    expect(await runWorkbenchCli(["history", "--events", "--store", databasePath], eventsIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    const listed = parseNdjson(eventsIo.output.join(""));
    expect(listed.map(({ name }) => name)).toEqual(stored.map(({ name }) => name));

    const scopedIo = captureIo(directory);
    expect(
      await runWorkbenchCli(["history", "--events", "--store", databasePath, runId!], scopedIo)
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(parseNdjson(scopedIo.output.join("")).every((event) => event.runId === runId)).toBe(
      true
    );
  });

  it("reads history from the default studio store path", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);

    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          ".tubeless/runs.sqlite",
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);

    const historyIo = captureIo(directory);
    expect(await runWorkbenchCli(["history"], historyIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(historyIo.output.join("")).toContain("command-fixture");
  });

  it("reads history from a read-only store file and directory", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const databasePath = path.join(directory, "history", "runs.sqlite");
    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          databasePath,
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    await chmod(databasePath, 0o444);
    await chmod(path.dirname(databasePath), 0o555);
    await chmod(directory, 0o555);
    try {
      const historyIo = captureIo(directory);
      expect(await runWorkbenchCli(["history", "--store", databasePath], historyIo)).toBe(
        TUBELESS_WORKBENCH_EXIT_CODE.success
      );
      expect(historyIo.output.join("")).toContain("command-fixture");
    } finally {
      await chmod(directory, 0o755);
      await chmod(path.dirname(databasePath), 0o755);
      await chmod(databasePath, 0o644);
    }
  });

  it("fails projected history when stdout cannot be written", async () => {
    const { PassThrough } = await import("node:stream");
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const databasePath = path.join(directory, "history", "runs.sqlite");
    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          databasePath,
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    const stdout = new PassThrough();
    stdout.on("error", () => undefined);
    stdout.destroy(new Error("broken pipe"));
    const historyIo = { ...captureIo(directory), stdout };
    expect(await runWorkbenchCli(["history", "--json", "--store", databasePath], historyIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(historyIo.errors.join("")).toMatch(/broken pipe|closed stream/);
  });

  it("rejects a missing store, unknown run, and combined json/events flags", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const databasePath = path.join(directory, "history", "runs.sqlite");

    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          databasePath,
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);

    const missingIo = captureIo(directory);
    expect(
      await runWorkbenchCli(
        ["history", "--store", path.join(directory, "missing.sqlite")],
        missingIo
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.load);
    expect(missingIo.errors.join("")).toContain("missing.sqlite");

    const invalidPath = path.join(directory, "not-a-store.sqlite");
    await writeFile(invalidPath, "not sqlite");
    const invalidIo = captureIo(directory);
    expect(await runWorkbenchCli(["history", "--store", invalidPath], invalidIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(invalidIo.errors.join("")).toMatch(/Error:/);

    const emptyPath = path.join(directory, "empty.sqlite");
    await writeFile(emptyPath, "");
    const emptyIo = captureIo(directory);
    expect(await runWorkbenchCli(["history", "--store", emptyPath], emptyIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(emptyIo.errors.join("")).toMatch(/not a pipeline run store|Error:/);

    const damagedPath = path.join(directory, "history", "damaged.sqlite");
    const goodStore = await openSqlitePipelineRunStore(damagedPath);
    await goodStore.export({
      name: "pipeline.started",
      payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
      pipelineId: "command-fixture",
      runId: "run-1",
      timestampMs: 1,
      version: 2,
    });
    await goodStore.close();
    const database = new DatabaseSync(damagedPath);
    database.exec("DROP TRIGGER IF EXISTS pipeline_run_events_no_update");
    database.exec("UPDATE pipeline_run_events SET payload_json = 'not-json'");
    database.close();
    const damagedIo = captureIo(directory);
    expect(await runWorkbenchCli(["history", "--store", damagedPath], damagedIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(damagedIo.errors.join("")).toMatch(/Error:/);

    const unknownIo = captureIo(directory);
    expect(
      await runWorkbenchCli(["history", "--store", databasePath, "missing-run"], unknownIo)
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(unknownIo.errors.join("")).toContain("missing-run");

    const conflictIo = captureIo(directory);
    expect(
      await runWorkbenchCli(["history", "--json", "--events", "--store", databasePath], conflictIo)
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(conflictIo.errors.join("")).toMatch(/json|events/i);
  });

  it("fails history with a load error when the store has a live writer or multiple hard links", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const databasePath = path.join(directory, "history", "runs.sqlite");
    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          databasePath,
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        captureIo(directory)
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);

    await writeFile(`${databasePath}-wal`, "not a checkpointed wal");
    const walIo = captureIo(directory);
    expect(await runWorkbenchCli(["history", "--store", databasePath], walIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(walIo.errors.join("")).toMatch(/^Error: .*(write-ahead|journal|sidecar)/im);
    expect(walIo.errors.join("")).not.toMatch(/\sat\s/);
    await unlink(`${databasePath}-wal`);

    const alias = path.join(directory, "alias", "store.sqlite");
    await mkdir(path.dirname(alias));
    await link(databasePath, alias);
    const linkIo = captureIo(directory);
    expect(await runWorkbenchCli(["history", "--store", alias], linkIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.load
    );
    expect(linkIo.errors.join("")).toMatch(/^Error: .*hard link/im);
    expect(linkIo.errors.join("")).not.toMatch(/\sat\s/);
  });
});
