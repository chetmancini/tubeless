import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../../examples/step-functions/handler.js";
import { StepFunctionsPipeline } from "../../examples/step-functions/pipeline.js";

const job = { lines: [" Alpha ", "", "Beta", "ALPHA"] };
const host = {
  executionArn: "arn:aws:states:us-east-1:123456789012:execution:example:run-1",
  stateName: "RunPipeline",
  retryCount: 0,
};
const context = { awsRequestId: "lambda-request-1", getRemainingTimeInMillis: () => 30_000 };

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Step Functions Lambda recipe", () => {
  it("returns pipeline output with correlated trace and progress logs", async () => {
    const result = await handler(
      { job: { ...job, parentRunId: "parent:execution-1" }, host },
      context
    );
    expect(result).toMatchObject({ rows: ["alpha", "beta"], count: 2, preview: false });
    expect(result.runId).toMatch(/^step-functions-normalize:/);
    expect(console.info).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tubeless-progress",
        ...host,
        awsRequestId: context.awsRequestId,
        stepId: "normalize",
        completed: 4,
        total: 4,
      })
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tubeless-trace",
        event: expect.objectContaining({
          name: "pipeline.started",
          runId: result.runId,
          parentRunId: "parent:execution-1",
          correlationId: JSON.stringify(["step-functions", host.executionArn, host.stateName]),
        }),
      })
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tubeless-trace",
        event: expect.objectContaining({ name: "pipeline.completed" }),
      })
    );
  });

  it("keeps workflow correlation across retries but creates new Tubeless execution IDs", async () => {
    const first = await handler({ job, host }, context);
    const second = await handler(
      { job, host: { ...host, retryCount: 1 } },
      {
        ...context,
        awsRequestId: "lambda-request-2",
      }
    );
    expect(first.runId).not.toBe(second.runId);
    const starts = vi
      .mocked(console.info)
      .mock.calls.map(([value]) => value)
      .filter((value) => value.kind === "tubeless-start");
    expect(starts[0].correlationId).toBe(starts[1].correlationId);
    expect(starts[1]).toMatchObject({ retryCount: 1, awsRequestId: "lambda-request-2" });
    const trace = vi
      .mocked(console.info)
      .mock.calls.map(([value]) => value)
      .find((value) => value.kind === "tubeless-trace");
    expect(trace.event).not.toHaveProperty("parentRunId");
  });

  it("forwards dry-run controls and clears the deadline on success", async () => {
    vi.useFakeTimers();
    const running = handler({ job: { ...job, dryRun: true }, host }, context);
    await vi.runAllTimersAsync();
    expect(await running).toMatchObject({ rows: ["alpha", "beta"], preview: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    null,
    { job },
    { job: { lines: [42] }, host },
    { job: { ...job, dryRun: "true" }, host },
    { job: { ...job, parentRunId: "" }, host },
    { job, host: { ...host, executionArn: "" } },
    { job, host: { ...host, retryCount: -1 } },
    { job, host: { ...host, retryCount: 0.5 } },
  ])("rejects invalid input before execution: %j", async (event) => {
    const run = vi.spyOn(StepFunctionsPipeline, "runOrThrow");
    await expect(handler(event, context)).rejects.toMatchObject({ name: "InvalidPipelineInput" });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects invocations that have no time left to start", async () => {
    const run = vi.spyOn(StepFunctionsPipeline, "runOrThrow");
    await expect(
      handler({ job, host }, { ...context, getRemainingTimeInMillis: () => 1000 })
    ).rejects.toMatchObject({ name: "PipelineDeadlineExceeded" });
    expect(run).not.toHaveBeenCalled();
  });

  it("aborts a running pipeline before the hard Lambda timeout and clears timers", async () => {
    vi.useFakeTimers();
    const running = handler(
      { job: { lines: Array.from({ length: 100 }, () => "row") }, host },
      {
        ...context,
        getRemainingTimeInMillis: () => 1010,
      }
    );
    const assertion = expect(running).rejects.toMatchObject({ name: "PipelineDeadlineExceeded" });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(console.info).not.toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tubeless-log",
        message: "Normalized 1 distinct rows",
      })
    );
  });

  it("lets execution errors fail the Task and clears its deadline on failure", async () => {
    vi.useFakeTimers();
    const failure = new Error("upstream unavailable");
    failure.name = "PipelineExecutionError";
    vi.spyOn(StepFunctionsPipeline, "runOrThrow").mockRejectedValueOnce(failure);
    await expect(handler({ job, host }, context)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
    const definition = JSON.parse(
      readFileSync("examples/step-functions/state-machine.asl.json", "utf8")
    );
    const errors = definition.States.RunPipeline.Retry.flatMap(
      (retry: { ErrorEquals: string[] }) => retry.ErrorEquals
    );
    expect(errors).toContain(failure.name);
    expect(errors).not.toContain("InvalidPipelineInput");
    expect(errors).not.toContain("PipelineDeadlineExceeded");
    expect(errors).not.toContain("States.ALL");
  });
});

it("builds a standalone Lambda ESM artifact and invokes it under Node", () => {
  const directory = mkdtempSync(join(tmpdir(), "tubeless-lambda-"));
  try {
    const artifact = join(directory, "handler.mjs");
    // Keep the argv separate: Knip mistakes inline `bun build` for our package build script.
    const buildArguments = [
      "build",
      "examples/step-functions/handler.ts",
      "--target",
      "node",
      "--format",
      "esm",
      "--outfile",
      artifact,
    ];
    const build = spawnSync("bun", buildArguments, { encoding: "utf8", timeout: 20_000 });
    expect(build.status, build.stderr).toBe(0);
    const invoke = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
      const { handler } = await import(process.argv[1]);
      const result = await handler(JSON.parse(process.argv[2]), {
        awsRequestId: "bundled-invocation", getRemainingTimeInMillis: () => 30000,
      });
      console.log(JSON.stringify({ result }));
    `,
        pathToFileURL(artifact).href,
        JSON.stringify({ job, host }),
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
      }
    );
    expect(invoke.status, invoke.stderr).toBe(0);
    expect(JSON.parse(invoke.stdout.trim().split("\n").at(-1)!)).toMatchObject({
      result: { rows: ["alpha", "beta"], count: 2, preview: false },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
