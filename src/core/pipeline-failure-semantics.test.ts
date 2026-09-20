import { describe, expect, it, vi } from "vitest";
import { PIPELINE_FINALIZE_STEP_ID } from "./pipeline-step-metadata.js";
import { defer, rejectWhenAborted } from "./child-pipeline.test-support.js";
import { createSteps, definePipeline, PipelineExecutionError } from "./pipeline.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

describe("parallel failure semantics", () => {
  it.each([false, true])(
    "drains every failure and returns plan order while observing event order (continueOnError=%s)",
    async (continueOnError) => {
      const firstRelease = defer();
      const independentRelease = defer();
      const secondFailed = defer();
      const independentFinished = defer();
      const controller = new AbortController();
      const firstError = new Error("first in plan");
      const secondError = new Error("first observed");
      const liveFailures: string[] = [];
      const traces: PipelineTraceEvent[] = [];
      let activeExports = 0;
      let maxActiveExports = 0;
      const { step } = createSteps();
      const first = step("first", {
        run: async () => {
          await firstRelease.promise;
          throw firstError;
        },
      });
      const second = step("second", {
        run: () => {
          throw secondError;
        },
      });
      const blockedRun = vi.fn();
      const blocked = step("blocked", { dependsOn: [first], run: blockedRun });
      const independent = step("independent", {
        run: async (_inputs, context) => {
          expect(context.signal).toBe(controller.signal);
          await independentRelease.promise;
          expect(context.signal?.aborted).toBe(false);
          return 7;
        },
      });
      const childRun = vi.fn(({ independent }: { independent: number }) => independent + 1);
      const child = step("child", { dependsOn: [independent], run: childRun });
      const gatedRun = vi.fn();
      const gated = step("gated", { skipAfterFailureOf: [second], run: gatedRun });
      const optionalRun = vi.fn(() => "fallback");
      const optional = step("optional", { optionalDependsOn: [second], run: optionalRun });
      const finalize = vi.fn((outputs) => outputs.child);
      const complete = vi.fn();
      const pipeline = definePipeline({
        id: "ordered-failures",
        // Plan order differs from declaration order as well as completion order.
        steps: [blocked, first, second, child, independent, gated, optional],
        finalize,
      });
      const outcome = pipeline
        .runOrThrow(
          {},
          { maxConcurrency: 3, continueOnError },
          {
            signal: controller.signal,
            hooks: {
              onStepFail: ({ step }) => {
                liveFailures.push(step.id);
                if (step.id === "second") secondFailed.resolve();
              },
              onStepComplete: ({ step }) => {
                if (step.id === "independent") independentFinished.resolve();
              },
              onPipelineComplete: complete,
            },
            tracing: {
              exporter: {
                export: async (event) => {
                  maxActiveExports = Math.max(maxActiveExports, ++activeExports);
                  await Promise.resolve();
                  traces.push(event);
                  activeExports--;
                },
              },
            },
          }
        )
        .catch((error: unknown) => error);
      await secondFailed.promise;
      expect(controller.signal.aborted).toBe(false);
      independentRelease.resolve();
      await independentFinished.promise;
      expect(finalize).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      firstRelease.resolve();
      const error = await outcome;
      expect(error).toBeInstanceOf(PipelineExecutionError);
      if (!(error instanceof PipelineExecutionError)) throw error;
      const result = error.result;
      expect(error.cause).toBe(firstError);
      expect(result.errors.map(({ stepId }) => stepId)).toEqual(["first", "second"]);
      expect(result.steps.map(({ id }) => id)).toEqual(pipeline.plan().steps.map(({ id }) => id));
      expect(liveFailures).toEqual(["second", "first"]);
      expect(
        traces.filter(({ name }) => name === "step.failed").map(({ stepId }) => stepId)
      ).toEqual(liveFailures);
      expect(traces.at(-1)?.name).toBe("pipeline.completed");
      expect(maxActiveExports).toBe(1);
      expect(complete).toHaveBeenCalledWith(result);
      expect(result.steps.find(({ id }) => id === "independent")?.status).toBe("completed");
      expect(result.steps.find(({ id }) => id === "blocked")).toMatchObject({
        status: "skipped",
        reason: continueOnError ? "unmet-dependency" : "fail-fast",
        dependencyId: continueOnError ? "first" : "second",
      });
      expect(result.steps.find(({ id }) => id === "gated")).toMatchObject({
        status: "skipped",
        reason: continueOnError ? "failed-dependency" : "fail-fast",
        dependencyId: "second",
      });
      expect(blockedRun).not.toHaveBeenCalled();
      expect(gatedRun).not.toHaveBeenCalled();
      expect(childRun).toHaveBeenCalledTimes(continueOnError ? 1 : 0);
      expect(optionalRun).toHaveBeenCalledTimes(continueOnError ? 1 : 0);
      expect(finalize).toHaveBeenCalledTimes(continueOnError ? 1 : 0);
      expect(result.value).toBe(continueOnError ? 8 : undefined);
    }
  );

  it.each([false, true])(
    "lets external cancellation override fail-fast for unstarted selected steps (continueOnError=%s)",
    async (continueOnError) => {
      const firstRelease = defer();
      const thirdRelease = defer();
      const cancelled = defer();
      const failed = defer();
      const controller = new AbortController();
      const { step } = createSteps();
      const first = step("first", {
        run: async () => {
          await firstRelease.promise;
          throw new Error("real failure during abort");
        },
      });
      const second = step("second", {
        run: (_inputs, context) => {
          expect(context.signal).toBe(controller.signal);
          return rejectWhenAborted(context.signal);
        },
      });
      const third = step("third", { run: () => thirdRelease.promise });
      const laterRun = vi.fn();
      const later = step("later", { dependsOn: [first], run: laterRun });
      const dry = step("dry", { dependsOn: [third], dryRun: "skip", run: laterRun });
      const filtered = step("filtered", { run: laterRun });
      const finalize = vi.fn();
      const complete = vi.fn();
      const pipeline = definePipeline({
        id: "abort-precedence",
        steps: [first, second, third, later, dry, filtered],
        finalize,
      });
      const run = pipeline.run(
        {},
        {
          maxConcurrency: 3,
          continueOnError,
          dryRun: true,
          stepIds: ["first", "second", "third", "later", "dry"],
        },
        {
          signal: controller.signal,
          hooks: {
            onStepCancel: () => cancelled.resolve(),
            onStepFail: () => {
              failed.resolve();
              controller.abort("operator stopped");
            },
            onPipelineComplete: complete,
          },
        }
      );
      firstRelease.resolve();
      await failed.promise;
      await cancelled.promise;
      expect(complete).not.toHaveBeenCalled();
      thirdRelease.resolve();
      const result = await run;
      expect(result.status).toBe("failed");
      expect(result.steps.map(({ id, status }) => [id, status])).toEqual([
        ["first", "failed"],
        ["second", "cancelled"],
        ["third", "completed"],
        ["later", "cancelled"],
        ["dry", "cancelled"],
        ["filtered", "skipped"],
      ]);
      expect(
        result.errors.filter(({ phase }) => phase === "execution").map(({ stepId }) => stepId)
      ).toEqual(["first", "second"]);
      expect(laterRun).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    "prioritizes run cancellation from a failure hook in runOrThrow (continueOnError=%s)",
    async (continueOnError) => {
      const controller = new AbortController();
      const failure = new Error("step failed");
      const cancellation = new Error("operator cancelled the run");
      const { step } = createSteps();
      const first = step("first", {
        run: () => {
          throw failure;
        },
      });
      const active = step("active", { run: () => 1 });
      const pendingRun = vi.fn();
      const pending = step("pending", { run: pendingRun });
      const pipeline = definePipeline({ id: "run-error-order", steps: [first, active, pending] });
      const error = await pipeline
        .runOrThrow(
          {},
          { maxConcurrency: 2, continueOnError },
          {
            signal: controller.signal,
            hooks: { onStepFail: () => controller.abort(cancellation) },
          }
        )
        .catch((error: unknown) => error);

      expect(error).toBeInstanceOf(PipelineExecutionError);
      if (!(error instanceof PipelineExecutionError)) throw error;
      expect(error.cause).toBe(cancellation);
      expect(error.message).toContain(cancellation.message);
      expect(error.result.status).toBe("failed");
      expect(error.result.errors.map(({ code, stepId }) => [code, stepId])).toEqual([
        ["TUBELESS_RUN_CANCELLED", "pending"],
        ["TUBELESS_STEP_FAILED", "first"],
        ...(continueOnError
          ? [["TUBELESS_FINALIZATION_CANCELLED", PIPELINE_FINALIZE_STEP_ID]]
          : []),
      ]);
      expect(error.result.steps.map(({ id, status }) => [id, status])).toEqual([
        ["first", "failed"],
        ["active", "completed"],
        ["pending", "cancelled"],
      ]);
      expect(pendingRun).not.toHaveBeenCalled();
    }
  );

  it("cancels pending work after abort even when every active handler ignores the signal", async () => {
    const release = defer();
    const controller = new AbortController();
    const { step } = createSteps();
    const first = step("first", { run: () => release.promise });
    const second = step("second", { run: () => release.promise });
    const pendingRun = vi.fn();
    const pending = step("pending", { run: pendingRun });
    const complete = vi.fn();
    const pipeline = definePipeline({ id: "cooperative-abort", steps: [first, second, pending] });
    const run = pipeline.run(
      {},
      { maxConcurrency: 2 },
      {
        signal: controller.signal,
        hooks: { onPipelineComplete: complete },
      }
    );
    controller.abort("stop");
    expect(complete).not.toHaveBeenCalled();
    release.resolve();
    const result = await run;
    expect(result.steps.map(({ status }) => status)).toEqual([
      "completed",
      "completed",
      "cancelled",
    ]);
    expect(result.errors).toMatchObject([{ code: "TUBELESS_RUN_CANCELLED", stepId: "pending" }]);
    expect(result.status).toBe("cancelled");
    expect(pendingRun).not.toHaveBeenCalled();
  });
});
