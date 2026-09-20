import { describe, expect, it, vi } from "vitest";
import { defer, rejectWhenAborted } from "./child-pipeline.test-support.js";
import { createSteps, definePipeline, PipelineExecutionError } from "./pipeline.js";
import { standardSchema } from "./pipeline.test-support.js";
import { compilePipelineGraph } from "./pipeline-graph.js";
import { schedulePipelineSteps } from "./pipeline-scheduler.js";

describe("parallel DAG scheduling", () => {
  it.each([undefined, 1])(
    "preserves serial topological order with concurrency %s",
    async (maxConcurrency) => {
      const release = defer();
      const started: string[] = [];
      const { step } = createSteps();
      const first = step("first", { run: () => release.promise });
      const dependent = step("dependent", { dependsOn: [first], run: () => 2 });
      const independent = step("independent", { run: () => 3 });
      const pipeline = definePipeline({ id: "serial", steps: [dependent, first, independent] });
      const run = pipeline.run(
        {},
        { maxConcurrency },
        {
          hooks: { onStepStart: ({ step }) => started.push(step.id) },
        }
      );
      expect(started).toEqual(["first"]);
      release.resolve();
      const result = await run;
      expect(started).toEqual(["first", "dependent", "independent"]);
      expect(result.steps.map(({ id }) => id)).toEqual(started);
    }
  );

  it("fills slots in stable order and unlocks dependents before unrelated work settles", async () => {
    const slowRelease = defer();
    const fastRelease = defer();
    const childRelease = defer();
    const childStarted = defer();
    const laterStarted = defer();
    const started: string[] = [];
    const { step } = createSteps();
    const slow = step("slow", { run: () => slowRelease.promise });
    const fast = step("fast", {
      run: async () => {
        await fastRelease.promise;
        return 7;
      },
    });
    const child = step("child", {
      dependsOn: [fast],
      run: async ({ fast }) => {
        expect(fast).toBe(7);
        childStarted.resolve();
        await childRelease.promise;
        return fast + 1;
      },
    });
    const later = step("later", {
      run: () => {
        laterStarted.resolve();
        return 9;
      },
    });
    const finalize = vi.fn((outputs) => outputs.child);
    const pipeline = definePipeline({
      id: "parallel",
      steps: [slow, child, fast, later],
      finalize,
    });
    const run = pipeline.run(
      {},
      { maxConcurrency: 2 },
      {
        hooks: { onStepStart: ({ step }) => started.push(step.id) },
      }
    );
    expect(started).toEqual(["slow", "fast"]);
    fastRelease.resolve();
    await childStarted.promise;
    expect(started).toEqual(["slow", "fast", "child"]);
    childRelease.resolve();
    await laterStarted.promise;
    expect(started).toEqual(["slow", "fast", "child", "later"]);
    expect(finalize).not.toHaveBeenCalled();
    slowRelease.resolve();
    expect((await run).value).toBe(8);
  });

  it("waits for required, optional, and failure-gate prerequisites together", async () => {
    const releases = [defer(), defer(), defer()];
    const finished = [defer(), defer(), defer()];
    const { step } = createSteps();
    const required = step("required", {
      run: async () => {
        await releases[0]!.promise;
        return 1;
      },
    });
    const optional = step("optional", {
      run: async () => {
        await releases[1]!.promise;
        return 2;
      },
    });
    const gate = step("gate", { run: () => releases[2]!.promise });
    const consume = vi.fn((_inputs: { required: number; optional?: number }) => 3);
    const child = step("child", {
      dependsOn: [required],
      optionalDependsOn: [optional],
      skipAfterFailureOf: [gate],
      run: consume,
    });
    const pipeline = definePipeline({ id: "all-edges", steps: [child, required, optional, gate] });
    const run = pipeline.run(
      {},
      { maxConcurrency: 4 },
      {
        hooks: {
          onStepComplete: ({ step }) => {
            const index = ["required", "optional", "gate"].indexOf(step.id);
            if (index >= 0) finished[index]!.resolve();
          },
        },
      }
    );
    for (const index of [1, 0]) {
      releases[index]!.resolve();
      await finished[index]!.promise;
      expect(consume).not.toHaveBeenCalled();
    }
    releases[2]!.resolve();
    expect((await run).value).toBe(3);
    expect(consume.mock.calls[0]?.[0]).toEqual({ required: 1, optional: 2 });
  });

  it.each(["skip", "output", "policy-output", "dry-output"])(
    "holds a slot during %s",
    async (phase) => {
      const entered = defer();
      const release = defer();
      const { step } = createSteps();
      const schema = standardSchema<number, number>(async (value) => {
        if (phase === "skip") return { value: Number(value) };
        entered.resolve();
        await release.promise;
        return { value: Number(value) + 1 };
      });
      const first = step("first", {
        skip: async () => {
          if (phase === "skip") {
            entered.resolve();
            await release.promise;
          }
          return phase === "policy-output" ? { reason: "cached", value: 4 } : false;
        },
        outputSchema: schema,
        dryRun: phase === "dry-output" ? () => 4 : undefined,
        run: () => 4,
      });
      const otherRun = vi.fn(() => 6);
      const other = step("other", { run: otherRun });
      const pipeline = definePipeline({
        id: "slot",
        steps: [first, other],
        finalize: (outputs) => outputs.first,
      });
      const run = pipeline.run({}, { maxConcurrency: 1, dryRun: phase === "dry-output" });
      await entered.promise;
      expect(otherRun).not.toHaveBeenCalled();
      release.resolve();
      expect((await run).value).toBe(phase === "skip" ? 4 : 5);
      expect(otherRun).toHaveBeenCalledOnce();
    }
  );

  it.each([false, true])(
    "drains failures before returning or finalizing (continueOnError=%s)",
    async (continueOnError) => {
      const release = defer();
      const failed = defer();
      const failure = new Error("first failure");
      const { step } = createSteps();
      const first = step("first", {
        run: () => {
          throw failure;
        },
      });
      const second = step("second", {
        run: async () => {
          await release.promise;
          throw new Error("second failure");
        },
      });
      const laterRun = vi.fn(() => 3);
      const later = step("later", { run: laterRun });
      const finalize = vi.fn(() => 9);
      const complete = vi.fn();
      const pipeline = definePipeline({ id: "failure", steps: [first, second, later], finalize });
      const outcome = pipeline
        .runOrThrow(
          {},
          { maxConcurrency: 2, continueOnError },
          {
            hooks: {
              onStepFail: ({ step }) => {
                if (step.id === "first") failed.resolve();
              },
              onPipelineComplete: complete,
            },
          }
        )
        .catch((error: unknown) => error);
      await failed.promise;
      expect(finalize).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      release.resolve();
      const error = await outcome;
      expect(error).toBeInstanceOf(PipelineExecutionError);
      if (!(error instanceof PipelineExecutionError)) throw error;
      expect(error.cause).toBe(failure);
      expect(error.result.errors.map(({ stepId }) => stepId)).toEqual(["first", "second"]);
      expect(error.result.steps.find(({ id }) => id === "later")).toMatchObject(
        continueOnError
          ? { status: "completed" }
          : { status: "skipped", reason: "fail-fast", dependencyId: "first" }
      );
      expect(finalize).toHaveBeenCalledTimes(continueOnError ? 1 : 0);
      expect(laterRun).toHaveBeenCalledTimes(continueOnError ? 1 : 0);
      expect(complete).toHaveBeenCalledOnce();
    }
  );

  it("unlocks dependents after failures and skips in best-effort runs", async () => {
    const { step } = createSteps();
    const fail = step("fail", {
      run: () => {
        throw new Error("failed");
      },
    });
    const skipped = step("skipped", { skip: () => ({ reason: "cached", value: 4 }), run: () => 1 });
    const required = step("required", { dependsOn: [fail], run: () => 1 });
    const gated = step("gated", { skipAfterFailureOf: [fail], run: () => 1 });
    const optional = step("optional", {
      optionalDependsOn: [fail],
      dependsOn: [skipped],
      run: (inputs) => inputs.skipped,
    });
    const pipeline = definePipeline({
      id: "terminal",
      steps: [required, gated, optional, fail, skipped],
    });
    const result = await pipeline.run({}, { maxConcurrency: 3, continueOnError: true });
    expect(result.steps.find(({ id }) => id === "required")).toMatchObject({
      reason: "unmet-dependency",
    });
    expect(result.steps.find(({ id }) => id === "gated")).toMatchObject({
      reason: "failed-dependency",
    });
    expect(result.steps.find(({ id }) => id === "optional")).toMatchObject({ status: "completed" });
    expect(result.value).toBe(4);
  });

  it.each([false, true])(
    "drains in-flight work on abort (continueOnError=%s)",
    async (continueOnError) => {
      const controller = new AbortController();
      const release = defer();
      const cancelled = defer();
      const complete = vi.fn();
      const { step } = createSteps();
      const first = step("first", { run: (_inputs, context) => rejectWhenAborted(context.signal) });
      const second = step("second", { run: () => release.promise });
      const laterRun = vi.fn();
      const later = step("later", { run: laterRun });
      const filtered = step("filtered", { run: vi.fn() });
      const pipeline = definePipeline({ id: "abort", steps: [first, second, later, filtered] });
      const run = pipeline.run(
        {},
        { maxConcurrency: 2, continueOnError, stepIds: ["first", "second", "later"] },
        {
          signal: controller.signal,
          hooks: { onStepCancel: () => cancelled.resolve(), onPipelineComplete: complete },
        }
      );
      controller.abort();
      await cancelled.promise;
      expect(complete).not.toHaveBeenCalled();
      release.resolve();
      const result = await run;
      expect(result.status).toBe("cancelled");
      expect(result.steps.find(({ id }) => id === "second")).toMatchObject({ status: "completed" });
      expect(result.steps.find(({ id }) => id === "later")).toMatchObject({ status: "cancelled" });
      expect(result.steps.find(({ id }) => id === "filtered")).toMatchObject({
        reason: "filtered",
      });
      expect(laterRun).not.toHaveBeenCalled();
    }
  );

  it("handles filtered and dry-run prerequisites without waiting forever", async () => {
    const { step } = createSteps();
    const source = step("source", { dryRun: "skip", run: () => 1 });
    const required = step("required", { dependsOn: [source], run: () => 2 });
    const optional = step("optional", {
      optionalDependsOn: [source],
      run: ({ source }) => source ?? 3,
    });
    const pipeline = definePipeline({
      id: "selection",
      steps: [required, source, optional],
      targets: [optional],
    });
    for (const controls of [{ targets: ["optional" as const] }, { dryRun: true }]) {
      const result = await pipeline.run({}, { ...controls, maxConcurrency: 4 });
      expect(result.value).toBe(3);
      expect(result.steps).toHaveLength(3);
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    "rejects invalid concurrency %s before any user code",
    async (maxConcurrency) => {
      const validate = vi.fn((value: unknown) => ({ value: value as object }));
      const { step } = createSteps(standardSchema<object, object>(validate));
      const runStep = vi.fn();
      const pipeline = definePipeline({ id: "invalid", steps: [step("work", { run: runStep })] });
      const result = await pipeline.run({}, { maxConcurrency });
      expect(result.errors[0]).toMatchObject({ code: "TUBELESS_RUN_CONCURRENCY_INVALID" });
      expect(result.steps).toEqual([]);
      expect(validate).not.toHaveBeenCalled();
      expect(runStep).not.toHaveBeenCalled();
    }
  );

  it("snapshots concurrency from prototype getters before execution", async () => {
    let concurrency = 1;
    class Controls {
      get maxConcurrency() {
        return concurrency;
      }
    }
    const release = defer();
    const { step } = createSteps();
    const first = step("first", {
      run: () => {
        concurrency = 4;
        return release.promise;
      },
    });
    const later = vi.fn();
    const pipeline = definePipeline({
      id: "snapshot",
      steps: [first, step("later", { run: later })],
    });
    const run = pipeline.run({}, new Controls());
    expect(later).not.toHaveBeenCalled();
    release.resolve();
    await run;
    expect(later).toHaveBeenCalledOnce();
  });

  it.each([undefined, 2])(
    "keeps child concurrency separate and strips its control from domain options (%s)",
    async (maxConcurrency) => {
      const started = defer();
      const release = defer();
      const { step } = createSteps<{ label: string }>();
      const first = step("first", {
        run: (_inputs, context) => {
          expect(context.options.label).toBe("child");
          expect("maxConcurrency" in context.options).toBe(false);
          started.resolve();
          return release.promise;
        },
      });
      const secondRun = vi.fn(() => 2);
      const child = definePipeline({
        id: "child",
        steps: [first, step("second", { run: secondRun })],
      });
      const { fromPipeline } = createSteps();
      const wrapper = fromPipeline("wrapper", {
        pipeline: child,
        mapOptions: () => ({ label: "child", maxConcurrency }),
      });
      const parent = definePipeline({ id: "parent", steps: [wrapper] });
      const run = parent.run({}, { maxConcurrency: 4 });
      await started.promise;
      expect(secondRun).toHaveBeenCalledTimes(maxConcurrency === 2 ? 1 : 0);
      release.resolve();
      expect((await run).value).toBe(2);
    }
  );

  it.each(["predicate", "validation"])(
    "stops dispatch after %s failure and drains a sibling",
    async (phase) => {
      const release = defer();
      const failed = defer();
      const { step } = createSteps();
      const first = step("first", {
        skip: () => {
          if (phase === "predicate") throw new Error("skip failed");
          return false;
        },
        outputSchema: standardSchema<number, number>(() => ({
          issues: [{ message: "invalid output" }],
        })),
        run: () => 1,
      });
      const second = step("second", { run: () => release.promise });
      const laterRun = vi.fn();
      const pipeline = definePipeline({
        id: "boundary-failure",
        steps: [first, second, step("later", { run: laterRun })],
      });
      const complete = vi.fn();
      const run = pipeline.run(
        {},
        { maxConcurrency: 2 },
        {
          hooks: { onStepFail: () => failed.resolve(), onPipelineComplete: complete },
        }
      );
      await failed.promise;
      expect(complete).not.toHaveBeenCalled();
      release.resolve();
      const result = await run;
      expect(result.errors[0]?.code).toBe(
        phase === "predicate" ? "TUBELESS_STEP_FAILED" : "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED"
      );
      expect(result.steps.find(({ id }) => id === "second")?.status).toBe("completed");
      expect(laterRun).not.toHaveBeenCalled();
    }
  );

  it("drains started tasks even if the execution operation rejects unexpectedly", async () => {
    const release = defer();
    const started = defer();
    const failure = new Error("unexpected");
    const { step } = createSteps();
    const graph = compilePipelineGraph([
      step("first", { run: () => 1 }),
      step("second", { run: () => 2 }),
    ]);
    let returned = false;
    const outcome = schedulePipelineSteps({
      ...graph,
      maxConcurrency: 2,
      shouldStop: () => false,
      executeOneStep: async (step) => {
        if (step.id === "first") throw failure;
        started.resolve();
        await release.promise;
      },
    }).catch((error: unknown) => {
      returned = true;
      return error;
    });
    await started.promise;
    expect(returned).toBe(false);
    release.resolve();
    expect(await outcome).toBe(failure);
  });
});
