import { describe, expect, it } from "vitest";
import { createSteps, definePipeline, PipelineExecutionError } from "./pipeline.js";
import { PIPELINE_FINALIZE_STEP_ID } from "./pipeline-step-metadata.js";
import { makePipeline } from "./pipeline.test-support.js";

describe("definePipeline failures and cancellation", () => {
  it("fail-fast (the default) records every not-run downstream step", async () => {
    const result = await makePipeline("test").run({ failStep: "build" });
    expect(result.status).not.toBe("completed");
    expect(result.finalized).toBe(false);
    expect(
      result.steps.map((step) => [
        step.id,
        step.status,
        step.status === "skipped" ? step.reason : undefined,
      ])
    ).toEqual([
      ["build", "failed", undefined],
      ["write", "skipped", "fail-fast"],
    ]);
    expect(result.steps[1]).toMatchObject({
      message: "Not run because fail-fast stopped after build failed.",
    });
    expect(result.steps[1]?.status === "skipped" ? result.steps[1].message : undefined).toBe(
      "Not run because fail-fast stopped after build failed."
    );
    expect(result.errors).toEqual([
      {
        code: "TUBELESS_STEP_FAILED",
        kind: "step",
        message: "build failed",
        phase: "execution",
        stack: expect.any(String),
        stepId: "build",
      },
    ]);
  });

  it("emits distinct failed and skipped terminal states", async () => {
    const events: string[] = [];
    const result = await makePipeline("test").run({ failStep: "build" }, undefined, {
      cwd: "/tmp",
      log: console,
      hooks: {
        onStepFail: ({ error, step }) => events.push(`error:${step.id}:${error.message}`),
        onStepSkip: ({ reason, step }) => events.push(`skip:${step.id}:${reason}`),
      },
    });
    expect(result.status).not.toBe("completed");
    expect(events).toEqual(["error:build:build failed", "skip:write:fail-fast"]);
  });

  it("retains the dependency id for a planned unmet-dependency skip after fail-fast", async () => {
    const step = createSteps();
    const failing = step("failing", {
      run: () => {
        throw new Error("failed");
      },
    });
    const filtered = step("filtered", { run: () => "filtered" });
    const requiresFiltered = step("requires-filtered", {
      dependsOn: [filtered],
      run: () => "unreachable",
    });
    const pipeline = definePipeline({
      id: "fail-fast-structural-skip",
      steps: [failing, filtered, requiresFiltered],
      finalize: () => undefined,
    });
    const skipEvents: unknown[] = [];

    await pipeline.run(
      {},
      { stepIds: ["failing", "requires-filtered"] },
      {
        cwd: "/tmp",
        log: console,
        hooks: {
          onStepSkip: (event) => {
            skipEvents.push({
              dependencyId: event.dependencyId,
              reason: event.reason,
              stepId: event.step.id,
            });
          },
        },
      }
    );

    expect(skipEvents).toEqual([
      {
        dependencyId: undefined,
        reason: "filtered",
        stepId: "filtered",
      },
      {
        dependencyId: "filtered",
        reason: "unmet-dependency",
        stepId: "requires-filtered",
      },
    ]);
  });

  it("preserves a planned dry-run skip after fail-fast even when skipAfterFailureOf matches the failed step", async () => {
    const step = createSteps();
    const failing = step("failing", {
      run: () => {
        throw new Error("failed");
      },
    });
    const later = step("later", {
      dryRun: "skip",
      skipAfterFailureOf: [failing],
      run: () => "unreachable",
    });
    const pipeline = definePipeline({
      id: "fail-fast-dry-run-skip",
      steps: [failing, later],
      finalize: () => undefined,
    });
    const skipEvents: unknown[] = [];

    const result = await pipeline.run(
      {},
      { dryRun: true },
      {
        cwd: "/tmp",
        log: console,
        hooks: {
          onStepSkip: (event) => {
            skipEvents.push({
              dependencyId: event.dependencyId,
              reason: event.reason,
              stepId: event.step.id,
            });
          },
        },
      }
    );

    expect(
      pipeline.plan({ dryRun: true }).steps.map((planned) => [planned.id, planned.skipReason])
    ).toEqual([
      ["failing", undefined],
      ["later", "dry-run"],
    ]);
    expect(
      result.steps.map((report) => [
        report.id,
        report.status,
        report.status === "skipped" ? report.reason : undefined,
      ])
    ).toEqual([
      ["failing", "failed", undefined],
      ["later", "skipped", "dry-run"],
    ]);
    expect(skipEvents).toEqual([
      {
        dependencyId: undefined,
        reason: "dry-run",
        stepId: "later",
      },
    ]);
  });

  it("preserves a thrown error code in the step report and run result", async () => {
    const step = createSteps();
    const failing = step("failing", {
      run: () => {
        throw Object.assign(new Error("request rejected"), { code: "REQUEST_REJECTED" });
      },
    });
    const pipeline = definePipeline({
      id: "coded-error",
      steps: [failing],
      finalize: () => undefined,
    });

    const result = await pipeline.run({});

    expect(result.errors).toMatchObject([
      {
        code: "TUBELESS_STEP_FAILED",
        kind: "step",
        message: "request rejected",
        phase: "execution",
        sourceCode: "REQUEST_REJECTED",
        stepId: "failing",
      },
    ]);
    const failed = result.steps[0];
    expect(failed?.status).toBe("failed");
    if (failed?.status === "failed") {
      expect(failed.error).toMatchObject({
        code: "TUBELESS_STEP_FAILED",
        sourceCode: "REQUEST_REJECTED",
      });
    }
    expect(result.steps[0]).toMatchObject({ status: "failed", error: result.errors[0] });
  });

  it("preserves JSON-safe cause chains and the original runOrThrow cause", async () => {
    const rootCause = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const thrownError = new Error("query failed", { cause: rootCause });
    const step = createSteps();
    const query = step("query", {
      run: () => {
        throw thrownError;
      },
    });
    const pipeline = definePipeline({
      id: "causal",
      steps: [query],
      finalize: () => undefined,
    });

    const result = await pipeline.run({});

    expect(result.errors[0]).toMatchObject({
      cause: {
        message: "connection refused",
        name: "Error",
        sourceCode: "ECONNREFUSED",
      },
      code: "TUBELESS_STEP_FAILED",
      message: "query failed",
      phase: "execution",
      stepId: "query",
    });
    expect(() => JSON.stringify(result)).not.toThrow();

    let thrown: unknown;
    try {
      await pipeline.runOrThrow({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PipelineExecutionError);
    expect((thrown as PipelineExecutionError).cause).toBe(thrownError);
    expect((thrown as PipelineExecutionError).result.errors[0]?.cause).toMatchObject({
      message: "connection refused",
      sourceCode: "ECONNREFUSED",
    });
    expect((thrown as PipelineExecutionError).message).toContain("Pipeline causal failed");
    expect((thrown as PipelineExecutionError).message).toContain("execution");
    expect((thrown as PipelineExecutionError).message).toContain("TUBELESS_STEP_FAILED");
    expect((thrown as PipelineExecutionError).message).toContain("step query");
    expect((thrown as PipelineExecutionError).message).toContain(
      "ECONNREFUSED: connection refused"
    );
  });

  it("normalizes non-Error and circular causes without retaining their objects", async () => {
    const circular = new Error("circular wrapper") as Error & { cause?: unknown };
    circular.cause = circular;
    const primitiveCause = new Error("primitive wrapper", { cause: "socket closed" });
    const step = createSteps();
    const circularStep = step("circular", {
      run: () => {
        throw circular;
      },
    });
    const primitiveStep = step("primitive", {
      run: () => {
        throw primitiveCause;
      },
    });
    const pipeline = definePipeline({
      id: "safe-causes",
      steps: [circularStep, primitiveStep],
      finalize: () => undefined,
    });

    const result = await pipeline.run({}, { continueOnError: true });

    expect(result.errors.map(({ cause }) => cause)).toEqual([
      { message: "Circular cause" },
      { message: "socket closed" },
    ]);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("bounds deeply nested cause chains", async () => {
    let cause: Error = new Error("root cause");
    for (let index = 0; index < 10; index += 1) {
      cause = new Error(`cause ${index}`, { cause });
    }
    const thrownError = new Error("top-level failure", { cause });
    const step = createSteps();
    const fail = step("fail", {
      run: () => {
        throw thrownError;
      },
    });
    const pipeline = definePipeline({
      id: "bounded-causes",
      steps: [fail],
      finalize: () => undefined,
    });

    const result = await pipeline.run({});
    let deepestCause = result.errors[0]?.cause;
    while (deepestCause?.cause) deepestCause = deepestCause.cause;

    expect(deepestCause).toEqual({ message: "Cause chain truncated" });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("retains cancellation as the native cause of runOrThrow", async () => {
    const cancellation = new Error("operator stopped");
    cancellation.name = "AbortError";
    const step = createSteps();
    const work = step("work", {
      run: () => {
        throw cancellation;
      },
    });
    const pipeline = definePipeline({
      id: "causal-cancellation",
      steps: [work],
      finalize: () => undefined,
    });

    let thrown: unknown;
    try {
      await pipeline.runOrThrow({});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PipelineExecutionError);
    expect((thrown as PipelineExecutionError).cause).toBe(cancellation);
    expect((thrown as PipelineExecutionError).message).toContain(
      "Pipeline causal-cancellation cancelled"
    );
    expect((thrown as PipelineExecutionError).result.errors[0]).toMatchObject({
      code: "TUBELESS_RUN_CANCELLED",
      kind: "cancellation",
      stepId: "work",
    });
  });

  it("does not misclassify an unrelated step failure when its signal is also aborted", async () => {
    const controller = new AbortController();
    const step = createSteps();
    const failing = step("failing", {
      run: () => {
        controller.abort("stop");
        throw new Error("database write failed");
      },
    });
    const pipeline = definePipeline({
      id: "failure-during-abort",
      steps: [failing],
      finalize: () => undefined,
    });

    const result = await pipeline.run({}, undefined, {
      cwd: "/tmp",
      log: console,
      signal: controller.signal,
    });

    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      message: "database write failed",
    });
  });

  it("emits a skipped state with unmet-dependency metadata when a required step failed", async () => {
    const events: unknown[] = [];
    await makePipeline("test").run(
      { failStep: "build" },
      { continueOnError: true },
      {
        cwd: "/tmp",
        log: console,
        hooks: {
          onStepSkip: (event) => {
            events.push({
              dependencyId: event.dependencyId,
              reason: event.reason,
              stepId: event.step.id,
            });
          },
        },
      }
    );
    expect(events).toEqual([
      { dependencyId: "build", reason: "unmet-dependency", stepId: "write" },
    ]);
  });

  it("emits onFinalizeError with the sentinel step id when finalize throws", async () => {
    const events: unknown[] = [];
    await makePipeline("test").run({ failFinalize: true }, undefined, {
      cwd: "/tmp",
      log: console,
      hooks: {
        onFinalizeError: ({ error }) => events.push(error),
      },
    });
    expect(events).toEqual([
      {
        code: "TUBELESS_FINALIZATION_FAILED",
        kind: "finalization",
        message: "finalize failed",
        phase: "finalization",
        stack: expect.any(String),
        stepId: PIPELINE_FINALIZE_STEP_ID,
      },
    ]);
  });

  it("does not misclassify an unrelated finalizer failure when its signal is also aborted", async () => {
    const controller = new AbortController();
    const step = createSteps();
    const work = step("work", { run: () => true });
    const pipeline = definePipeline({
      id: "finalizer-failure-during-abort",
      steps: [work],
      finalize: () => {
        controller.abort("stop");
        throw new Error("commit failed");
      },
    });

    const result = await pipeline.run({}, undefined, {
      cwd: "/tmp",
      log: console,
      signal: controller.signal,
    });

    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_FINALIZATION_FAILED",
      kind: "finalization",
      message: "commit failed",
    });
  });

  it("cancels finalization when the runtime signal is aborted after steps complete", async () => {
    const controller = new AbortController();
    const step = createSteps();
    const work = step("work", {
      run: () => {
        controller.abort("stop");
        return true;
      },
    });
    const pipeline = definePipeline({
      id: "finalize-cancelled",
      steps: [work],
      finalize: () => "done",
    });

    const result = await pipeline.run({}, undefined, {
      cwd: "/tmp",
      log: console,
      signal: controller.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(result.finalized).toBe(false);
    expect(result.steps.map((report) => [report.id, report.status])).toEqual([
      ["work", "completed"],
    ]);
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_FINALIZATION_CANCELLED",
      kind: "cancellation",
      phase: "finalization",
      stepId: PIPELINE_FINALIZE_STEP_ID,
    });
  });
});
