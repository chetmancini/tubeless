import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlitePipelineRunStore } from "./run-store-sqlite.js";
import type { PipelineTraceEvent } from "./tracing.js";
import { runHistory } from "./workbench-history.js";
import { TUBELESS_WORKBENCH_EXIT_CODE, type WorkbenchCliIo } from "./workbench-shared.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

function captureIo(cwd: string): WorkbenchCliIo & { errors: string[]; output: string[] } {
  const errors: string[] = [];
  const output: string[] = [];
  return {
    cwd,
    errors,
    output,
    stderr: {
      write: (chunk) => {
        errors.push(chunk);
      },
    },
    stdout: {
      write: (chunk) => {
        output.push(chunk);
      },
    },
  };
}

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "tubeless-history-"));
  directories.push(directory);
  return directory;
}

function event(
  name: PipelineTraceEvent["name"],
  overrides: Partial<PipelineTraceEvent> = {}
): PipelineTraceEvent {
  return {
    attributes: {},
    name,
    pipelineId: "import",
    runId: "run-failed",
    timestampMs: 1_700_000_000_000,
    version: 1,
    ...overrides,
  };
}

async function seedStore(filename: string, events: readonly PipelineTraceEvent[]): Promise<void> {
  const store = await openSqlitePipelineRunStore(filename);
  for (const next of events) {
    await store.export(next);
  }
  await store.flush?.();
  await store.close();
}

const failedRunEvents: PipelineTraceEvent[] = [
  event("pipeline.started", {
    attributes: { dry_run: false },
    timestampMs: 1_700_000_000_000,
  }),
  event("step.planned", {
    attributes: {
      dependencies: "[]",
      description: "Load source rows.",
      dry_run: "run",
      name: "Load rows",
    },
    stepId: "load",
    timestampMs: 1_700_000_000_001,
  }),
  event("step.running", {
    attemptId: "attempt-1",
    stepId: "load",
    timestampMs: 1_700_000_000_002,
  }),
  event("pipeline.log", {
    attemptId: "attempt-1",
    attributes: { level: "warn", message: "source slowed" },
    stepId: "load",
    timestampMs: 1_700_000_000_003,
  }),
  event("step.failed", {
    attemptId: "attempt-1",
    durationMs: 4,
    error: {
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      message: "source unavailable",
      phase: "execution",
    },
    stepId: "load",
    timestampMs: 1_700_000_000_004,
  }),
  event("pipeline.completed", {
    attributes: { status: "failed" },
    durationMs: 7,
    error: {
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      message: "source unavailable",
      phase: "execution",
    },
    timestampMs: 1_700_000_000_007,
  }),
];

const secondRunEvents: PipelineTraceEvent[] = [
  event("pipeline.started", {
    attributes: { dry_run: false },
    pipelineId: "publish",
    runId: "run-ok",
    timestampMs: 1_700_000_000_100,
  }),
  event("pipeline.completed", {
    attributes: { status: "completed" },
    durationMs: 3,
    pipelineId: "publish",
    runId: "run-ok",
    timestampMs: 1_700_000_000_103,
  }),
];

describe("runHistory", () => {
  it("lists one line per recorded run", async () => {
    const directory = await tempDir();
    const storePath = path.join(directory, "runs.sqlite");
    await seedStore(storePath, [...failedRunEvents, ...secondRunEvents]);
    const io = captureIo(directory);

    const exitCode = await runHistory(["--store", storePath], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    expect(io.errors).toEqual([]);
    const lines = io.output
      .join("")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(
      expect.arrayContaining([
        "run-failed  import  failed  started 2023-11-14T22:13:20.000Z  7ms",
        "run-ok  publish  completed  started 2023-11-14T22:13:20.100Z  3ms",
      ])
    );
  });

  it("shows steps, logs, and error sections for a run id", async () => {
    const directory = await tempDir();
    const storePath = path.join(directory, "runs.sqlite");
    await seedStore(storePath, failedRunEvents);
    const io = captureIo(directory);

    const exitCode = await runHistory(["--store", storePath, "run-failed"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.success);
    const rendered = io.output.join("");
    expect(rendered).toContain("Run run-failed");
    expect(rendered).toContain("Pipeline import");
    expect(rendered).toContain("Status failed");
    expect(rendered).toContain("Steps:");
    expect(rendered).toContain("  load  failed  4ms");
    expect(rendered).toContain("Logs:");
    expect(rendered).toContain("  [warn] source slowed");
    expect(rendered).toContain("Error:");
    expect(rendered).toContain("  TUBELESS_STEP_FAILED  source unavailable");
  });

  it("emits parseable JSON without ANSI", async () => {
    const directory = await tempDir();
    const storePath = path.join(directory, "runs.sqlite");
    await seedStore(storePath, [...failedRunEvents, ...secondRunEvents]);
    const listIo = captureIo(directory);
    const showIo = captureIo(directory);

    expect(await runHistory(["--store", storePath, "--json"], listIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );
    expect(await runHistory(["--store", storePath, "--json", "run-failed"], showIo)).toBe(
      TUBELESS_WORKBENCH_EXIT_CODE.success
    );

    const listText = listIo.output.join("");
    const showText = showIo.output.join("");
    expect(listText).not.toMatch(/\u001B\[/);
    expect(showText).not.toMatch(/\u001B\[/);
    expect(JSON.parse(listText)).toEqual({
      runs: [
        {
          durationMs: 3,
          pipelineId: "publish",
          runId: "run-ok",
          startedAtMs: 1_700_000_000_100,
          status: "completed",
        },
        {
          durationMs: 7,
          pipelineId: "import",
          runId: "run-failed",
          startedAtMs: 1_700_000_000_000,
          status: "failed",
        },
      ],
    });
    expect(JSON.parse(showText)).toMatchObject({
      error: {
        code: "TUBELESS_STEP_FAILED",
        message: "source unavailable",
      },
      logs: [expect.objectContaining({ level: "warn", message: "source slowed" })],
      pipelineId: "import",
      runId: "run-failed",
      status: "failed",
      steps: [expect.objectContaining({ id: "load", status: "failed" })],
    });
  });

  it("reports a missing store path as a load error", async () => {
    const directory = await tempDir();
    const storePath = path.join(directory, "missing.sqlite");
    const io = captureIo(directory);

    const exitCode = await runHistory(["--store", storePath], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.load);
    expect(io.errors.join("")).toBe(`Error: Run store not found at ${storePath}\n`);
  });

  it("reports an unknown run id as a usage error", async () => {
    const directory = await tempDir();
    const storePath = path.join(directory, "runs.sqlite");
    await seedStore(storePath, failedRunEvents);
    const io = captureIo(directory);

    const exitCode = await runHistory(["--store", storePath, "missing-run"], io);

    expect(exitCode).toBe(TUBELESS_WORKBENCH_EXIT_CODE.usage);
    expect(io.errors.join("")).toContain('Error: Unknown run "missing-run".');
    expect(io.errors.join("")).toContain("Usage: tubeless history [options] [run-id]");
  });
});
