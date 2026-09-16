import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createSteps, definePipeline, PipelineExecutionError, type Step } from "./pipeline.js";
import { standardSchema } from "./pipeline.test-support.js";

describe("definePipeline runtime policies", () => {
  it("policy-skips a step with a yellow skip report and unlocks dependents", async () => {
    interface Options {
      enableWrite: boolean;
    }
    const step = createSteps<Options>();
    let writeRan = false;
    const build = step("build", { run: () => "built" });
    const write = step.skippable("write", {
      dependsOn: [build],
      skip: (_inputs, context) =>
        context.options.enableWrite
          ? false
          : { reason: "write disabled by config", value: "skipped-write" },
      run: () => {
        writeRan = true;
        return "written";
      },
    });
    const after = step("after", {
      dependsOn: [write],
      run: (inputs) => `after:${inputs.write}`,
    });
    const pipeline = definePipeline({
      id: "policy-skip",
      steps: [build, write, after],
      finalize: (outputs) => outputs.after,
    });
    const skipEvents: unknown[] = [];

    const result = await pipeline.run({ enableWrite: false }, undefined, {
      cwd: "/tmp",
      hooks: {
        onStepSkip: (event) => {
          skipEvents.push({
            message: event.message,
            reason: event.reason,
            stepId: event.step.id,
          });
        },
      },
      log: console,
    });

    expect(writeRan).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.value).toBe("after:skipped-write");
    expect(
      result.steps.map((step) => [
        step.id,
        step.status,
        step.status === "skipped" ? step.reason : undefined,
        step.status === "skipped" ? step.message : undefined,
      ])
    ).toEqual([
      ["build", "completed", undefined, undefined],
      ["write", "skipped", "policy", "write disabled by config"],
      ["after", "completed", undefined, undefined],
    ]);
    expect(skipEvents).toEqual([
      {
        message: "write disabled by config",
        reason: "policy",
        stepId: "write",
      },
    ]);
  });

  it("policy-skips with a bare string publish undefined and still unlock dependents", async () => {
    const step = createSteps();
    let writeRan = false;
    const write = step.skippable("write", {
      skip: () => "write disabled",
      run: () => {
        writeRan = true;
        return "written";
      },
    });
    const after = step("after", {
      dependsOn: [write],
      run: (inputs) => {
        expectTypeOf(inputs.write).toEqualTypeOf<string | undefined>();
        return { saw: inputs.write };
      },
    });
    const pipeline = definePipeline({
      id: "policy-skip-bare-string",
      steps: [write, after],
      finalize: (outputs) => outputs.after,
    });

    const result = await pipeline.run({}, undefined, { cwd: "/tmp", log: console });

    expect(writeRan).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ saw: undefined });
    expect(
      result.steps.map((step) => [
        step.id,
        step.status,
        step.status === "skipped" ? step.reason : undefined,
        step.status === "skipped" ? step.message : undefined,
      ])
    ).toEqual([
      ["write", "skipped", "policy", "write disabled"],
      ["after", "completed", undefined, undefined],
    ]);
  });

  it("records a skip-predicate throw as a failed PipelineRun instead of rejecting", async () => {
    const step = createSteps();
    let ran = false;
    const skipEvents: string[] = [];
    const failEvents: string[] = [];
    const gate = step.skippable("gate", {
      skip: () => {
        throw new Error("skip exploded");
      },
      run: () => {
        ran = true;
        return "ran";
      },
    });
    const after = step("after", {
      dependsOn: [gate],
      run: () => "after",
    });
    const pipeline = definePipeline({
      id: "skip-throw",
      steps: [gate, after],
      finalize: (outputs) => outputs.after,
    });
    let completedRun: unknown;
    const result = await pipeline.run({}, undefined, {
      cwd: "/tmp",
      hooks: {
        onPipelineComplete: (event) => {
          completedRun = event;
        },
        onStepFail: ({ step }) => {
          failEvents.push(step.id);
        },
        onStepSkip: ({ step }) => {
          skipEvents.push(step.id);
        },
      },
      log: console,
    });

    expect(result.status).toBe("failed");
    expect(result.finalized).toBe(false);
    expect(ran).toBe(false);
    expect(
      result.steps.map((report) => [
        report.id,
        report.status,
        report.status === "skipped" ? report.reason : undefined,
      ])
    ).toEqual([
      ["gate", "failed", undefined],
      ["after", "skipped", "fail-fast"],
    ]);
    expect(result.steps[0]).toMatchObject({
      error: {
        code: "TUBELESS_STEP_FAILED",
        kind: "step",
        message: "skip exploded",
        phase: "execution",
        stepId: "gate",
      },
      status: "failed",
    });
    expect(failEvents).toEqual(["gate"]);
    expect(skipEvents).not.toContain("gate");
    expect(completedRun).toBe(result);
  });

  it("records a skip-predicate abort as a cancelled PipelineRun and runOrThrow wraps it", async () => {
    vi.useFakeTimers();
    const step = createSteps();
    let ran = false;
    const gate = step.skippable("gate", {
      skip: async (_inputs, context): Promise<false> => {
        await context.sleep(100, context.signal);
        return false;
      },
      run: () => {
        ran = true;
        return "ran";
      },
    });
    const pipeline = definePipeline({
      id: "skip-abort",
      steps: [gate],
      finalize: (outputs) => outputs.gate,
    });
    const context = { cwd: "/tmp", log: console };

    try {
      const runController = new AbortController();
      const runPromise = pipeline.run({}, undefined, { ...context, signal: runController.signal });
      await vi.advanceTimersByTimeAsync(50);
      runController.abort("stop");
      const result = await runPromise;

      expect(result.status).toBe("cancelled");
      expect(ran).toBe(false);
      expect(result.steps[0]).toMatchObject({
        error: {
          code: "TUBELESS_RUN_CANCELLED",
          kind: "cancellation",
          stepId: "gate",
        },
        status: "cancelled",
      });

      const throwController = new AbortController();
      const throwPromise = pipeline.runOrThrow({}, undefined, {
        ...context,
        signal: throwController.signal,
      });
      await vi.advanceTimersByTimeAsync(50);
      throwController.abort("stop");
      let thrown: unknown;
      try {
        await throwPromise;
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PipelineExecutionError);
      expect((thrown as PipelineExecutionError).result.status).toBe("cancelled");
      expect((thrown as PipelineExecutionError).result).toMatchObject({
        status: "cancelled",
        steps: [
          {
            error: {
              code: "TUBELESS_RUN_CANCELLED",
              kind: "cancellation",
              stepId: "gate",
            },
            status: "cancelled",
          },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { name: "normal execution", skip: false, dryRun: false, continueOnError: false },
    { name: "a policy skip", skip: true, dryRun: false, continueOnError: false },
    { name: "dry-run execution", skip: false, dryRun: true, continueOnError: false },
    { name: "continueOnError", skip: false, dryRun: false, continueOnError: true },
    {
      name: "a dry-run policy skip with continueOnError",
      skip: true,
      dryRun: true,
      continueOnError: true,
    },
  ])(
    "cancels before starting work when an async skip resolves after abort during $name",
    async (mode) => {
      for (const runOrThrow of [false, true]) {
        let enterSkip!: () => void;
        const skipEntered = new Promise<void>((resolve) => {
          enterSkip = resolve;
        });
        let resolveSkip!: (decision: false | { reason: string; value: string }) => void;
        const skipDecision = new Promise<false | { reason: string; value: string }>((resolve) => {
          resolveSkip = resolve;
        });
        const runHandler = vi.fn(() => "ran");
        const dryRunHandler = vi.fn(() => "preview");
        const laterHandler = vi.fn(() => "later");
        const filteredHandler = vi.fn(() => "filtered");
        const finalize = vi.fn(() => "finalized");
        const statuses: Array<[string, string]> = [];
        const step = createSteps();
        const gate = step.skippable("gate", {
          skip: () => {
            enterSkip();
            return skipDecision;
          },
          dryRun: dryRunHandler,
          run: runHandler,
        });
        const later = step("later", { run: laterHandler });
        const filtered = step("filtered", { run: filteredHandler });
        const pipeline = definePipeline({
          id: "skip-resolves-after-abort",
          steps: [gate, later, filtered],
          finalize,
        });
        const controller = new AbortController();
        const controls = {
          continueOnError: mode.continueOnError,
          dryRun: mode.dryRun,
          stepIds: ["gate", "later"] as const,
        };
        const context = {
          cwd: "/tmp",
          hooks: {
            onStepStatus: (event: { step: { id: string }; status: string }) => {
              statuses.push([event.step.id, event.status]);
            },
          },
          log: console,
          signal: controller.signal,
        };
        const runPromise = runOrThrow
          ? pipeline.runOrThrow({}, controls, context).then(
              () => {
                throw new Error("expected PipelineExecutionError");
              },
              (error: unknown) => {
                expect(error).toBeInstanceOf(PipelineExecutionError);
                return (error as PipelineExecutionError).result;
              }
            )
          : pipeline.run({}, controls, context);
        await skipEntered;
        controller.abort("stop");
        resolveSkip(mode.skip ? { reason: "already done", value: "cached" } : false);
        const result = await runPromise;

        expect(runHandler).not.toHaveBeenCalled();
        expect(dryRunHandler).not.toHaveBeenCalled();
        expect(laterHandler).not.toHaveBeenCalled();
        expect(filteredHandler).not.toHaveBeenCalled();
        expect(finalize).not.toHaveBeenCalled();
        expect(result.status).toBe("cancelled");
        expect(result.finalized).toBe(false);
        expect(result.steps).toMatchObject([
          {
            id: "gate",
            status: "cancelled",
            error: { code: "TUBELESS_RUN_CANCELLED", phase: "execution", stepId: "gate" },
          },
          {
            id: "later",
            status: "cancelled",
            error: { code: "TUBELESS_RUN_CANCELLED", phase: "execution", stepId: "later" },
          },
          { id: "filtered", status: "skipped", reason: "filtered" },
        ]);
        for (const report of result.steps) {
          expect(report).not.toHaveProperty("attemptId");
          expect(report).not.toHaveProperty("startedAtMs");
        }
        expect(statuses).toEqual([
          ["gate", "planned"],
          ["later", "planned"],
          ["filtered", "planned"],
          ["gate", "cancelled"],
          ["later", "cancelled"],
          ["filtered", "skipped"],
        ]);
      }
    }
  );

  it("continues independent later work when a skip predicate throws with continueOnError", async () => {
    const step = createSteps();
    let laterRan = false;
    const gate = step.skippable("gate", {
      skip: () => {
        throw new Error("skip exploded");
      },
      run: () => "ran",
    });
    const later = step("later", {
      run: () => {
        laterRan = true;
        return "later";
      },
    });
    const pipeline = definePipeline({
      id: "skip-throw-continue",
      steps: [gate, later],
      finalize: (outputs) => outputs,
    });

    const result = await pipeline.run({}, { continueOnError: true }, { cwd: "/tmp", log: console });

    expect(result.status).toBe("failed");
    expect(laterRan).toBe(true);
    expect(result.steps.map((report) => [report.id, report.status])).toEqual([
      ["gate", "failed"],
      ["later", "completed"],
    ]);
  });

  it("records an invalid policy-skip value with the live-run output-validation taxonomy", async () => {
    const rejectedOutput = standardSchema<string, string>(() => ({
      issues: [{ message: "Not publishable", path: ["slug"] }],
    }));
    const step = createSteps();
    const publish = step.skippable("publish", {
      outputSchema: rejectedOutput,
      skip: () => ({ reason: "preview only", value: "draft" }),
      run: () => "live",
    });
    const after = step("after", {
      dependsOn: [publish],
      run: () => "after",
    });
    const pipeline = definePipeline({
      id: "invalid-skip-output",
      steps: [publish, after],
      finalize: () => undefined,
    });

    const result = await pipeline.run({});

    expect(result.status).toBe("failed");
    expect(result.finalized).toBe(false);
    expect(result.steps[0]).toMatchObject({
      error: {
        code: "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED",
        issues: [{ message: "Not publishable", path: ["slug"] }],
        kind: "validation",
        phase: "execution",
        stepId: "publish",
      },
      status: "failed",
    });
    expect(
      result.steps.map((report) => [
        report.id,
        report.status,
        report.status === "skipped" ? report.reason : undefined,
      ])
    ).toEqual([
      ["publish", "failed", undefined],
      ["after", "skipped", "fail-fast"],
    ]);
  });

  it("types skippable steps as TOut | undefined for dependents", () => {
    const step = createSteps();

    const plain = step("plain", { run: () => "ok" as const });
    expectTypeOf(plain).toEqualTypeOf<Step<"plain", "ok", {}>>();

    const withSkip = step.skippable("with-skip", {
      skip: () => "disabled",
      run: () => "ok" as const,
    });
    expectTypeOf(withSkip).toEqualTypeOf<Step<"with-skip", "ok" | undefined, {}>>();

    const dependent = step("dependent", {
      dependsOn: [withSkip],
      run: (inputs) => {
        expectTypeOf(inputs["with-skip"]).toEqualTypeOf<"ok" | undefined>();
        return inputs["with-skip"] ?? "fallback";
      },
    });
    expectTypeOf(dependent).toEqualTypeOf<Step<"dependent", "ok" | "fallback", {}>>();

    // Config-gated: `skip: predicate | undefined` stays explicit and widens.
    const enableSkip = false as boolean;
    const gated = step.skippable("gated-skip", {
      skip: enableSkip ? () => "disabled" : undefined,
      run: () => "ok" as const,
    });
    expectTypeOf(gated).toEqualTypeOf<Step<"gated-skip", "ok" | undefined, {}>>();

    const explicitUndefined = step.skippable("explicit-undefined-skip", {
      skip: undefined,
      run: () => "ok" as const,
    });
    expectTypeOf(explicitUndefined).toEqualTypeOf<
      Step<"explicit-undefined-skip", "ok" | undefined, {}>
    >();

    step("skip-requires-skippable", {
      // @ts-expect-error Policy skip belongs on step.skippable.
      skip: () => "disabled",
      run: () => "ok" as const,
    });

    const reusableSkippingDefinition = {
      skip: () => "disabled",
      run: () => "ok" as const,
    };
    // @ts-expect-error Reusable definitions cannot bypass step.skippable.
    step("reusable-skip-requires-skippable", reusableSkippingDefinition);
  });
});
