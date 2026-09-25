import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createSteps,
  definePipeline,
  type IterationDecision,
  type PipelineStepContext,
  type PipelineRunControls,
} from "./pipeline.js";
import { createPipelineTestRuntime } from "../testing/testing.js";
import { defer } from "./child-pipeline.test-support.js";
import { standardSchema } from "./pipeline.test-support.js";

function fixture(
  options: {
    maxIterations?: number;
    initialState?: () => number;
    child?: (context: PipelineStepContext<{ value: number }>) => number | Promise<number>;
    transition?: (
      value: number,
      state: number
    ) =>
      | IterationDecision<number, number | undefined>
      | Promise<IterationDecision<number, number | undefined>>;
    dryRun?: "skip";
    childDryRun?: "skip" | (() => number);
    controls?: PipelineRunControls<"compute", "compute">;
  } = {}
) {
  const childSteps = createSteps<{ value: number }>();
  const execute = vi.fn((context: PipelineStepContext<{ value: number }>) =>
    options.child ? options.child(context) : context.options.value + 1
  );
  const compute = childSteps.step("compute", {
    dryRun: options.childDryRun,
    run: (_inputs, context) => execute(context),
  });
  const child = definePipeline({ id: "child", steps: [compute], finalize: compute });
  const { iteratePipeline } = createSteps();
  const initialState = vi.fn(options.initialState ?? (() => 0));
  const transition = vi.fn(
    options.transition ??
      ((value: number): IterationDecision<number, number> =>
        value === 3 ? { kind: "finish", result: value } : { kind: "next", state: value })
  );
  const repeat = iteratePipeline("repeat", {
    pipeline: child,
    maxIterations: options.maxIterations ?? 3,
    controls: options.controls,
    dryRun: options.dryRun,
    initialState,
    mapOptions: (value) => ({ value }),
    transition,
  });
  return {
    pipeline: definePipeline({ id: "parent", steps: [repeat], finalize: repeat }),
    repeat,
    child,
    execute,
    initialState,
    transition,
  };
}

