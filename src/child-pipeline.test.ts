import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelineChildError } from "./child-execution.js";
import { createPipelineReporter, type ReporterOutput } from "./interactive-reporter.js";
import {
  createSteps,
  defaultPipelineContext,
  definePipeline,
  PipelineExecutionError,
  type PipelineExecutionContext,
  type PipelineStepProgress,
  type Step,
} from "./pipeline.js";
import type { PipelineTraceEvent } from "./tracing.js";

function captureOutput(): ReporterOutput & { chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    columns: 100,
    isTTY: true,
    write: (chunk) => chunks.push(chunk),
  };
}

describe("child-pipeline composition", () => {
  describe("mapped child adapter", () => {
    it("runs runtime-selected children with bounded concurrency and stable result order", async () => {
      interface ParentOptions {
        concurrency: number;
      }
      interface ChildOptions {
        delayMs: number;
        itemId: string;
      }

      let active = 0;
      let maxActive = 0;
      const childStep = createSteps<ChildOptions>();
      const process = childStep("process", {
        run: async (_inputs, context) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, context.options.delayMs));
          active -= 1;
          return context.options.itemId;
        },
      });
      const child = definePipeline({
        id: "worker",
        steps: [process],
        finalize: (outputs) => ({ workerId: outputs.process ?? "missing" }),
      });

      const parentStep = createSteps<ParentOptions>();
      const select = parentStep("select", {
        run: () => [
          { delayMs: 20, id: "first" },
          { delayMs: 1, id: "second" },
          { delayMs: 1, id: "third" },
        ],
      });
      const children = parentStep.forEachPipeline("children", {
        pipeline: child,
        dependsOn: [select],
        items: ({ select }) => select,
        key: (item) => item.id,
        concurrency: (_inputs, context) => context.options.concurrency,
        progress: { itemNoun: "shards" },
        mapOptions: (item) => ({ delayMs: item.delayMs, itemId: item.id }),
      });
      expectTypeOf(children).toEqualTypeOf<
        Step<"children", readonly { workerId: string }[], ParentOptions>
      >();
      const parent = definePipeline({
        id: "batch-parent",
        steps: [select, children],
        finalize: (outputs) => outputs.children,
      });
      expect(parent.plan().steps[1]?.nestedPipeline).toEqual({
        mode: "for-each",
        pipelineId: "worker",
        stepIds: ["process"],
      });
      const progress: PipelineStepProgress[] = [];

      const result = await parent.run({ concurrency: 2 }, undefined, {
        cwd: "/repo",
        hooks: {
          onStepProgress: ({ progress: nextProgress }) => progress.push(nextProgress),
        },
        log: console,
      });

      expect(result.status).toBe("completed");
      expect(result.value).toEqual([
        { workerId: "first" },
        { workerId: "second" },
        { workerId: "third" },
      ]);
      expect(maxActive).toBe(2);
      expect(
        progress.some(
          ({ message, details }) =>
            message?.includes("running (max 2)") &&
            message.includes("shards") &&
            Boolean(
              details?.some(
                (detail) => detail.id === "first" || detail.id === "second" || detail.id === "third"
              )
            )
        )
      ).toBe(true);
      expect(progress.some(({ message }) => message?.includes("completed"))).toBe(true);
      expect(progress.at(-1)).toMatchObject({
        completed: 3,
        total: 3,
      });
      expect(progress.at(-1)?.message).toMatch(/3\/3 shards/);
      expect(progress.at(-1)?.details ?? []).toEqual([]);
    });

    it("waits for running children and fails the parent when any selected child fails", async () => {
      interface ChildOptions {
        fail: boolean;
        itemId: string;
      }

      let successfulChildFinished = false;
      const childStep = createSteps<ChildOptions>();
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
      const parentStep = createSteps();
      const children = parentStep.forEachPipeline("children", {
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

      const childStep = createSteps<ChildOptions>();
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
      const parentStep = createSteps();
      const children = parentStep.forEachPipeline("children", {
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
      const childStep = createSteps();
      const process = childStep("process", { run: runChild });
      const child = definePipeline({
        id: "raw-abort-child",
        steps: [process],
        finalize: (outputs) => outputs.process,
      });
      const parentStep = createSteps();
      const children = parentStep.forEachPipeline("children", {
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

    it("rejects an invalid mapped child plan with structured plan errors before child execution", async () => {
      const runChild = vi.fn();
      const childStep = createSteps();
      const known = childStep("known", { run: runChild });
      const child = definePipeline({
        id: "mapped-planned-child",
        steps: [known],
        finalize: () => true,
      });
      const runSpy = vi.spyOn(child, "run");
      const parentStep = createSteps();
      const children = parentStep.forEachPipeline("children", {
        pipeline: child,
        items: () => [{ id: "only" }],
        key: (item) => item.id,
        mapOptions: () => ({ stepIds: ["missing" as never] }),
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

    it("plans each mapped child once per item", async () => {
      const childStep = createSteps();
      const work = childStep("work", { run: () => "done" });
      const child = definePipeline({
        id: "mapped-once-child",
        steps: [work],
        finalize: () => true,
      });
      const planSpy = vi.spyOn(child, "plan");
      const runSpy = vi.spyOn(child, "run");
      const parentStep = createSteps();
      const children = parentStep.forEachPipeline("children", {
        pipeline: child,
        items: () => [{ id: "a" }, { id: "b" }],
        key: (item) => item.id,
        mapOptions: () => ({}),
      });
      const parent = definePipeline({
        id: "mapped-once-parent",
        steps: [children],
        finalize: () => true,
      });

      const result = await parent.run({});

      expect(result.status).toBe("completed");
      expect(planSpy).toHaveBeenCalledTimes(2);
      expect(runSpy).not.toHaveBeenCalled();
    });

    it("does not count filtered child steps toward fan-out progress", async () => {
      interface ChildOptions {
        itemId: string;
      }

      const childStep = createSteps<ChildOptions>();
      let processStarted = false;
      // Independent steps so filtering "setup" does not unmet-dependency "process".
      const setup = childStep("setup", {
        run: () => "setup",
      });
      const process = childStep("process", {
        run: async (_inputs, context) => {
          processStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return context.options.itemId;
        },
      });
      const child = definePipeline({
        id: "filtered-child",
        steps: [setup, process],
        finalize: (outputs) => outputs.process ?? outputs.setup,
      });

      const parentStep = createSteps();
      const children = parentStep.forEachPipeline("children", {
        pipeline: child,
        items: () => [{ id: "only" }],
        key: (item) => item.id,
        // Select only process so setup is filtered out at the child plan.
        mapOptions: (item) => ({ itemId: item.id, stepIds: ["process"] as const }),
      });
      const parent = definePipeline({
        id: "filtered-parent",
        steps: [children],
        finalize: (outputs) => outputs.children,
      });

      const progress: PipelineStepProgress[] = [];
      let sawFullBeforeProcess = false;
      const result = await parent.run({}, undefined, {
        cwd: "/tmp",
        hooks: {
          onStepProgress: ({ progress: next, step }) => {
            if (step.id !== "children") return;
            progress.push({
              completed: next.completed,
              total: next.total,
              message: next.message,
            });
            if (!processStarted && next.total === 1 && next.completed >= 1) {
              sawFullBeforeProcess = true;
            }
          },
        },
        log: console,
      });

      expect(result.status).toBe("completed");
      expect(processStarted).toBe(true);
      // Denominator is selected work only (process).
      expect(progress.some((p) => p.total === 1)).toBe(true);
      // Filtered setup must not advance completed before process runs.
      expect(sawFullBeforeProcess).toBe(false);
      expect(progress.at(-1)).toMatchObject({ completed: 1, total: 1 });
    });

    it("uses the exact selected-step total when mapped items choose different child plans", async () => {
      interface ChildOptions {
        itemId: string;
      }
      const childStep = createSteps<ChildOptions>();
      const prepare = childStep("prepare", {
        run: (_inputs, context) => `prepared:${context.options.itemId}`,
      });
      const process = childStep("process", {
        dependsOn: [prepare],
        run: (_inputs, context) => `processed:${context.options.itemId}`,
      });
      const child = definePipeline({
        id: "mixed-plan-child",
        steps: [prepare, process],
        finalize: (outputs) => outputs.process ?? outputs.prepare,
      });

      const parentStep = createSteps();
      const children = parentStep.forEachPipeline("children", {
        pipeline: child,
        items: () => [
          { id: "prepare-only", stepIds: ["prepare"] as const },
          { id: "full", stepIds: ["prepare", "process"] as const },
        ],
        key: (item) => item.id,
        mapOptions: (item) => ({ itemId: item.id, stepIds: item.stepIds }),
      });
      const parent = definePipeline({
        id: "mixed-plan-parent",
        steps: [children],
        finalize: (outputs) => outputs.children,
      });
      const progress: Array<{ completed: number; total?: number }> = [];

      const result = await parent.run({}, undefined, {
        cwd: "/tmp",
        hooks: {
          onStepProgress: ({ progress: next, step }) => {
            if (step.id === "children") {
              progress.push({ completed: next.completed, total: next.total });
            }
          },
        },
        log: console,
      });

      expect(result.status).toBe("completed");
      expect(progress.at(-1)).toEqual({ completed: 3, total: 3 });
      expect(progress.some(({ total }) => total === 4)).toBe(false);
      let previousRatio = 0;
      for (const next of progress) {
        if (next.total === undefined || next.total === 0) continue;
        const ratio = next.completed / next.total;
        expect(ratio).toBeGreaterThanOrEqual(previousRatio);
        previousRatio = ratio;
      }
    });

    it("does not re-publish mapped progress from empty child progress snapshots", async () => {
      const childStep = createSteps();
      const work = childStep("work", {
        run: async (_inputs, context) => {
          context.reportProgress({ completed: 1, total: 2, message: "chunk" });
          await new Promise((resolve) => setTimeout(resolve, 250));
          return "done";
        },
      });
      const child = definePipeline({
        id: "mapped-empty-progress-child",
        steps: [work],
        finalize: (outputs) => outputs.work,
      });
      const parentStep = createSteps();
      const children = parentStep.forEachPipeline("children", {
        pipeline: child,
        items: () => [{ id: "only" }],
        key: (item) => item.id,
        mapOptions: () => ({}),
      });
      const parent = definePipeline({
        id: "mapped-empty-progress-parent",
        steps: [children],
        finalize: (outputs) => outputs.children,
      });
      let visibleFanoutPublishes = 0;
      let zeroProgressLabels = 0;
      const result = await parent.run({}, undefined, {
        cwd: "/tmp",
        hooks: {
          onStepProgress: ({ progress, step }) => {
            if (step.id !== "children") return;
            // Empty snapshots have no total/message; ignore those.
            if (!progress.message && progress.total === undefined) return;
            visibleFanoutPublishes += 1;
            const labels = [
              progress.message ?? "",
              ...(progress.details ?? []).map((detail) => detail.label ?? ""),
            ];
            if (labels.some((label) => /work:0\b/.test(label) || label.endsWith(":0"))) {
              zeroProgressLabels += 1;
            }
          },
        },
        log: console,
      });

      expect(result.status).toBe("completed");
      // Real child progress + lifecycle updates only — not empty-progress spam.
      expect(visibleFanoutPublishes).toBeLessThan(15);
      expect(zeroProgressLabels).toBe(0);
    });

    it("rejects duplicate item keys before starting children", async () => {
      const runChild = vi.fn();
      const childStep = createSteps();
      const process = childStep("process", { run: runChild });
      const child = definePipeline({
        id: "keyed-child",
        steps: [process],
        finalize: () => true,
      });
      const parentStep = createSteps();
      const children = parentStep.forEachPipeline("children", {
        pipeline: child,
        items: () => [{ id: "same" }, { id: "same" }],
        key: (item) => item.id,
        mapOptions: () => ({}),
      });
      const parent = definePipeline({
        id: "keyed-parent",
        steps: [children],
        finalize: () => true,
      });

      const result = await parent.run({});

      expect(result.status).not.toBe("completed");
      expect(result.errors[0]?.message).toContain("duplicate item keys: same");
      expect(runChild).not.toHaveBeenCalled();
    });
  });

  describe("opaque child adapter", () => {
    it("infers dependencies, options, and results while isolating hooks and bridging progress", async () => {
      interface ParentOptions {
        source: string;
      }
      interface ChildOptions {
        input: string;
        recordCount: number;
      }
      interface ChildResult {
        written: number;
      }

      const controller = new AbortController();
      const log = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
      const now = vi.fn(() => 42);
      const sleep = vi.fn(async () => undefined);
      const inheritedContexts: Array<{
        cwd: string;
        nowMatches: boolean;
        signalMatches: boolean;
        sleepMatches: boolean;
      }> = [];
      const childStep = createSteps<ChildOptions>();
      const childLoad = childStep("load", {
        run: async (_inputs, context) => {
          context.log.log("child log");
          inheritedContexts.push({
            cwd: context.cwd,
            nowMatches: context.now === now,
            signalMatches: context.signal === controller.signal,
            sleepMatches: context.sleep === sleep,
          });
          context.reportProgress({ completed: 1, total: 2, message: "half" });
          await context.sleep(7, context.signal);
          return context.options.recordCount;
        },
      });
      const childWrite = childStep("write", {
        dependsOn: [childLoad],
        run: ({ load }) => load,
      });
      const child = definePipeline({
        id: "typed-child",
        steps: [childLoad, childWrite],
        finalize: (outputs): ChildResult => ({ written: outputs.write ?? 0 }),
      });

      const parentStep = createSteps<ParentOptions>();
      const prepare = parentStep("prepare", { run: () => ({ records: 3 }) });
      const optionalHint = parentStep("optional-hint", { run: () => "hint" as const });
      const rawChild = parentStep.fromPipeline("raw-child", {
        pipeline: child,
        mapOptions: (_inputs, context) => ({ input: context.options.source, recordCount: 1 }),
      });
      expectTypeOf(rawChild).toEqualTypeOf<Step<"raw-child", ChildResult, ParentOptions>>();

      parentStep.fromPipeline("skip-requires-skippable", {
        pipeline: child,
        // @ts-expect-error Policy skip belongs on fromPipeline.skippable.
        skip: () => "child not requested",
        mapOptions: (_inputs, context) => ({
          input: context.options.source,
          recordCount: 1,
        }),
      });

      const reusableSkippingChildDefinition = {
        pipeline: child,
        skip: () => "child not requested",
        mapOptions: (
          _inputs: Record<string, never>,
          context: PipelineExecutionContext<ParentOptions>
        ) => ({
          input: context.options.source,
          recordCount: 1,
        }),
      };
      // @ts-expect-error Reusable definitions cannot bypass fromPipeline.skippable.
      parentStep.fromPipeline("reusable-skip-requires-skippable", reusableSkippingChildDefinition);

      const mappedChild = parentStep.fromPipeline("mapped-child", {
        pipeline: child,
        dependsOn: [prepare],
        optionalDependsOn: [optionalHint],
        description: "Run typed child",
        mapOptions: (inputs, context) => {
          expectTypeOf(inputs.prepare).toEqualTypeOf<{ records: number }>();
          expectTypeOf(inputs["optional-hint"]).toEqualTypeOf<"hint" | undefined>();
          expectTypeOf(context).toEqualTypeOf<PipelineExecutionContext<ParentOptions>>();
          expectTypeOf<
            "reportProgress" extends keyof typeof context ? true : false
          >().toEqualTypeOf<false>();
          return {
            input: context.options.source,
            recordCount: inputs.prepare.records,
          };
        },
        mapResult: (value) => ({ count: value.written, ran: true as const }),
      });
      expectTypeOf(mappedChild).toEqualTypeOf<
        Step<"mapped-child", { count: number; ran: true }, ParentOptions>
      >();

      const skippedChild = parentStep.fromPipeline.skippable("skipped-child", {
        pipeline: child,
        skip: () => "child not requested",
        mapOptions: (_inputs, context) => ({
          input: context.options.source,
          recordCount: 1,
        }),
      });
      expectTypeOf(skippedChild).toEqualTypeOf<
        Step<"skipped-child", ChildResult | undefined, ParentOptions>
      >();

      const enableChildSkip = false as boolean;
      const gatedSkipChild = parentStep.fromPipeline.skippable("gated-skip-child", {
        pipeline: child,
        skip: enableChildSkip ? () => "child not requested" : undefined,
        mapOptions: (_inputs, context) => ({
          input: context.options.source,
          recordCount: 1,
        }),
      });
      expectTypeOf(gatedSkipChild).toEqualTypeOf<
        Step<"gated-skip-child", ChildResult | undefined, ParentOptions>
      >();

      const skippedMappedChild = parentStep.fromPipeline.skippable("skipped-mapped-child", {
        pipeline: child,
        // Skip value is parent-facing TOut (mapResult is not applied on the skip path).
        skip: () => ({
          reason: "mapped child not requested",
          value: { count: 0, ran: false as const },
        }),
        mapOptions: (_inputs, context) => ({
          input: context.options.source,
          recordCount: 1,
        }),
        mapResult: (value) => ({ count: value.written, ran: false as const }),
      });
      expectTypeOf(skippedMappedChild).toEqualTypeOf<
        Step<"skipped-mapped-child", { count: number; ran: false } | undefined, ParentOptions>
      >();
      parentStep.fromPipeline.skippable("invalid-skip-value-shape", {
        pipeline: child,
        // @ts-expect-error skip value must be mapped TOut, not raw child result.
        skip: () => ({ reason: "wrong shape", value: { written: 0 } }),
        mapOptions: (_inputs, context) => ({
          input: context.options.source,
          recordCount: 1,
        }),
        mapResult: (value) => ({ count: value.written, ran: false as const }),
      });

      parentStep.fromPipeline("invalid-child-options", {
        pipeline: child,
        // @ts-expect-error ChildOptions requires input and recordCount.
        mapOptions: () => ({}),
      });

      const parent = definePipeline({
        id: "typed-parent",
        steps: [prepare, optionalHint, mappedChild],
        finalize: (outputs) => {
          expectTypeOf(outputs["mapped-child"]).toEqualTypeOf<
            { count: number; ran: true } | undefined
          >();
          return outputs["mapped-child"];
        },
      });
      const lifecycle: string[] = [];
      const progress: PipelineStepProgress[] = [];
      const result = await parent.run({ source: "rows.json" }, undefined, {
        cwd: "/repo",
        hooks: {
          onFinalizeStart: ({ pipelineId }) => lifecycle.push(`finalize:${pipelineId}`),
          onPipelineComplete: ({ pipelineId }) => lifecycle.push(`complete:${pipelineId}`),
          onPipelineStart: ({ pipelineId }) => lifecycle.push(`start:${pipelineId}`),
          onStepProgress: ({ progress: nextProgress }) => progress.push(nextProgress),
          onStepStart: ({ step }) => lifecycle.push(`step:${step.id}`),
        },
        log,
        now,
        signal: controller.signal,
        sleep,
      });

      expect(parent.plan().steps.map(({ id }) => id)).toEqual([
        "prepare",
        "optional-hint",
        "mapped-child",
      ]);
      expect(parent.plan().steps.map(({ id }) => id)).not.toContain("load");
      expect(result.status).toBe("completed");
      expect(result.value).toEqual({ count: 3, ran: true });
      expect(inheritedContexts).toEqual([
        {
          cwd: "/repo",
          nowMatches: true,
          signalMatches: true,
          sleepMatches: true,
        },
      ]);
      expect(log.log).toHaveBeenCalledWith("child log");
      expect(sleep).toHaveBeenCalledWith(7, controller.signal);
      expect(lifecycle).toEqual([
        "start:typed-parent",
        "step:prepare",
        "step:optional-hint",
        "step:mapped-child",
        "finalize:typed-parent",
        "complete:typed-parent",
      ]);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every(({ total }) => total === 2)).toBe(true);
      expect(progress.every(({ message }) => message?.startsWith("typed-child/") === true)).toBe(
        true
      );
      expect(progress.map(({ completed }) => completed)).toEqual(
        [...progress.map(({ completed }) => completed)].sort((left, right) => left - right)
      );
      expect(progress).toContainEqual({
        completed: 0,
        total: 2,
        message: "typed-child/load: half",
      });
      expect(progress.at(-1)).toEqual({
        completed: 2,
        total: 2,
        message: "typed-child/write: complete",
      });
    });

    it("does not bridge empty child progress as visible parent progress", async () => {
      const childStep = createSteps();
      const work = childStep("work", {
        run: async (_inputs, context) => {
          context.reportProgress({ completed: 3, total: 10, message: "batch" });
          await new Promise((resolve) => setTimeout(resolve, 250));
          return "done";
        },
      });
      const child = definePipeline({
        id: "empty-progress-child",
        steps: [work],
        finalize: (outputs) => outputs.work,
      });
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("stage", {
        pipeline: child,
        mapOptions: () => ({}),
      });
      const parent = definePipeline({
        id: "empty-progress-parent",
        steps: [stage],
        finalize: (outputs) => outputs.stage,
      });
      const bridged: string[] = [];
      const result = await parent.run({}, undefined, {
        cwd: "/tmp",
        hooks: {
          onStepProgress: ({ progress, step }) => {
            if (step.id !== "stage" || !progress.message) return;
            bridged.push(progress.message);
          },
        },
        log: console,
      });

      expect(result.status).toBe("completed");
      expect(bridged.filter((message) => message.includes("batch"))).toHaveLength(1);
      expect(bridged.some((message) => message.includes("0 completed"))).toBe(false);
    });

    it("policy-skips fromPipeline with mapResult using the parent-facing skip value", async () => {
      interface ChildOptions {
        n: number;
      }
      const childStep = createSteps<ChildOptions>();
      const write = childStep("write", {
        run: () => {
          throw new Error("child should not run when parent step is policy-skipped");
        },
      });
      const child = definePipeline({
        id: "mappable-child",
        steps: [write],
        finalize: (outputs): { written: number } => ({ written: outputs.write ?? -1 }),
      });

      const parentStep = createSteps();
      let mapResultCalls = 0;
      const stage = parentStep.fromPipeline.skippable("stage", {
        pipeline: child,
        skip: () => ({
          reason: "stage disabled",
          value: { count: 0, ran: false as const },
        }),
        mapOptions: () => ({ n: 1 }),
        mapResult: (value) => {
          mapResultCalls += 1;
          return { count: value.written, ran: false as const };
        },
      });
      const after = parentStep("after", {
        dependsOn: [stage],
        run: (inputs) => inputs.stage,
      });
      const parent = definePipeline({
        id: "skip-mapped-parent",
        steps: [stage, after],
        finalize: (outputs) => outputs.after,
      });

      const result = await parent.run({}, undefined, { cwd: "/tmp", log: console });

      expect(mapResultCalls).toBe(0);
      expect(result.status).toBe("completed");
      expect(result.value).toEqual({ count: 0, ran: false });
      expect(
        result.steps.map((step) => [
          step.id,
          step.status,
          step.status === "skipped" ? step.reason : undefined,
        ])
      ).toEqual([
        ["stage", "skipped", "policy"],
        ["after", "completed", undefined],
      ]);
    });

    it("keeps the child opaque when it is the only parent step", () => {
      const childStep = createSteps();
      const inside = childStep("inside", { run: () => "done" });
      const child = definePipeline({ id: "opaque-child", steps: [inside], finalize: () => true });
      const parentStep = createSteps();
      const childStage = parentStep.fromPipeline("child-stage", {
        pipeline: child,
        mapOptions: () => ({}),
      });
      const parent = definePipeline({
        id: "opaque-parent",
        steps: [childStage],
        finalize: (outputs) => outputs["child-stage"],
      });

      expect(parent.plan({}).steps).toMatchObject([
        {
          id: "child-stage",
          nestedPipeline: {
            mode: "single",
            pipelineId: "opaque-child",
            stepIds: ["inside"],
          },
        },
      ]);
    });

    it("applies parent dry-run last and lets the child skip side effects", async () => {
      const sideEffect = vi.fn();
      const observedDryRuns: boolean[] = [];
      const childStep = createSteps();
      const write = childStep("write", { dryRun: "skip", run: sideEffect });
      const inspect = childStep("inspect", {
        run: (_inputs, context) => observedDryRuns.push(context.dryRun),
      });
      const child = definePipeline({
        id: "dry-child",
        steps: [write, inspect],
        finalize: () => "dry-result",
      });
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("dry-stage", {
        pipeline: child,
        mapOptions: () => ({ dryRun: false }),
      });
      const parent = definePipeline({
        id: "dry-parent",
        steps: [stage],
        finalize: (outputs) => outputs["dry-stage"],
      });

      const result = await parent.run({}, { dryRun: true });

      expect(result.status).toBe("completed");
      expect(result.value).toBe("dry-result");
      expect(sideEffect).not.toHaveBeenCalled();
      expect(observedDryRuns).toEqual([true]);
    });

    it("reads child mapOptions accessors through the original receiver", async () => {
      class MixedChildOptions {
        readonly #label = "secret";
        continueOnError = true;

        get label(): string {
          return this.#label;
        }

        read(): string {
          return this.#label;
        }
      }

      const childStep = createSteps<{ label: string } & { read(): string }>();
      const inspect = childStep("inspect", {
        run: (_inputs, context) => {
          expect(context.options).toBeInstanceOf(MixedChildOptions);
          expect("continueOnError" in context.options).toBe(false);
          return `${context.options.label}:${context.options.read()}`;
        },
      });
      const child = definePipeline({
        id: "accessor-child",
        steps: [inspect],
        finalize: (outputs) => outputs.inspect,
      });
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("accessor-stage", {
        pipeline: child,
        mapOptions: () => new MixedChildOptions(),
      });
      const parent = definePipeline({
        id: "accessor-parent",
        steps: [stage],
        finalize: (outputs) => outputs["accessor-stage"],
      });

      await expect(parent.runOrThrow({})).resolves.toBe("secret:secret");
    });

    it("hides control keys on a frozen mixed mapOptions bag", async () => {
      const mixed = Object.freeze({ continueOnError: true, label: "frozen" });
      const childStep = createSteps<{ label: string }>();
      const inspect = childStep("inspect", {
        run: (_inputs, context) => {
          expect("continueOnError" in context.options).toBe(false);
          expect(Object.keys(context.options)).toEqual(["label"]);
          return context.options.label;
        },
      });
      const child = definePipeline({
        id: "frozen-child",
        steps: [inspect],
        finalize: (outputs) => outputs.inspect,
      });
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("frozen-stage", {
        pipeline: child,
        mapOptions: () => mixed,
      });
      const parent = definePipeline({
        id: "frozen-parent",
        steps: [stage],
        finalize: (outputs) => outputs["frozen-stage"],
      });

      await expect(parent.runOrThrow({})).resolves.toBe("frozen");
    });

    it("fails one opaque step with child-identifying details and skips parent finalization", async () => {
      const childStep = createSteps();
      const explode = childStep("explode", {
        run: () => {
          throw new Error("database unavailable");
        },
      });
      const child = definePipeline({
        id: "failing-child",
        steps: [explode],
        finalize: () => "unreachable",
      });
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("child-stage", {
        pipeline: child,
        mapOptions: () => ({}),
      });
      const parentFinalize = vi.fn(() => "parent-result");
      const parent = definePipeline({
        id: "failure-parent",
        steps: [stage],
        finalize: parentFinalize,
      });

      const result = await parent.run({});

      expect(result.status).not.toBe("completed");
      expect(result.finalized).toBe(false);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toMatchObject({
        id: "child-stage",
        status: "failed",
        error: {
          code: "TUBELESS_CHILD_FAILED",
          kind: "child",
          message: "Child pipeline failing-child failed at explode: database unavailable",
          phase: "execution",
          stepId: "child-stage",
        },
      });
      expect(result.steps[0]).toMatchObject({ status: "failed", error: result.errors[0] });
      expect(parentFinalize).not.toHaveBeenCalled();
    });

    it("fails the parent when a continuing child contains errors", async () => {
      const childStep = createSteps();
      const fail = childStep("fail", {
        run: () => {
          throw new Error("expected failure");
        },
      });
      const recover = childStep("recover", { run: () => "recovered" });
      const child = definePipeline({
        id: "continuing-child",
        steps: [fail, recover],
        finalize: (outputs) => outputs.recover,
      });
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("continuing-stage", {
        pipeline: child,
        mapOptions: () => ({ continueOnError: true }),
      });
      const parent = definePipeline({
        id: "continuing-parent",
        steps: [stage],
        finalize: (outputs) => outputs["continuing-stage"],
      });

      const result = await parent.run({});

      expect(result.status).not.toBe("completed");
      expect(result.finalized).toBe(false);
      expect(result.errors[0]?.message).toContain(
        "Child pipeline continuing-child failed at fail: expected failure"
      );
    });

    it("preserves a child pipeline's cause chain on the opaque parent error", async () => {
      const rootCause = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
      const childError = new Error("request failed", { cause: rootCause });
      const childStep = createSteps();
      const fail = childStep("fail", {
        run: () => {
          throw childError;
        },
      });
      const child = definePipeline({
        id: "causal-child",
        steps: [fail],
        finalize: () => undefined,
      });
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("causal-stage", {
        pipeline: child,
        mapOptions: () => ({}),
      });
      const parent = definePipeline({
        id: "causal-parent",
        steps: [stage],
        finalize: () => undefined,
      });

      const result = await parent.run({});

      expect(result.errors[0]).toMatchObject({
        cause: {
          cause: {
            message: "socket closed",
            sourceCode: "ECONNRESET",
          },
          message: "request failed",
        },
        code: "TUBELESS_CHILD_FAILED",
        kind: "child",
        stepId: "causal-stage",
      });
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("rejects an invalid child plan before child execution starts", async () => {
      const runChild = vi.fn();
      const childStep = createSteps();
      const known = childStep("known", { run: runChild });
      const child = definePipeline({ id: "planned-child", steps: [known], finalize: () => true });
      const runSpy = vi.spyOn(child, "run");
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("planned-stage", {
        pipeline: child,
        mapOptions: () => ({ stepIds: ["missing" as never] }),
      });
      const parent = definePipeline({ id: "planned-parent", steps: [stage], finalize: () => true });

      const result = await parent.run({});

      expect(result.status).not.toBe("completed");
      expect(runChild).not.toHaveBeenCalled();
      expect(runSpy).not.toHaveBeenCalled();
      expect(result.errors[0]?.message).toContain("Child pipeline planned-child could not start");
      expect(result.errors[0]?.message).toContain("unknown step ids: missing");
    });

    it("plans a nested child once before execution", async () => {
      const childStep = createSteps();
      const work = childStep("work", { run: () => "done" });
      const child = definePipeline({
        id: "once-child",
        steps: [work],
        finalize: () => true,
      });
      const planSpy = vi.spyOn(child, "plan");
      const runSpy = vi.spyOn(child, "run");
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("stage", {
        pipeline: child,
        mapOptions: () => ({}),
      });
      const parent = definePipeline({
        id: "once-parent",
        steps: [stage],
        finalize: () => true,
      });

      const result = await parent.run({});

      expect(result.status).toBe("completed");
      expect(result.value).toBe(true);
      expect(planSpy).toHaveBeenCalledOnce();
      expect(runSpy).not.toHaveBeenCalled();
    });

    it("runs a public Pipeline child that lacks the compiled execute binding", async () => {
      const childStep = createSteps();
      const work = childStep("work", { run: () => "done" });
      const child = definePipeline({
        id: "spread-child",
        steps: [work],
        finalize: () => "child-ok" as const,
      });
      const publicChild = { ...child };
      const runSpy = vi.spyOn(publicChild, "run");
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("stage", {
        pipeline: publicChild,
        mapOptions: () => ({}),
      });
      const parent = definePipeline({
        id: "spread-parent",
        steps: [stage],
        finalize: (outputs) => outputs.stage,
      });

      const result = await parent.run({});

      expect(result.errors.map((error) => error.message)).toEqual([]);
      expect(result.status).toBe("completed");
      expect(result.value).toBe("child-ok");
      expect(runSpy).toHaveBeenCalledOnce();
    });

    it("uses public run on an Object.create wrapper that overrides run", async () => {
      const childStep = createSteps();
      const work = childStep("work", { run: () => "done" });
      const child = definePipeline({
        id: "proto-child",
        steps: [work],
        finalize: () => "child-ok" as const,
      });
      const runSpy = vi.fn(child.run.bind(child));
      const decorated = Object.create(child, {
        run: { configurable: true, enumerable: true, value: runSpy, writable: true },
      }) as typeof child;
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("stage", {
        pipeline: decorated,
        mapOptions: () => ({}),
      });
      const parent = definePipeline({
        id: "proto-parent",
        steps: [stage],
        finalize: (outputs) => outputs.stage,
      });

      const result = await parent.run({});

      expect(result.errors.map((error) => error.message)).toEqual([]);
      expect(result.status).toBe("completed");
      expect(result.value).toBe("child-ok");
      expect(runSpy).toHaveBeenCalledOnce();
    });

    it("does not invoke public run when a child plan is already invalid", async () => {
      const childStep = createSteps();
      const work = childStep("work", { run: () => "done" });
      const child = definePipeline({
        id: "invalid-spread-child",
        steps: [work],
        finalize: () => true,
      });
      const publicChild = { ...child };
      const runSpy = vi.spyOn(publicChild, "run");
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("stage", {
        pipeline: publicChild,
        mapOptions: () => ({ stepIds: ["missing" as never] }),
      });
      const parent = definePipeline({
        id: "invalid-spread-parent",
        steps: [stage],
        finalize: () => true,
      });

      const result = await parent.run({});

      expect(result.status).not.toBe("completed");
      expect(runSpy).not.toHaveBeenCalled();
      expect(result.errors[0]?.message).toContain("could not start");
      expect(result.errors[0]?.message).toContain("unknown step ids: missing");
    });

    it("emits child lifecycle traces when a public child plan is already invalid", async () => {
      const childStep = createSteps();
      const work = childStep("work", { run: () => "done" });
      const child = definePipeline({
        id: "invalid-trace-child",
        steps: [work],
        finalize: () => true,
      });
      const publicChild = { ...child };
      const runSpy = vi.spyOn(publicChild, "run");
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("stage", {
        pipeline: publicChild,
        mapOptions: () => ({ stepIds: ["missing" as never] }),
      });
      const parent = definePipeline({
        id: "invalid-trace-parent",
        steps: [stage],
        finalize: () => true,
      });
      const events: PipelineTraceEvent[] = [];
      const result = await parent.run({}, undefined, {
        ...defaultPipelineContext(),
        runId: "parent-run",
        tracing: { exporter: { export: (event) => void events.push(event) } },
      });

      expect(result.status).not.toBe("completed");
      expect(runSpy).not.toHaveBeenCalled();
      expect(
        events.find(
          (event) => event.name === "pipeline.started" && event.pipelineId === "invalid-trace-child"
        )
      ).toMatchObject({ parentRunId: "parent-run", attributes: { plan_ok: false } });
      expect(
        events.find(
          (event) =>
            event.name === "pipeline.completed" && event.pipelineId === "invalid-trace-child"
        )
      ).toMatchObject({ parentRunId: "parent-run" });
    });

    it("applies a child pipeline's declared target closure through mapOptions", async () => {
      const ran: string[] = [];
      const childStep = createSteps();
      const load = childStep("load", { run: () => (ran.push("load"), "loaded") });
      const publish = childStep("publish", {
        dependsOn: [load],
        run: ({ load }) => (ran.push("publish"), `${load}:published`),
      });
      const child = definePipeline({
        id: "targeted-child",
        steps: [load, publish],
        targets: [publish],
        finalize: (outputs) => outputs.publish,
      });
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("targeted-stage", {
        pipeline: child,
        mapOptions: () => ({ targets: ["publish"] as const }),
      });
      const parent = definePipeline({
        id: "targeted-parent",
        steps: [stage],
        finalize: (outputs) => outputs["targeted-stage"],
      });

      await expect(parent.runOrThrow({})).resolves.toBe("loaded:published");
      expect(ran).toEqual(["load", "publish"]);
    });

    it("keeps the interactive reporter active until the parent completes", async () => {
      const output = captureOutput();
      const reporter = createPipelineReporter({
        color: "never",
        log: console,
        mode: "interactive",
        output,
        refreshIntervalMs: 10_000,
        symbols: "ascii",
        terminal: { color: false, isTTY: true, unicode: false },
      });
      const childStep = createSteps();
      const inside = childStep("inside", { run: () => "child result" });
      const child = definePipeline({
        id: "reporter-child",
        steps: [inside],
        finalize: (outputs) => outputs.inside,
      });
      const parentStep = createSteps();
      const childStage = parentStep.fromPipeline("child-stage", {
        pipeline: child,
        mapOptions: () => ({}),
      });
      const afterChild = parentStep("after-child", {
        dependsOn: [childStage],
        run: () => "parent result",
      });
      const parent = definePipeline({
        id: "reporter-parent",
        steps: [childStage, afterChild],
        finalize: (outputs) => outputs["after-child"],
      });
      let renderedAfterChild = "";
      let renderedAfterParent = "";

      await parent.run({}, undefined, {
        cwd: "/tmp",
        hooks: [
          reporter.hooks,
          {
            onPipelineComplete: () => {
              renderedAfterParent = output.chunks.join("");
            },
            onStepComplete: ({ step }) => {
              if (step.id === "child-stage") {
                renderedAfterChild = output.chunks.join("");
              }
            },
          },
        ],
        log: reporter.log,
      });

      expect(renderedAfterChild).not.toContain("\u001B[?25h");
      expect(renderedAfterChild).not.toContain("Pipeline reporter-child: done");
      expect(renderedAfterParent).toContain("Pipeline reporter-parent: done");
      expect(renderedAfterParent.match(/\u001B\[\?25h/g)).toHaveLength(1);
    });

    it("does not enter child work when the parent signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const runChild = vi.fn();
      const childStep = createSteps();
      const inside = childStep("inside", { run: runChild });
      const child = definePipeline({
        id: "already-aborted-child",
        steps: [inside],
        finalize: () => true,
      });
      const parentStep = createSteps();
      const childStage = parentStep.fromPipeline("child-stage", {
        pipeline: child,
        mapOptions: () => ({}),
      });
      const parent = definePipeline({
        id: "already-aborted-parent",
        steps: [childStage],
        finalize: () => true,
      });

      const result = await parent.run({}, undefined, {
        cwd: "/tmp",
        log: console,
        signal: controller.signal,
      });

      expect(result.status).not.toBe("completed");
      expect(result.errors[0]).toMatchObject({
        code: "TUBELESS_RUN_CANCELLED",
        kind: "cancellation",
        message: expect.stringMatching(/operation was aborted/i),
        phase: "execution",
        stepId: "child-stage",
      });
      expect(runChild).not.toHaveBeenCalled();
    });

    it("passes later parent cancellation into in-flight child work", async () => {
      const controller = new AbortController();
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const sleep = vi.fn(
        (_durationMs: number, signal?: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          })
      );
      const childStep = createSteps();
      const wait = childStep("wait", {
        run: async (_inputs, context) => {
          expect(context.signal).toBe(controller.signal);
          markStarted?.();
          await context.sleep(1, context.signal);
        },
      });
      const child = definePipeline({ id: "abort-child", steps: [wait], finalize: () => true });
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("abort-stage", {
        pipeline: child,
        mapOptions: () => ({}),
      });
      const parent = definePipeline({ id: "abort-parent", steps: [stage], finalize: () => true });

      const resultPromise = parent.run({}, undefined, {
        cwd: "/tmp",
        log: console,
        signal: controller.signal,
        sleep,
      });
      await started;
      controller.abort(new Error("sleep interrupted"));
      const result = await resultPromise;

      expect(result.status).not.toBe("completed");
      expect(result.errors[0]?.message).toBe(
        "Child pipeline abort-child failed at wait: sleep interrupted"
      );
      expect(result.errors[0]).toMatchObject({
        code: "TUBELESS_RUN_CANCELLED",
        kind: "cancellation",
        phase: "execution",
        stepId: "abort-stage",
      });
      expect(sleep).toHaveBeenCalledWith(1, controller.signal);
    });
  });
});
