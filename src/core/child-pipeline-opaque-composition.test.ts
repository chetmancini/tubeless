import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { STEP_NESTED_PIPELINE } from "./pipeline-step-metadata.js";
import {
  createSteps,
  definePipeline,
  type PipelineExecutionContext,
  type PipelineStepProgress,
  type Step,
} from "./pipeline.js";

describe("opaque child adapter: composition", () => {
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
    const { step: childStep } = createSteps<ChildOptions>();
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

    const { step: parentStep, fromPipeline: parentFromPipeline } = createSteps<ParentOptions>();
    const prepare = parentStep("prepare", { run: () => ({ records: 3 }) });
    const optionalHint = parentStep("optional-hint", { run: () => "hint" as const });
    const rawChild = parentFromPipeline("raw-child", {
      pipeline: child,
      mapOptions: (_inputs, context) => ({ input: context.options.source, recordCount: 1 }),
    });
    expectTypeOf(rawChild).toEqualTypeOf<Step<"raw-child", ChildResult, ParentOptions>>();

    const policySkippedChild = parentFromPipeline("policy-skipped-child", {
      pipeline: child,
      skip: () => "child not requested",
      mapOptions: (_inputs, context) => ({
        input: context.options.source,
        recordCount: 1,
      }),
    });
    expectTypeOf(policySkippedChild).toEqualTypeOf<
      Step<"policy-skipped-child", ChildResult | undefined, ParentOptions>
    >();

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
    const reusableSkippingChild = parentFromPipeline(
      "reusable-skipping-child",
      reusableSkippingChildDefinition
    );
    expectTypeOf(reusableSkippingChild).toEqualTypeOf<
      Step<"reusable-skipping-child", ChildResult | undefined, ParentOptions>
    >();

    const mappedChild = parentFromPipeline("mapped-child", {
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

    const skippedChild = parentFromPipeline("skipped-child", {
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
    const gatedSkipChild = parentFromPipeline("gated-skip-child", {
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

    const skippedMappedChild = parentFromPipeline("skipped-mapped-child", {
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
    parentFromPipeline("invalid-skip-value-shape", {
      pipeline: child,
      // @ts-expect-error skip value must be mapped TOut, not raw child result.
      skip: () => ({ reason: "wrong shape", value: { written: 0 } }),
      mapOptions: (_inputs, context) => ({
        input: context.options.source,
        recordCount: 1,
      }),
      mapResult: (value) => ({ count: value.written, ran: false as const }),
    });

    parentFromPipeline("invalid-child-options", {
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
    expect(progress).toContainEqual(
      expect.objectContaining({
        completed: 0,
        total: 2,
        message: "typed-child/load: half",
      })
    );
    expect(progress.at(-1)).toMatchObject({
      completed: 2,
      total: 2,
      message: "typed-child/write: complete",
    });
  });

  it("does not bridge empty child progress as visible parent progress", async () => {
    let releaseWork!: () => void;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const { step: childStep } = createSteps();
    const work = childStep("work", {
      run: async (_inputs, context) => {
        context.reportProgress({ completed: 3, total: 10, message: "batch" });
        await workGate;
        return "done";
      },
    });
    const child = definePipeline({
      id: "empty-progress-child",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });
    const { fromPipeline: parentFromPipeline } = createSteps();
    const stage = parentFromPipeline("stage", {
      pipeline: child,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({
      id: "empty-progress-parent",
      steps: [stage],
      finalize: (outputs) => outputs.stage,
    });
    const bridged: string[] = [];
    const runPromise = parent.run({}, undefined, {
      cwd: "/tmp",
      hooks: {
        onStepProgress: ({ progress, step }) => {
          if (step.id !== "stage" || !progress.message) return;
          bridged.push(progress.message);
        },
      },
      log: console,
    });
    await vi.waitFor(() => {
      expect(bridged.filter((message) => message.includes("batch"))).toHaveLength(1);
    });
    // Hold the child pending across the old 250ms observation window so a late
    // empty snapshot would still be recorded before we release the gate.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(bridged.some((message) => message.includes("0 completed"))).toBe(false);
    releaseWork();
    const result = await runPromise;

    expect(result.status).toBe("completed");
    expect(bridged.filter((message) => message.includes("batch"))).toHaveLength(1);
    expect(bridged.some((message) => message.includes("0 completed"))).toBe(false);
  });

  it("policy-skips fromPipeline with mapResult using the parent-facing skip value", async () => {
    interface ChildOptions {
      n: number;
    }
    const { step: childStep } = createSteps<ChildOptions>();
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

    const { step: parentStep, fromPipeline: parentFromPipeline } = createSteps();
    let mapResultCalls = 0;
    const stage = parentFromPipeline("stage", {
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
    const { step: childStep } = createSteps();
    const inside = childStep("inside", { run: () => "done" });
    const child = definePipeline({ id: "opaque-child", steps: [inside], finalize: () => true });
    const { fromPipeline: parentFromPipeline } = createSteps();
    const childStage = parentFromPipeline("child-stage", {
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

  it("snapshots nested-pipeline metadata when the parent is defined", () => {
    const { step: childStep } = createSteps();
    const inside = childStep("inside", { run: () => "done" });
    const child = definePipeline({
      id: "metadata-child",
      steps: [inside],
      finalize: () => true,
    });
    const { fromPipeline: parentFromPipeline } = createSteps();
    const childStage = parentFromPipeline("child-stage", {
      pipeline: child,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({
      id: "metadata-parent",
      steps: [childStage],
      finalize: () => true,
    });

    const metadata = childStage[STEP_NESTED_PIPELINE]!;
    Reflect.set(metadata, "pipelineId", "mutated-child");
    Reflect.set(metadata, "mode", "for-each");
    Reflect.set(metadata, "stepIds", ["mutated-step"]);

    expect(parent.plan().steps[0]?.nestedPipeline).toEqual({
      identity: child.definition.identity,
      mode: "single",
      pipelineId: "metadata-child",
      stepIds: ["inside"],
    });
  });

  it("applies parent dry-run last and lets the child skip side effects", async () => {
    const sideEffect = vi.fn();
    const observedDryRuns: boolean[] = [];
    const { step: childStep } = createSteps();
    const write = childStep("write", { dryRun: "skip", run: sideEffect });
    const inspect = childStep("inspect", {
      run: (_inputs, context) => observedDryRuns.push(context.dryRun),
    });
    const child = definePipeline({
      id: "dry-child",
      steps: [write, inspect],
      finalize: () => "dry-result",
    });
    const { fromPipeline: parentFromPipeline } = createSteps();
    const stage = parentFromPipeline("dry-stage", {
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

    const { step: childStep } = createSteps<{ label: string } & { read(): string }>();
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
    const { fromPipeline: parentFromPipeline } = createSteps();
    const stage = parentFromPipeline("accessor-stage", {
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
    const { step: childStep } = createSteps<{ label: string }>();
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
    const { fromPipeline: parentFromPipeline } = createSteps();
    const stage = parentFromPipeline("frozen-stage", {
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
});