describe("bounded child iteration", () => {
  it("finishes on the bound, publishes once, and initializes once per invocation", async () => {
    const { pipeline, execute, initialState, transition } = fixture();
    const runtime = createPipelineTestRuntime();
    expect(await runtime.runOrThrow(pipeline, {})).toBe(3);
    expect(execute.mock.calls.map(([context]) => context.options.value)).toEqual([0, 1, 2]);
    expect(new Set(execute.mock.calls.map(([context]) => context.runId)).size).toBe(3);
    expect(initialState).toHaveBeenCalledOnce();
    expect(transition).toHaveBeenCalledTimes(3);
    expect(
      runtime.statuses.filter((event) => event.status === "completed").map((event) => event.step.id)
    ).toEqual(["repeat"]);
    expect(
      runtime.latestProgress
        .get("repeat")
        ?.details?.filter((row) => row.depth === undefined)
        .map((row) => row.id)
    ).toEqual(["iteration-1", "iteration-2", "iteration-3"]);
  });

  it("returns a precise undefined result on the first iteration", async () => {
    const { step } = createSteps();
    const work = step("work", { run: () => 1 });
    const child = definePipeline({ id: "once", steps: [work], finalize: work });
    const { iteratePipeline } = createSteps();
    const repeated = iteratePipeline("once", {
      pipeline: child,
      maxIterations: 10,
      initialState: () => 0,
      mapOptions: () => ({}),
      transition: () => ({ kind: "finish", result: undefined }),
    });
    const pipeline = definePipeline({ id: "void", steps: [repeated], finalize: repeated });
    expectTypeOf(pipeline.runOrThrow).returns.resolves.toEqualTypeOf<undefined>();
    expect(await createPipelineTestRuntime().run(pipeline, {})).toMatchObject({
      status: "completed",
      finalized: true,
      value: undefined,
    });
  });

  it("publishes an awaited finish value with the matching output type", async () => {
    const { child } = fixture();
    const { iteratePipeline } = createSteps();
    const repeated = iteratePipeline("once", {
      pipeline: child,
      maxIterations: 1,
      initialState: () => 0,
      mapOptions: (value) => ({ value }),
      transition: (result) => ({ kind: "finish", result: Promise.resolve(result) }),
    });
    const pipeline = definePipeline({
      id: "promised-result",
      steps: [repeated],
      finalize: repeated,
    });
    expectTypeOf(pipeline.runOrThrow).returns.resolves.toEqualTypeOf<number>();
    expect(await createPipelineTestRuntime().runOrThrow(pipeline, {})).toBe(1);
  });

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid bound %s during authoring",
    (maxIterations) => {
      expect(() => fixture({ maxIterations })).toThrow("positive safe integer");
    }
  );

  it("stops at the bound without starting an extra child", async () => {
    const { pipeline, execute } = fixture({ maxIterations: 2 });
    const run = await createPipelineTestRuntime().run(pipeline, {});
    expect(run.status).toBe("failed");
    expect(run.finalized).toBe(false);
    expect(run.errors[0]).toMatchObject({
      sourceCode: "TUBELESS_ITERATION_LIMIT_REACHED",
      stepId: "repeat",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    await expect(createPipelineTestRuntime().runOrThrow(pipeline, {})).rejects.toThrow(
      "maxIterations=2"
    );
  });

  it.each([
    null,
    {},
    { kind: "next" },
    { kind: "finish" },
    { kind: "finish", result: 1, state: 0 },
    { kind: "next", state: 1, extra: true },
  ])("validates runtime transitions: %j", async (invalid) => {
    const { pipeline } = fixture({
      // @ts-expect-error Deliberately supply invalid JavaScript boundary data.
      transition: () => invalid,
    });
    expect((await createPipelineTestRuntime().run(pipeline, {})).errors[0]).toMatchObject({
      sourceCode: "TUBELESS_ITERATION_INVALID_DECISION",
    });
  });

  it("waits for async transitions and keeps concurrent invocations isolated", async () => {
    const { pipeline, initialState } = fixture({
      transition: async (value) => {
        await Promise.resolve();
        return value === 3 ? { kind: "finish", result: value } : { kind: "next", state: value };
      },
    });
    const a = createPipelineTestRuntime();
    const b = createPipelineTestRuntime();
    expect(await Promise.all([a.runOrThrow(pipeline, {}), b.runOrThrow(pipeline, {})])).toEqual([
      3, 3,
    ]);
    expect(initialState).toHaveBeenCalledTimes(2);
  });

  it("does not initialize or execute during planning, graph rendering, filtering, or wrapper dry-run skip", async () => {
    const { pipeline, repeat, initialState, execute } = fixture({ dryRun: "skip" });
    expect(pipeline.plan().steps[0]?.nestedPipeline).toMatchObject({
      mode: "iterate",
      maxIterations: 3,
      stepIds: ["compute"],
    });
    expect(pipeline.toMermaid()).toContain("repeat");
    await createPipelineTestRuntime().run(pipeline, {}, { dryRun: true });
    const { step } = createSteps();
    const other = step("other", { run: () => 1 });
    const selected = definePipeline({ id: "selected", steps: [repeat, other], finalize: other });
    await createPipelineTestRuntime().run(selected, {}, { targets: ["other"] });
    expect(initialState).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("forwards dry-run to child previews even if child controls say false", async () => {
    const { pipeline, execute, transition } = fixture({
      controls: { dryRun: false },
      childDryRun: () => 3,
    });
    expect(await createPipelineTestRuntime().runOrThrow(pipeline, {}, { dryRun: true })).toBe(3);
    expect(execute).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledOnce();
  });

  it("does not turn skipped required child output into a successful iteration", async () => {
    const { pipeline, transition } = fixture({ childDryRun: "skip" });
    expect((await createPipelineTestRuntime().run(pipeline, {}, { dryRun: true })).status).toBe(
      "failed"
    );
    expect(transition).not.toHaveBeenCalled();
  });

  it("stops on child failure without transitioning", async () => {
    const { pipeline, execute, transition } = fixture({
      child: () => {
        throw new Error("child failed");
      },
    });
    expect((await createPipelineTestRuntime().run(pipeline, {})).errors[0]).toMatchObject({
      code: "TUBELESS_CHILD_FAILED",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(transition).not.toHaveBeenCalled();
  });

  it("drains active child siblings after failure before returning", async () => {
    const started = defer();
    const failed = defer();
    const released = defer();
    const { step, iteratePipeline } = createSteps();
    const slow = step("slow", {
      run: async (_inputs, context) => {
        started.resolve();
        await released.promise;
        expect(context.signal?.aborted).not.toBe(true);
        return 1;
      },
    });
    const bad = step("bad", {
      run: async () => {
        await started.promise;
        failed.resolve();
        throw new Error("failed sibling");
      },
    });
    const child = definePipeline({ id: "siblings", steps: [bad, slow] });
    const transition = vi.fn(() => ({ kind: "finish" as const, result: 1 }));
    const repeat = iteratePipeline("repeat", {
      pipeline: child,
      maxIterations: 3,
      controls: { maxConcurrency: 2 },
      initialState: () => 0,
      mapOptions: () => ({}),
      transition,
    });
    const parent = definePipeline({ id: "parent", steps: [repeat] });
    let settled = false;
    const running = createPipelineTestRuntime()
      .run(parent, {})
      .then((run) => {
        settled = true;
        return run;
      });
    await failed.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    released.resolve();
    expect((await running).status).toBe("failed");
    expect(transition).not.toHaveBeenCalled();
  });

  it("rejects an invalid child plan before running or transitioning", async () => {
    const { pipeline, execute, transition } = fixture({ controls: { maxConcurrency: 0 } });
    expect((await createPipelineTestRuntime().run(pipeline, {})).status).toBe("failed");
    expect(execute).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("validates each child invocation once and preserves transformed dependency and result values", async () => {
    const parentInput = vi.fn(() => ({ value: { start: 1 } }));
    const childInput = vi.fn((value: unknown) => {
      if (value === null || typeof value !== "object" || !("value" in value))
        return { issues: [{ message: "Expected value" }] };
      return { value: { value: Number(value.value) } };
    });
    const childOutput = vi.fn((value: unknown) => ({ value: Number(value) }));
    const childResult = vi.fn((value: unknown) => ({ value: { count: Number(value) } }));
    const parentResult = vi.fn((value: unknown) => ({ value: String(value) }));
    const children = createSteps(standardSchema<{ value: string }, { value: number }>(childInput));
    const compute = children.step("compute", {
      outputSchema: standardSchema<string, number>(childOutput),
      run: (_inputs, context) => String(context.options.value + 1),
    });
    const child = definePipeline({
      id: "transformed",
      steps: [compute],
      finalize: compute,
      resultSchema: standardSchema<number, { count: number }>(childResult),
    });
    const { step, iteratePipeline } = createSteps(
      standardSchema<{ start: string }, { start: number }>(parentInput)
    );
    const seed = step("seed", {
      outputSchema: standardSchema<string, number>((value) => ({ value: Number(value) })),
      run: () => "4",
    });
    const repeat = iteratePipeline("repeat", {
      pipeline: child,
      dependsOn: [seed],
      maxIterations: 2,
      initialState: (inputs, context) => inputs.seed + context.options.start,
      mapOptions: (state, inputs) => {
        expect(inputs.seed).toBe(4);
        return { value: String(state) };
      },
      transition: (result): IterationDecision<number, number> =>
        result.count === 7
          ? { kind: "finish", result: result.count }
          : { kind: "next", state: result.count },
    });
    const pipeline = definePipeline({
      id: "transformed-parent",
      steps: [seed, repeat],
      finalize: repeat,
      resultSchema: standardSchema<number, string>(parentResult),
    });
    expectTypeOf(pipeline.runOrThrow).returns.resolves.toEqualTypeOf<string>();
    expect(await createPipelineTestRuntime().runOrThrow(pipeline, { start: "1" })).toBe("7");
    expect(parentInput).toHaveBeenCalledExactlyOnceWith({ start: "1" });
    expect(childInput.mock.calls).toEqual([[{ value: "5" }], [{ value: "6" }]]);
    expect(childOutput.mock.calls).toEqual([["6"], ["7"]]);
    expect(childResult.mock.calls).toEqual([[6], [7]]);
    expect(parentResult).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("stops on transition failure", async () => {
    const { pipeline, execute } = fixture({
      transition: () => {
        throw new Error("transition failed");
      },
    });
    expect((await createPipelineTestRuntime().run(pipeline, {})).errors[0]?.message).toContain(
      "transition failed"
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it("honors cancellation before initialization and between iterations", async () => {
    const runtime = createPipelineTestRuntime();
    const first = fixture();
    runtime.abort();
    expect((await runtime.run(first.pipeline, {})).status).toBe("cancelled");
    expect(first.initialState).not.toHaveBeenCalled();
    const next = createPipelineTestRuntime();
    const second = fixture({
      transition: (value) => {
        next.abort();
        return { kind: "next", state: value };
      },
    });
    expect((await next.run(second.pipeline, {})).status).toBe("cancelled");
    expect(second.execute).toHaveBeenCalledOnce();
  });

  it("drains active child work after cancellation and never transitions afterward", async () => {
    const started = defer();
    const released = defer();
    const runtime = createPipelineTestRuntime();
    const { pipeline, transition } = fixture({
      child: async (context) => {
        expect(context.signal).toBe(runtime.context.signal);
        started.resolve();
        await released.promise;
        return 3;
      },
    });
    let settled = false;
    const running = runtime.run(pipeline, {}).then((run) => {
      settled = true;
      return run;
    });
    await started.promise;
    runtime.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    released.resolve();
    expect((await running).status).toBe("cancelled");
    expect(transition).not.toHaveBeenCalled();
  });

  it("propagates runtime services and keeps parent hooks separate", async () => {
    const runtime = createPipelineTestRuntime({ cwd: "/tmp/iteration" });
    const { pipeline } = fixture({
      child: async (context) => {
        expect(context.cwd).toBe("/tmp/iteration");
        expect(context.now).toBe(runtime.context.now);
        expect(context.sleep).toBe(runtime.context.sleep);
        context.reportProgress({
          completed: 1,
          total: 2,
          details: [{ id: "inner", status: "running" }],
        });
        await context.sleep(1);
        return 3;
      },
    });
    await runtime.runOrThrow(pipeline, {});
    expect(runtime.clock.timeMs).toBe(1);
    expect(runtime.latestProgress.get("repeat")?.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "iteration-1/inner", depth: 2 })])
    );
    expect(runtime.statuses.every((event) => event.step.id === "repeat")).toBe(true);
  });

  it("captures configuration and child controls before later author mutation", async () => {
    const controls: PipelineRunControls<"compute", "compute"> = { targets: ["compute"] };
    const { pipeline } = fixture({ controls });
    controls.targets = [];
    const plannedControls = pipeline.plan().steps[0]?.nestedPipeline?.controls;
    expect(Object.isFrozen(plannedControls)).toBe(true);
    expect(Object.isFrozen(plannedControls?.targets)).toBe(true);
    expect(() => {
      plannedControls!.targets = [];
    }).toThrow();
    expect(await createPipelineTestRuntime().runOrThrow(pipeline, {})).toBe(3);
  });

  it("bounds retained iteration groups without losing the final count", async () => {
    const { pipeline } = fixture({
      maxIterations: 40,
      transition: (value) =>
        value === 40 ? { kind: "finish", result: value } : { kind: "next", state: value },
    });
    const runtime = createPipelineTestRuntime();
    expect(await runtime.runOrThrow(pipeline, {})).toBe(40);
    const progress = runtime.latestProgress.get("repeat")!;
    expect(progress.completed).toBe(40);
    expect(progress.details?.filter((row) => row.depth === undefined)).toHaveLength(33);
    expect(progress.details?.[0]?.id).toBe("8 earlier iterations");
  });
});
