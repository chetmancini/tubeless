import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { openSqlitePipelineRunStore } from "../run-store/run-store-sqlite.js";
import { writeCliChunk } from "./workbench-shared.js";
import { TUBELESS_WORKBENCH_EXIT_CODE, runWorkbenchCli } from "./workbench.js";
import {
  captureIo,
  directoryIgnoresCase,
  execFileAsync,
  parseNdjson,
  writeActualPipelineCommandModule,
} from "./workbench.test-support.js";

describe("workbench run integration", () => {
  it("prefers an explicit pipeline command and runs arguments after the boundary", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(
      ["run", "pipeline.mjs", "--", "--message", "hello", "--target", "work"],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors).toEqual([]);
    expect(io.output.join("")).toContain("worked:hello");
    expect(io.output.join("")).toContain("completed:hello");
  });

  it("records a run only when the optional SQLite store is requested", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const databasePath = path.join(directory, "history", "runs.sqlite");

    const exitCode = await runWorkbenchCli(
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
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    const store = await openSqlitePipelineRunStore(databasePath);
    const events = await store.listEvents();
    await store.close();
    expect(events.map(({ name }) => name)).toEqual([
      "pipeline.started",
      "step.planned",
      "step.running",
      "pipeline.log",
      "step.complete",
      "pipeline.finalize.started",
      "pipeline.finalize.completed",
      "pipeline.completed",
    ]);
    expect(events.find(({ name }) => name === "pipeline.log")).toMatchObject({
      payload: { level: "log", message: "worked:hello" },
      stepId: "work",
    });
    expect(events.find(({ name }) => name === "step.planned")?.payload).toMatchObject({
      description: "Exercise workbench execution.",
    });
  });

  it("writes JSON traces from tubeless run without opening a store", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const tracePath = path.join(directory, "traces", "run.ndjson");

    const exitCode = await runWorkbenchCli(
      ["run", "--trace", tracePath, "pipeline.mjs", "--", "--message", "hello", "--target", "work"],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.output.join("")).toContain("completed:hello");
    expect(io.output.join("")).not.toContain('"name":"pipeline.started"');
    const events = parseNdjson(await readFile(tracePath, "utf8"));
    expect(events.map(({ name }) => name)).toEqual([
      "pipeline.started",
      "step.planned",
      "step.running",
      "pipeline.log",
      "step.complete",
      "pipeline.finalize.started",
      "pipeline.finalize.completed",
      "pipeline.completed",
    ]);
  });

  it("writes JSON traces to stdout when --trace is -", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);

    const exitCode = await runWorkbenchCli(
      ["run", "--trace", "-", "pipeline.mjs", "--", "--message", "hello", "--target", "work"],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors.join("")).toContain("completed:hello");
    const stdout = io.output.join("");
    expect(stdout).not.toContain("completed:hello");
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.every((line) => line.startsWith("{"))).toBe(true);
    const events = parseNdjson(stdout);
    expect(events).toHaveLength(lines.length);
    expect(events.map(({ name }) => name)).toContain("pipeline.started");
    expect(events.map(({ name }) => name)).toContain("pipeline.completed");
  });

  it("reports a late write failure from --trace without crashing", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const tracePath = path.join(directory, "traces");
    await mkdir(tracePath, { recursive: true });

    const exitCode = await runWorkbenchCli(
      ["run", "--trace", tracePath, "pipeline.mjs", "--", "--message", "hello", "--target", "work"],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.execution);
    expect(io.errors.join("")).toMatch(/EISDIR|directory|Error/i);
    expect(io.errors.join("")).not.toContain("completed:hello");
    expect(io.output.join("")).not.toContain("completed:hello");
  });

  it("fails the run when --trace - cannot write stdout", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    io.stdout.write = () => {
      throw new Error("broken pipe");
    };

    const exitCode = await runWorkbenchCli(
      ["run", "--trace", "-", "pipeline.mjs", "--", "--message", "hello", "--target", "work"],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.execution);
    expect(io.errors.join("")).toMatch(/broken pipe|Error/i);
  });

  it.skipIf(!existsSync("/dev/full"))(
    "fails the run when --trace writes to a full device",
    async () => {
      const { directory } = await writeActualPipelineCommandModule();
      const io = captureIo(directory);
      const exitCode = await runWorkbenchCli(
        [
          "run",
          "--trace",
          "/dev/full",
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      );
      expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.execution);
      expect(io.errors.join("")).toMatch(/ENOSPC|Error/i);
    }
  );

  it("records JSON traces and SQLite events together", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const databasePath = path.join(directory, "history", "runs.sqlite");
    const tracePath = path.join(directory, "traces", "run.ndjson");

    const exitCode = await runWorkbenchCli(
      [
        "run",
        "--store",
        databasePath,
        "--trace",
        tracePath,
        "pipeline.mjs",
        "--",
        "--message",
        "hello",
        "--target",
        "work",
      ],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    const store = await openSqlitePipelineRunStore(databasePath);
    const stored = await store.listEvents();
    await store.close();
    const traced = parseNdjson(await readFile(tracePath, "utf8"));
    expect(stored.map(({ name }) => name)).toEqual(traced.map(({ name }) => name));
    expect(traced.map(({ name }) => name)).toContain("pipeline.completed");
  });

  it("keeps SQLite history when a composed --trace destination fails", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const databasePath = path.join(directory, "history", "runs.sqlite");
    let writes = 0;
    const writeStdout = io.stdout.write;
    io.stdout.write = (chunk) => {
      writes += 1;
      if (writes > 1) throw new Error("broken pipe");
      writeStdout(chunk);
    };

    const exitCode = await runWorkbenchCli(
      [
        "run",
        "--store",
        databasePath,
        "--trace",
        "-",
        "pipeline.mjs",
        "--",
        "--message",
        "hello",
        "--target",
        "work",
      ],
      io
    );

    const store = await openSqlitePipelineRunStore(databasePath);
    const stored = await store.listEvents();
    await store.close();
    expect(stored.map(({ name }) => name)).toContain("pipeline.completed");
    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.execution);
    expect(io.errors.join("")).toMatch(/broken pipe|Error/i);
  });

  it("rejects the same path for --store and --trace", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const sharedPath = path.join(directory, "shared.sqlite");

    const exitCode = await runWorkbenchCli(
      [
        "run",
        "--store",
        sharedPath,
        "--trace",
        sharedPath,
        "pipeline.mjs",
        "--",
        "--message",
        "hello",
        "--target",
        "work",
      ],
      io
    );

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(io.errors.join("")).toMatch(/same path/i);
  });

  it("rejects a symlink that aliases --store as --trace", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const storePath = path.join(directory, "history", "runs.sqlite");
    const tracePath = path.join(directory, "traces", "alias.ndjson");
    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          storePath,
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
    await mkdir(path.dirname(tracePath), { recursive: true });
    await symlink(storePath, tracePath);

    const aliasIo = captureIo(directory);
    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          storePath,
          "--trace",
          tracePath,
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        aliasIo
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(aliasIo.errors.join("")).toMatch(/same path/i);
  });

  it("rejects a dangling symlink that aliases --store as --trace", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const storePath = path.join(directory, "history", "runs.sqlite");
    const tracePath = path.join(directory, "traces", "dangling.ndjson");
    await mkdir(path.dirname(storePath), { recursive: true });
    await mkdir(path.dirname(tracePath), { recursive: true });
    await symlink(storePath, tracePath);

    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          storePath,
          "--trace",
          tracePath,
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(io.errors.join("")).toMatch(/same path/i);
  });

  it("rejects dests that share a missing directory under aliased parents", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const shared = path.join(directory, "shared");
    await mkdir(shared);
    await symlink(shared, path.join(directory, "left"));
    await symlink(shared, path.join(directory, "right"));

    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          path.join(directory, "left", "new", "runs.sqlite"),
          "--trace",
          path.join(directory, "right", "new", "runs.sqlite"),
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(io.errors.join("")).toMatch(/same path/i);
  });

  it("rejects --store and --trace dests that the filesystem treats as the same path", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const storePath = path.join(directory, "runs.sqlite");
    const tracePath = path.join(directory, "RUNS.sqlite");
    const caseInsensitive = await directoryIgnoresCase(directory);

    const exitCode = await runWorkbenchCli(
      [
        "run",
        "--store",
        storePath,
        "--trace",
        tracePath,
        "pipeline.mjs",
        "--",
        "--message",
        "hello",
        "--target",
        "work",
      ],
      io
    );

    if (caseInsensitive) {
      expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
      expect(io.errors.join("")).toMatch(/same path/i);
      return;
    }

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(existsSync(storePath)).toBe(true);
    expect(existsSync(tracePath)).toBe(true);
    expect(io.errors.join("")).not.toMatch(/same path/i);
  });

  it("rejects a trace path that is a SQLite sidecar of --store", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const storePath = path.join(directory, "history", "runs.sqlite");

    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          storePath,
          "--trace",
          `${storePath}-wal`,
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(io.errors.join("")).toMatch(/same path/i);
  });

  it("rejects a trace path that is a SQLite sidecar of a --store symlink target", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const io = captureIo(directory);
    const storePath = path.join(directory, "history", "runs.sqlite");
    const alias = path.join(directory, "alias", "store.sqlite");
    await mkdir(path.dirname(storePath), { recursive: true });
    await mkdir(path.dirname(alias), { recursive: true });
    await writeFile(storePath, "");
    await symlink(storePath, alias);

    expect(
      await runWorkbenchCli(
        [
          "run",
          "--store",
          alias,
          "--trace",
          `${storePath}-wal`,
          "pipeline.mjs",
          "--",
          "--message",
          "hello",
          "--target",
          "work",
        ],
        io
      )
    ).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(io.errors.join("")).toMatch(/same path/i);
  });

  it("cancels a pending --trace open when the workbench signal aborts", async () => {
    const { directory } = await writeActualPipelineCommandModule();
    const fifo = path.join(directory, "trace.fifo");
    await execFileAsync("mkfifo", [fifo]);
    const controller = new AbortController();
    const io = { ...captureIo(directory), signal: controller.signal };
    const command = runWorkbenchCli(
      ["run", "--trace", fifo, "pipeline.mjs", "--", "--message", "hello", "--target", "work"],
      io
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(command).resolves.toBe(TUBELESS_WORKBENCH_EXIT_CODE.cancellation);
    expect(io.output.join("")).not.toContain("completed:hello");
  });

  it("cancels a backpressured --trace - write when the workbench signal aborts", async () => {
    const { PassThrough } = await import("node:stream");
    const { directory } = await writeActualPipelineCommandModule();
    const stdout = new PassThrough({ highWaterMark: 1 });
    const controller = new AbortController();
    const io = { ...captureIo(directory), stdout, signal: controller.signal };
    const command = runWorkbenchCli(
      ["run", "--trace", "-", "pipeline.mjs", "--", "--message", "hello", "--target", "work"],
      io
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(command).resolves.toBe(TUBELESS_WORKBENCH_EXIT_CODE.cancellation);
    expect(io.output.join("")).not.toContain("completed:hello");
  });

  it("rejects after an accepted write later fails", async () => {
    const { Writable } = await import("node:stream");
    let writeCallback: ((error?: Error | null) => void) | undefined;
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        writeCallback = callback;
      },
    });
    stream.on("error", () => undefined);
    const pending = writeCliChunk(stream, "x\n");
    expect(writeCallback).toEqual(expect.any(Function));
    stream.destroy(new Error("broken pipe"));
    await expect(pending).rejects.toThrow(/broken pipe|closed stream/);
  });

  it("does not hang when writing to a destroyed stream", async () => {
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough();
    stream.on("error", () => undefined);
    stream.destroy(new Error("broken pipe"));
    await expect(writeCliChunk(stream, "x\n")).rejects.toThrow(/broken pipe|closed stream/);
  });

  it("does not hang when a backpressured stream closes without error", async () => {
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough({ highWaterMark: 1 });
    const pending = writeCliChunk(stream, `${"x".repeat(64)}\n`);
    stream.destroy();
    await expect(pending).rejects.toThrow(/closed stream/);
  });

  it("aborts a backpressured write when the workbench signal fires", async () => {
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough({ highWaterMark: 1 });
    const controller = new AbortController();
    const pending = writeCliChunk(stream, `${"x".repeat(64)}\n`, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
  });
});
