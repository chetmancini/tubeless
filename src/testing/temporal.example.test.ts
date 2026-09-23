import { resolve } from "node:path";
import { ApplicationFailure, CancelledFailure } from "@temporalio/activity";
import { MockActivityEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, type LogEntry } from "@temporalio/worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPipeline, type TemporalJob } from "../../examples/temporal/activities.js";
import { TemporalPipeline } from "../../examples/temporal/pipeline.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function environment(attempt = 1) {
  const logs: LogEntry[] = [];
  const env = new MockActivityEnvironment(
    { attempt, heartbeatTimeoutMs: 15_000 },
    {
      logger: new DefaultLogger("INFO", (entry) => logs.push(entry)),
    }
  );
  return { env, logs };
}

const job: TemporalJob = { lines: [" Alpha ", "", "Beta", "ALPHA"] };

function execute(env: MockActivityEnvironment, input: TemporalJob) {
  return env.run<[TemporalJob], Awaited<ReturnType<typeof runPipeline>>, typeof runPipeline>(
    runPipeline,
    input
  );
}

describe("Temporal Activity recipe", () => {
  it("runs real pipeline steps, heartbeats progress, and emits correlated traces", async () => {
    const { env, logs } = environment();
    const heartbeats: unknown[] = [];
    env.on("heartbeat", (details) => heartbeats.push(details));
    const result = await execute(env, { ...job, parentRunId: "parent:execution-1" });
    expect(result).toMatchObject({ rows: ["alpha", "beta"], count: 2, preview: false });
    expect(result.runId).toMatch(/^temporal-normalize:/);
    expect(heartbeats).toContainEqual({ stepId: "normalize", completed: 4, total: 4 });
    const events = logs
      .filter((entry) => entry.message === "Tubeless event")
      .map((entry) => entry.meta?.event);
    expect(events).toContainEqual(
      expect.objectContaining({
        name: "pipeline.started",
        runId: result.runId,
        parentRunId: "parent:execution-1",
        correlationId: JSON.stringify([
          "temporal",
          "test",
          "test",
          "00000000-0000-0000-0000-000000000000",
          "test",
        ]),
      })
    );
    expect(events).toContainEqual(expect.objectContaining({ name: "pipeline.completed" }));
  });

  it("preserves correlation but creates fresh executions on Activity retry", async () => {
    const first = environment(1);
    const second = environment(2);
    const a = await execute(first.env, job);
    const b = await execute(second.env, job);
    expect(a.runId).not.toBe(b.runId);
    const starting = (logs: LogEntry[]) =>
      logs.find((entry) => entry.message === "Starting Tubeless pipeline")?.meta;
    expect(starting(first.logs)?.correlationId).toBe(starting(second.logs)?.correlationId);
    expect(starting(second.logs)?.attempt).toBe(2);
  });

  it("forwards dry-run and leaves standalone Workflow executions without a Tubeless parent", async () => {
    const { env, logs } = environment();
    const result = await execute(env, { ...job, dryRun: true });
    expect(result).toMatchObject({ rows: ["alpha", "beta"], preview: true });
    const start = logs.find((entry) => entry.message === "Tubeless event")?.meta?.event;
    expect(start).not.toHaveProperty("parentRunId");
  });

  it.each([null, { lines: [42] }, { lines: [], dryRun: "true" }, { lines: [], parentRunId: 42 }])(
    "rejects invalid payload %j as non-retryable",
    async (value) => {
      const { env } = environment();
      // Simulate a caller bypassing TypeScript, as a cross-language client can.
      const result = execute(env, value as unknown as TemporalJob);
      await expect(result).rejects.toBeInstanceOf(ApplicationFailure);
      await expect(result).rejects.toMatchObject({
        nonRetryable: true,
        type: "InvalidTubelessJob",
      });
    }
  );

  it("restores Temporal cancellation after Tubeless wraps an aborted execution", async () => {
    const { env, logs } = environment();
    env.on("heartbeat", (details: { completed: number }) => {
      if (details.completed === 1) env.cancel();
    });
    await expect(execute(env, job)).rejects.toBeInstanceOf(CancelledFailure);
    expect(logs.some((entry) => entry.message === "Normalized 2 distinct rows")).toBe(false);
  });

  it("lets execution failures escape for Temporal's retry policy", async () => {
    const { env } = environment();
    const failure = new Error("Temporary service outage");
    vi.spyOn(TemporalPipeline, "runOrThrow").mockRejectedValueOnce(failure);
    await expect(execute(env, job)).rejects.toBe(failure);
  });

  it("heartbeats during a stalled step and clears the timer on failure", async () => {
    vi.useFakeTimers();
    const { env } = environment();
    const heartbeat = vi.fn();
    env.on("heartbeat", heartbeat);
    let reject!: (reason: Error) => void;
    vi.spyOn(TemporalPipeline, "runOrThrow").mockImplementationOnce(
      () =>
        new Promise((_resolve, rejectRun) => {
          reject = rejectRun;
        })
    );
    const running = execute(env, job);
    const assertion = expect(running).rejects.toThrow("Stopped test activity");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heartbeat).toHaveBeenCalledTimes(3);
    reject(new Error("Stopped test activity"));
    await assertion;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heartbeat).toHaveBeenCalledTimes(3);
  });
});

it("bundles the real Workflow without importing the Activity runtime into replay", async () => {
  const bundle = await bundleWorkflowCode({
    workflowsPath: resolve("examples/temporal/workflows.ts"),
    logger: new DefaultLogger("ERROR"),
  });
  expect(bundle.code).toContain("normalizeWorkflow");
  expect(bundle.code).not.toContain("temporal-normalize");
}, 20_000);
