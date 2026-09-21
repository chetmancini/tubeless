import { describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "./pipeline.js";
import type { AnyStep } from "./pipeline-steps.js";
import { makePipeline, thrownDefinitionErrors } from "./pipeline.test-support.js";

describe("definePipeline lifecycle and scheduling", () => {
  it("emits lifecycle hooks in execution order", async () => {
    const events: string[] = [];
    const focusedEvents: string[] = [];
    const result = await makePipeline("hooked").run({}, undefined, {
      cwd: "/tmp",
      hooks: {
        onFinalizeComplete: () => events.push("finalize:complete"),
        onFinalizeStart: () => events.push("finalize:start"),
        onPipelineComplete: () => events.push("pipeline:complete"),
        onPipelineStart: () => events.push("pipeline:start"),
        onStepPlan: ({ step }) => focusedEvents.push(`planned:${step.id}`),
        onStepStart: ({ step }) => focusedEvents.push(`started:${step.id}`),
        onStepStatus: ({ status, step }) => events.push(`step:${status}:${step.id}`),
        onStepComplete: ({ step }) => focusedEvents.push(`complete:${step.id}`),
      },
      log: console,
    });

    expect(result.status).toBe("completed");
    expect(events).toEqual([
      "pipeline:start",
      "step:planned:build",
      "step:planned:write",
      "step:running:build",
      "step:completed:build",
      "step:running:write",
      "step:completed:write",
      "finalize:start",
      "finalize:complete",
      "pipeline:complete",
    ]);
    expect(focusedEvents).toEqual([
      "planned:build",
      "planned:write",
      "started:build",
      "complete:build",
      "started:write",
      "complete:write",
    ]);
  });

  it("emits step-scoped progress snapshots from the running step", async () => {
    const { step } = createSteps();
    const work = step("work", {
      description: "Process records",
      run: (_inputs, context) => {
        context.reportProgress({ completed: 2, total: 10, message: "batch 1" });
        context.reportProgress({ completed: 7, total: 10, message: "batch 2" });
        return "done";
      },
    });
    const pipeline = definePipeline({
      id: "progressive",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });
    const events: unknown[] = [];

    await pipeline.run({}, undefined, {
      cwd: "/tmp",
      hooks: {
        onStepProgress: (event) => events.push(event),
      },
      log: console,
    });

    expect(events).toEqual([
      {
        attemptId: expect.any(String),
        pipelineId: "progressive",
        progress: { completed: 2, total: 10, message: "batch 1" },
        status: "running",
        step: expect.objectContaining({ description: "Process records", id: "work" }),
      },
      {
        attemptId: expect.any(String),
        pipelineId: "progressive",
        progress: { completed: 7, total: 10, message: "batch 2" },
        status: "running",
        step: expect.objectContaining({ description: "Process records", id: "work" }),
      },
    ]);
  });

  it("does not emit empty running progress while a step awaits", async () => {
    let releaseWork!: () => void;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    let started = false;
    const { step } = createSteps();
    const slow = step("slow", {
      run: async () => {
        await workGate;
        return "done";
      },
    });
    const pipeline = definePipeline({
      id: "no-empty-progress",
      steps: [slow],
      finalize: (outputs) => outputs.slow,
    });
    const progressEvents: Array<{ completed: number; total?: number; message?: string }> = [];

    const runPromise = pipeline.run({}, undefined, {
      cwd: "/tmp",
      hooks: {
        onStepStart: ({ step: startedStep }) => {
          if (startedStep.id === "slow") started = true;
        },
        onStepProgress: ({ progress, step: progressStep }) => {
          if (progressStep.id === "slow") {
            progressEvents.push(progress);
          }
        },
      },
      log: console,
    });
    await vi.waitFor(() => {
      expect(started).toBe(true);
    });
    // Hold the pending step across the old 250ms observation window so a late
    // empty-progress tick would still be recorded before we release the gate.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(progressEvents).toEqual([]);
    releaseWork();
    await runPromise;

    expect(progressEvents).toEqual([]);
  });

  it("ignores progress published after its step has finished", async () => {
    const { step } = createSteps();
    let reportLater: (() => void) | undefined;
    const work = step("work", {
      run: (_inputs, context) => {
        context.reportProgress({ completed: 1 });
        reportLater = () => context.reportProgress({ completed: 2 });
      },
    });
    const pipeline = definePipeline({ id: "late-progress", steps: [work], finalize: () => true });
    const completed: number[] = [];

    await pipeline.run({}, undefined, {
      cwd: "/tmp",
      hooks: {
        onStepProgress: ({ progress }) => completed.push(progress.completed),
      },
      log: console,
    });
    reportLater?.();

    expect(completed).toEqual([1]);
  });

  it("isolates failures between ordered hook sets", async () => {
    const completedSteps: string[] = [];
    const warn = vi.fn();
    const result = await makePipeline("isolated-hooks").run({}, undefined, {
      cwd: "/tmp",
      hooks: [
        {
          onStepStatus: (event) => {
            if (event.status === "completed") throw new Error("metrics unavailable");
          },
        },
        {
          onStepComplete: ({ step }) => completedSteps.push(step.id),
        },
      ],
      log: { error: vi.fn(), log: vi.fn(), warn },
    });

    expect(result.status).toBe("completed");
    expect(completedSteps).toEqual(["build", "write"]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("Pipeline hook failed: metrics unavailable");
  });

  it("uses injected runtime timing for reports and results", async () => {
    let currentTime = 0;
    const { step } = createSteps();
    const work = step("work", {
      run: () => {
        currentTime += 7;
        return "worked";
      },
    });
    const pipeline = definePipeline({
      id: "timed",
      steps: [work],
      finalize: (outputs) => {
        currentTime += 3;
        return outputs.work;
      },
    });

    const result = await pipeline.run({}, undefined, {
      cwd: "/tmp",
      log: console,
      now: () => currentTime,
    });

    expect(result.finishedAtMs - result.startedAtMs).toBe(10);
    expect(result.steps[0]!.finishedAtMs - result.steps[0]!.startedAtMs!).toBe(7);
  });

  it("uses an abort-aware default sleep, rejecting once the signal it was given aborts mid-wait", async () => {
    vi.useFakeTimers();
    const { step } = createSteps();
    const sleepController = new AbortController();
    const work = step("work", {
      run: async (_inputs, context) => {
        await context.sleep(1000, sleepController.signal);
        return "done";
      },
    });
    const pipeline = definePipeline({
      id: "sleepy",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });

    const resultPromise = pipeline.run({}, undefined, { cwd: "/tmp", log: console });
    const assertion = expect(resultPromise).resolves.toMatchObject({
      status: "cancelled",
      errors: [
        {
          code: "TUBELESS_RUN_CANCELLED",
          kind: "cancellation",
          message: "Pipeline sleep aborted: stop",
          stepId: "work",
        },
      ],
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      sleepController.abort("stop");
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops before running the next step when the runtime signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort("stop");

    const result = await makePipeline("aborted").run({}, undefined, {
      cwd: "/tmp",
      log: console,
      signal: controller.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(result.finalized).toBe(false);
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["build", "cancelled"],
      ["write", "cancelled"],
    ]);
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_RUN_CANCELLED",
      kind: "cancellation",
      message: "Pipeline run aborted: stop",
      phase: "execution",
      stepId: "build",
    });
    expect(result.steps[0]).toMatchObject({
      status: "cancelled",
      error: {
        code: "TUBELESS_RUN_CANCELLED",
        kind: "cancellation",
        phase: "execution",
      },
    });
  });

  it("executes steps in dependency order even when the steps array lists them out of order", async () => {
    const { step } = createSteps();
    const order: string[] = [];
    const build = step("build", {
      run: () => {
        order.push("build");
        return "built";
      },
    });
    const write = step("write", {
      dependsOn: [build],
      run: (inputs) => {
        order.push("write");
        return `${inputs.build}+written`;
      },
    });
    // Listed backwards on purpose: `write` before its dependency `build`.
    const pipeline = definePipeline({
      id: "reordered",
      steps: [write, build],
      finalize: (outputs) => outputs,
    });

    const result = await pipeline.run({});
    expect(result.status).toBe("completed");
    expect(order).toEqual(["build", "write"]);
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["build", "completed"],
      ["write", "completed"],
    ]);
  });

  it("rejects a missing dependency when the pipeline is defined", () => {
    const { step } = createSteps();
    const build = step("build", { run: () => "built" });
    const write = step("write", {
      dependsOn: [build],
      run: (inputs) => `${inputs.build}+written`,
    });
    // `build` is a real dependency but never listed in `steps` — a copy/paste bug.
    expect(
      thrownDefinitionErrors(() =>
        definePipeline({
          id: "missing-from-list",
          steps: [write],
          finalize: (outputs) => outputs,
        })
      )[0]
    ).toMatchObject({
      code: "TUBELESS_DEFINITION_DEPENDENCY_NOT_IN_STEPS",
      kind: "definition",
      phase: "definition",
    });
  });

  it("rejects a dependency cycle when the pipeline is defined", () => {
    // Impossible to construct through the normal `const`-reference API (that's the point —
    // TDZ rules this out at compile time). Simulate the defensive runtime check by hand-
    // building a cyclic graph the way a bug in a future refactor of `createSteps` might.
    const a: AnyStep<object> = {
      id: "a",
      run: () => "a",
    };
    const b: AnyStep<object> = {
      id: "b",
      dependsOn: [a],
      run: () => "b",
    };
    (a as { dependsOn?: readonly AnyStep[] }).dependsOn = [b];

    expect(
      thrownDefinitionErrors(() =>
        definePipeline({
          id: "cyclic",
          steps: [a, b],
          finalize: (outputs) => outputs,
        })
      )[0]
    ).toMatchObject({
      code: "TUBELESS_DEFINITION_DEPENDENCY_CYCLE",
      kind: "definition",
      phase: "definition",
    });
  });

  it("rejects a self-referential dependency when the pipeline is defined", () => {
    const { step } = createSteps();
    const loop = step("loop", { run: () => "loop" });
    (loop as { dependsOn?: readonly AnyStep[] }).dependsOn = [loop];

    expect(
      thrownDefinitionErrors(() =>
        definePipeline({
          id: "self-reference",
          steps: [loop],
          finalize: () => undefined,
        })
      )[0]
    ).toMatchObject({
      code: "TUBELESS_DEFINITION_DEPENDENCY_SELF_REFERENCE",
      kind: "definition",
      phase: "definition",
      stepId: "loop",
    });
  });
});
