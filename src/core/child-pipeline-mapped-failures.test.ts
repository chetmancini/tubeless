import { describe, expect, it, vi } from "vitest";
import { PipelineChildError } from "./child-execution.js";
import { createSteps, definePipeline, PipelineExecutionError } from "./pipeline.js";
import { defer, rejectWhenAborted } from "./child-pipeline.test-support.js";

describe("mapped child adapter: failures", () => {
  it("waits for running children and fails the parent when any selected child fails", async () => {
    interface ChildOptions {
      fail: boolean;
      itemId: string;
    }

    let successfulChildFinished = false;
    const { step: childStep } = createSteps<ChildOptions>();
    const process = childStep("process", {
      run: async (_inputs, context) => {
        if (context.options.fail) {
          throw new Error("bad source");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        successfulChildFinished = true;
        return context.options.itemId;
      },
    });
    const child = definePipeline({
      id: "waited-child",
      steps: [process],
      finalize: (outputs) => outputs.process,
    });
    const { forEachPipeline: parentForEachPipeline } = createSteps();
    const children = parentForEachPipeline("children", {
      pipeline: child,
      items: () => [
        { fail: true, id: "broken" },
        { fail: false, id: "valid" },
      ],
      key: (item) => item.id,
      concurrency: 2,
      mapOptions: (item) => ({ fail: item.fail, itemId: item.id }),
    });
    const finalize = vi.fn();
    const parent = definePipeline({
      id: "waited-parent",
      steps: [children],
      finalize,
    });

    const result = await parent.run({});

    expect(successfulChildFinished).toBe(true);
    expect(result.status).not.toBe("completed");
    expect(result.errors[0]?.message).toContain("broken: failed at process: bad source");
    expect(finalize).not.toHaveBeenCalled();
  });

  it("prefers a genuine child failure when mapped children also cancel", async () => {
    interface ChildOptions {
      outcome: "cancel" | "fail";
    }

    const { step: childStep } = createSteps<ChildOptions>();
    const process = childStep("process", {
      run: async (_inputs, context) => {
        if (context.options.outcome === "fail") {
          throw new Error("genuine failure");
        }
        const localController = new AbortController();
        localController.abort("local cancellation");
        await context.sleep(1, localController.signal);
      },
    });
    const child = definePipeline({
      id: "mixed-outcome-child",
      steps: [process],
      finalize: () => true,
    });
    const { step: parentStep, forEachPipeline: parentForEachPipeline } = createSteps();
    const children = parentForEachPipeline("children", {
      pipeline: child,
      items: () => [
        { id: "cancelled", outcome: "cancel" as const },
        { id: "failed", outcome: "fail" as const },
      ],
      key: (item) => item.id,
      concurrency: 2,
      mapOptions: (item) => ({ outcome: item.outcome }),
    });
    const after = parentStep("after", {
      run: () => "should not run",
    });
    const parent = definePipeline({
      id: "mixed-outcome-parent",
      steps: [children, after],
      finalize: () => true,
    });

    const result = await parent.run({});

    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_CHILD_FAILED",
      kind: "child",
      stepId: "children",
    });
    let deepestCause = result.errors[0]?.cause;
    while (deepestCause?.cause) deepestCause = deepestCause.cause;
    expect(deepestCause?.message).toBe("genuine failure");
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["children", "failed"],
      ["after", "skipped"],
    ]);
  });

  it("classifies a raw mapped-child abort as cancellation", async () => {
    const runChild = vi.fn(() => "done");
    const { step: childStep } = createSteps();
    const process = childStep("process", { run: runChild });
    const child = definePipeline({
      id: "raw-abort-child",
      steps: [process],
      finalize: (outputs) => outputs.process,
    });
    const { forEachPipeline: parentForEachPipeline } = createSteps();
    const children = parentForEachPipeline("children", {
      pipeline: child,
      items: () => [{ id: "first" }],
      key: (item) => item.id,
      mapOptions: () => {
        const error = new Error("stop before child run");
        error.name = "AbortError";
        throw error;
      },
    });
    const parent = definePipeline({
      id: "raw-abort-parent",
      steps: [children],
      finalize: () => true,
    });

    const result = await parent.run({});

    expect(runChild).not.toHaveBeenCalled();
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_RUN_CANCELLED",
      kind: "cancellation",
      stepId: "children",
    });
    expect(result.steps).toMatchObject([{ id: "children", status: "cancelled" }]);
  });

  it("reports abort-only mapped children as cancelled", async () => {
    const controller = new AbortController();
    const firstStarted = defer();
    const secondStarted = defer();
    const { step: childStep } = createSteps<{ itemId: string }>();
    const process = childStep("process", {
      run: async (_inputs, context) => {
        if (context.options.itemId === "first") firstStarted.resolve();
        else secondStarted.resolve();
        await rejectWhenAborted(context.signal);
      },
    });
    const child = definePipeline({
      id: "abort-only-child",
      steps: [process],
      finalize: () => true,
    });
    const { forEachPipeline: parentForEachPipeline } = createSteps();
    const children = parentForEachPipeline("children", {
      pipeline: child,
      items: () => [{ id: "first" }, { id: "second" }],
      key: (item) => item.id,
      concurrency: 2,
      mapOptions: (item) => ({ itemId: item.id }),
    });
    const parent = definePipeline({
      id: "abort-only-parent",
      steps: [children],
      finalize: () => true,
    });

    const run = parent.run({}, undefined, {
      cwd: "/tmp",
      log: console,
      signal: controller.signal,
    });
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    controller.abort("operator interrupt");
    const result = await run;

    expect(result.status).toBe("cancelled");
    expect(result.errors[0]).toMatchObject({
      kind: "cancellation",
      stepId: "children",
    });
    expect(result.errors[0]?.message).toMatch(/failed for 2 item\(s\)/);
    expect(result.errors[0]?.message).not.toContain("<aborted>");
  });

  it("reports a mapped child failure without abort as failed", async () => {
    const { step: childStep } = createSteps();
    const process = childStep("process", {
      run: () => {
        throw new Error("shard exploded");
      },
    });
    const child = definePipeline({
      id: "failure-only-child",
      steps: [process],
      finalize: () => true,
    });
    const { forEachPipeline: parentForEachPipeline } = createSteps();
    const children = parentForEachPipeline("children", {
      pipeline: child,
      items: () => [{ id: "broken" }],
      key: (item) => item.id,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({
      id: "failure-only-parent",
      steps: [children],
      finalize: () => true,
    });

    let thrown: unknown;
    try {
      await parent.runOrThrow({});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PipelineExecutionError);
    expect((thrown as PipelineExecutionError).result.status).toBe("failed");
    const mappedFailure = (thrown as PipelineExecutionError).cause;
    expect(mappedFailure).toBeInstanceOf(PipelineChildError);
    expect((mappedFailure as PipelineChildError).cancelled).toBe(false);
    expect((mappedFailure as Error).message).toContain("broken:");
    expect((mappedFailure as Error).message).toContain("shard exploded");
  });

  it("reports mixed mapped failure plus parent abort as failed", async () => {
    const controller = new AbortController();
    const failStarted = defer();
    const hangStarted = defer();
    const { step: childStep } = createSteps<{ outcome: "fail" | "hang" }>();
    const process = childStep("process", {
      run: async (_inputs, context) => {
        if (context.options.outcome === "fail") {
          failStarted.resolve();
          throw new Error("shard exploded");
        }
        hangStarted.resolve();
        await rejectWhenAborted(context.signal);
      },
    });
    const child = definePipeline({
      id: "mixed-abort-child",
      steps: [process],
      finalize: () => true,
    });
    const { forEachPipeline: parentForEachPipeline } = createSteps();
    const children = parentForEachPipeline("children", {
      pipeline: child,
      items: () => [
        { id: "broken", outcome: "fail" as const },
        { id: "hanging", outcome: "hang" as const },
      ],
      key: (item) => item.id,
      concurrency: 2,
      mapOptions: (item) => ({ outcome: item.outcome }),
    });
    const parent = definePipeline({
      id: "mixed-abort-parent",
      steps: [children],
      finalize: () => true,
    });

    const run = parent.runOrThrow({}, undefined, {
      cwd: "/tmp",
      log: console,
      signal: controller.signal,
    });
    await Promise.all([failStarted.promise, hangStarted.promise]);
    controller.abort("operator interrupt");

    let thrown: unknown;
    try {
      await run;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PipelineExecutionError);
    expect((thrown as PipelineExecutionError).result.status).toBe("failed");
    const mappedFailure = (thrown as PipelineExecutionError).cause;
    expect(mappedFailure).toBeInstanceOf(PipelineChildError);
    expect((mappedFailure as PipelineChildError).cancelled).toBe(false);
    expect((mappedFailure as Error).cause).toBeInstanceOf(Error);
    expect(((mappedFailure as Error).cause as Error).message).toMatch(/shard exploded/);
    expect((mappedFailure as Error).message).toMatch(/failed for 2 item\(s\)/);
    expect((mappedFailure as Error).message).not.toContain("<aborted>");
    expect((mappedFailure as Error).message).toContain("broken:");
    expect((mappedFailure as Error).message).toContain("shard exploded");
  });

  it("rejects an invalid mapped child plan with structured plan errors before child execution", async () => {
    const runChild = vi.fn();
    const { step: childStep } = createSteps();
    const known = childStep("known", { run: runChild });
    const child = definePipeline({
      id: "mapped-planned-child",
      steps: [known],
      finalize: () => true,
    });
    const runSpy = vi.spyOn(child, "run");
    const { forEachPipeline: parentForEachPipeline } = createSteps();
    const children = parentForEachPipeline("children", {
      pipeline: child,
      items: () => [{ id: "only" }],
      key: (item) => item.id,
      controls: { stepIds: ["missing" as never] },
      mapOptions: () => ({}),
    });
    const parent = definePipeline({
      id: "mapped-planned-parent",
      steps: [children],
      finalize: () => true,
    });

    const result = await parent.run({});

    expect(result.status).not.toBe("completed");
    expect(runChild).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
    expect(result.errors[0]?.message).toContain("could not start");
    expect(result.errors[0]?.message).toContain("unknown step ids: missing");

    let thrown: unknown;
    try {
      await parent.runOrThrow({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PipelineExecutionError);
    const mappedFailure = (thrown as PipelineExecutionError).cause;
    expect(mappedFailure).toBeInstanceOf(PipelineChildError);
    const planFailure = (mappedFailure as Error).cause;
    expect(planFailure).toBeInstanceOf(PipelineExecutionError);
    expect((planFailure as PipelineExecutionError).result.errors[0]).toMatchObject({
      code: "TUBELESS_PLANNING_STEP_UNKNOWN",
    });
  });
});
