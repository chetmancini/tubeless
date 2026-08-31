import { describe, expect, it } from "vitest";
import { createSteps, definePipeline } from "./pipeline.js";
import { createPipelineTestRuntime } from "./testing.js";

interface WorkOptions {
  count: number;
}

function makePipeline() {
  const step = createSteps<WorkOptions>();
  const work = step("work", {
    run: async (_inputs, context) => {
      context.log.log("starting", context.options.count);
      for (let completed = 1; completed <= context.options.count; completed += 1) {
        await context.sleep(25, context.signal);
        context.reportProgress({ completed, total: context.options.count });
      }
      return `completed:${context.options.count}`;
    },
  });
  return definePipeline({
    id: "testing",
    steps: [work],
    targets: [work],
    finalize: (outputs) => outputs.work ?? "missing",
  });
}

describe("createPipelineTestRuntime", () => {
  it("runs with deterministic time and captures logs, statuses, and latest progress", async () => {
    const test = createPipelineTestRuntime({ cwd: "/workspace", startTimeMs: 100 });

    const result = await test.run(makePipeline(), { count: 2 });

    expect(result.value).toBe("completed:2");
    expect(result.finishedAtMs - result.startedAtMs).toBe(50);
    expect(test.clock.now()).toBe(150);
    expect(test.context.cwd).toBe("/workspace");
    expect(test.logs).toEqual([{ args: [2], level: "log", message: "starting" }]);
    expect(test.statuses.map(({ status }) => status)).toEqual([
      "planned",
      "running",
      "running",
      "running",
      "completed",
    ]);
    expect(test.latestProgress.get("work")).toEqual({ completed: 2, total: 2 });
  });

  it("supports caller-controlled sleep and clock advancement", async () => {
    const sleeps: number[] = [];
    const test = createPipelineTestRuntime({
      sleep: (durationMs, _signal, clock) => {
        sleeps.push(durationMs);
        clock.advance(durationMs * 2);
      },
    });

    await test.runOrThrow(makePipeline(), { count: 2 });

    expect(sleeps).toEqual([25, 25]);
    expect(test.clock.timeMs).toBe(100);
  });

  it("retains visible progress across empty non-visible progress events", async () => {
    const step = createSteps();
    const work = step("work", {
      run: (_inputs, context) => {
        context.reportProgress({ completed: 1, message: "loaded", total: 2 });
        context.reportProgress({ completed: 0 });
        return true;
      },
    });
    const pipeline = definePipeline({
      id: "empty-progress",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });
    const test = createPipelineTestRuntime();

    await test.runOrThrow(pipeline, {});

    expect(test.latestProgress.get("work")).toEqual({
      completed: 1,
      message: "loaded",
      total: 2,
    });
  });

  it("classifies an owned abort as cancellation", async () => {
    const test = createPipelineTestRuntime();
    test.abort("stop test work");

    const result = await test.run(makePipeline(), { count: 1 });

    expect(test.abortController.signal.aborted).toBe(true);
    expect(result.status).not.toBe("completed");
    expect(result.steps[0]?.status).toBe("cancelled");
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_RUN_CANCELLED",
      kind: "cancellation",
    });
    expect(test.clock.now()).toBe(0);
  });

  it("plans through the typed helper without executing or recording statuses", () => {
    const test = createPipelineTestRuntime();

    const plan = test.plan(makePipeline(), { targets: ["work"] });

    expect(plan.ok).toBe(true);
    expect(plan.steps[0]).toMatchObject({ id: "work", selected: true });
    expect(test.statuses).toEqual([]);
  });

  it("rejects invalid manual clock advancement", () => {
    const test = createPipelineTestRuntime();

    expect(() => createPipelineTestRuntime({ startTimeMs: Number.NaN })).toThrow(RangeError);
    expect(() => test.clock.advance(-1)).toThrow(RangeError);
    expect(() => test.clock.advance(Number.NaN)).toThrow(RangeError);
  });
});
