import { describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "./pipeline.js";
import { standardSchema } from "./pipeline.test-support.js";
import { defer } from "./child-pipeline.test-support.js";
import { createPipelineTestRuntime } from "../testing/testing.js";

const numericText = standardSchema<string, number>((value) =>
  typeof value === "string" && Number.isFinite(Number(value))
    ? { value: Number(value) }
    : { issues: [{ message: "Expected numeric text" }] }
);

describe("supplied step outputs", () => {
  it.each([false, true])(
    "validates raw values and bypasses execution paths (dry run: %s)",
    async (dryRun) => {
      const { step } = createSteps();
      const run = vi.fn(() => "1");
      const skip = vi.fn(() => ({ reason: "done", value: "2" }));
      const preview = vi.fn(() => "3");
      const get = vi.fn(() => undefined);
      const set = vi.fn();
      const encode = vi.fn(() => new Uint8Array());
      const write = vi.fn();
      const load = step("load", {
        run,
        skip,
        dryRun: preview,
        outputSchema: numericText,
        cache: { version: "v1", store: { get, set } },
      });
      const double = step("double", { dependsOn: [load], run: ({ load }) => load * 2 });
      const pipeline = definePipeline({ id: "supplied-paths", steps: [load, double] });
      const test = createPipelineTestRuntime();
      const result = await test.run(
        pipeline,
        {},
        {
          dryRun,
          suppliedOutputs: new Map([["load", "21"]]),
          outputObserver: { encode, write },
        }
      );
      expect(result).toMatchObject({ status: "completed", value: 42 });
      expect(result.steps[0]).toMatchObject({ status: "completed", outputSource: "supplied" });
      expect(result.steps[1]).not.toHaveProperty("outputSource");
      expect(
        test.statuses.filter((event) => event.step.id === "load" && event.status !== "planned")
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "running", outputSource: "supplied" }),
          expect.objectContaining({ status: "completed", outputSource: "supplied" }),
        ])
      );
      for (const spy of [run, skip, preview, get, set]) expect(spy).not.toHaveBeenCalled();
      expect(encode).toHaveBeenCalledTimes(dryRun ? 0 : 1);
      expect(write).toHaveBeenCalledTimes(dryRun ? 0 : 1);
      if (!dryRun) expect(write.mock.calls[0]).toMatchObject([{ stepId: "double" }, {}]);
    }
  );

  it.each([false, true])(
    "plans and runs an exact selection past a supplied intermediate (dry run: %s)",
    async (dryRun) => {
      const { step } = createSteps();
      const upstream = step("upstream", { run: vi.fn(() => "network") });
      const middle = step("middle", { dependsOn: [upstream], dryRun: "skip", run: () => 1 });
      const finish = step("finish", { dependsOn: [middle], run: ({ middle }) => middle + 1 });
      const pipeline = definePipeline({
        id: "supplied-selection",
        steps: [upstream, middle, finish],
      });
      const controls = {
        dryRun,
        stepIds: ["middle", "finish"] as const,
        suppliedOutputs: new Map<"middle", unknown>([["middle", 9]]),
      };
      expect(pipeline.plan(controls).steps).toMatchObject([
        { id: "upstream", selected: false, skipReason: "filtered" },
        { id: "middle", selected: true, skipReason: undefined },
        { id: "finish", selected: true, skipReason: undefined },
      ]);
      expect(await pipeline.runOrThrow({}, controls)).toBe(10);
      expect(upstream.run).not.toHaveBeenCalled();
      await pipeline.run({}, { targets: ["finish"], suppliedOutputs: controls.suppliedOutputs });
      expect(upstream.run).toHaveBeenCalledOnce();
      await pipeline.run({}, { suppliedOutputs: controls.suppliedOutputs });
      expect(upstream.run).toHaveBeenCalledTimes(2);
    }
  );

  it("validates domain options on fully supplied invocations and keeps plan synchronous", async () => {
    const validate = vi.fn((value: unknown) =>
      value && typeof value === "object" && "valid" in value && value.valid === true
        ? { value: { valid: true } }
        : { issues: [{ message: "Invalid options" }] }
    );
    const { step } = createSteps(standardSchema<{ valid: boolean }, { valid: boolean }>(validate));
    const outputValidate = vi.fn((value: unknown) => ({ value: String(value) }));
    const load = step("load", {
      run: vi.fn(() => "real"),
      outputSchema: standardSchema<string, string>(outputValidate),
    });
    const pipeline = definePipeline({ id: "supplied-options", steps: [load] });
    const controls = { suppliedOutputs: new Map<"load", unknown>([["load", "saved"]]) };
    expect(pipeline.plan(controls).ok).toBe(true);
    expect(validate).not.toHaveBeenCalled();
    expect(outputValidate).not.toHaveBeenCalled();
    expect(await pipeline.run({ valid: false }, controls)).toMatchObject({
      status: "failed",
      errors: [{ code: "TUBELESS_OPTIONS_VALIDATION_FAILED" }],
    });
    expect(outputValidate).not.toHaveBeenCalled();
    expect(await pipeline.runOrThrow({ valid: true }, controls)).toBe("saved");
    expect(validate).toHaveBeenCalledTimes(2);
    expect(outputValidate).toHaveBeenCalledOnce();
    expect(load.run).not.toHaveBeenCalled();
  });

  it("fails supplied validation without publishing or observing and preserves independent work", async () => {
    const { step } = createSteps();
    const load = step("load", { run: () => "1", outputSchema: numericText });
    const blocked = step("blocked", { dependsOn: [load], run: vi.fn(() => 2) });
    const independent = step("independent", { run: () => 3 });
    const pipeline = definePipeline({
      id: "supplied-invalid",
      steps: [load, blocked, independent],
    });
    const controls = {
      continueOnError: true,
      suppliedOutputs: new Map<"load", unknown>([["load", 21]]),
    };
    const result = await pipeline.run({}, controls);
    expect(result).toMatchObject({
      status: "failed",
      errors: [{ code: "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED", kind: "validation" }],
    });
    expect(result.steps).toMatchObject([
      { status: "failed", outputSource: "supplied" },
      { status: "skipped", reason: "unmet-dependency" },
      { status: "completed" },
    ]);
    expect(blocked.run).not.toHaveBeenCalled();
    await expect(pipeline.runOrThrow({}, controls)).rejects.toMatchObject({
      result: { status: "failed" },
    });
  });

  it("honors fail-fast but lets supplied committed work pass failed gates in continue mode", async () => {
    const { step } = createSteps();
    const fail = step("fail", {
      run: () => {
        throw new Error("upstream failure");
      },
    });
    const guarded = step("guarded", { skipAfterFailureOf: [fail], run: vi.fn(() => 1) });
    const required = step("required", { dependsOn: [fail], run: vi.fn(() => 2) });
    const pipeline = definePipeline({
      id: "supplied-gates",
      steps: [fail, guarded, required],
      finalize: required,
    });
    const suppliedOutputs = new Map<"guarded" | "required", unknown>([
      ["guarded", 10],
      ["required", 20],
    ]);
    const stopped = await pipeline.run({}, { suppliedOutputs });
    expect(stopped.steps).toMatchObject([
      { status: "failed" },
      { status: "skipped", reason: "fail-fast" },
      { status: "skipped", reason: "fail-fast" },
    ]);
    expect(stopped.steps.slice(1).every((step) => !step.outputSource)).toBe(true);
    const continued = await pipeline.run({}, { suppliedOutputs, continueOnError: true });
    expect(continued).toMatchObject({ status: "failed", finalized: true, value: 20 });
    expect(continued.steps.slice(1)).toMatchObject([
      { status: "completed", outputSource: "supplied" },
      { status: "completed", outputSource: "supplied" },
    ]);
    expect(guarded.run).not.toHaveBeenCalled();
    expect(required.run).not.toHaveBeenCalled();
  });

  it("distinguishes supplied undefined from absence and preserves function values", async () => {
    const { step } = createSteps();
    const absent = step("absent", { run: vi.fn((): undefined => undefined) });
    const callback = vi.fn(() => "value");
    const fn = step("fn", { dependsOn: [absent], run: () => callback });
    const pipeline = definePipeline({ id: "supplied-values", steps: [absent, fn] });
    expect(
      await pipeline.runOrThrow(
        {},
        {
          suppliedOutputs: new Map<"absent" | "fn", unknown>([
            ["absent", undefined],
            ["fn", callback],
          ]),
        }
      )
    ).toBe(callback);
    expect(absent.run).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    await pipeline.run();
    expect(absent.run).toHaveBeenCalledOnce();
  });

  it("waits for supplied validation, drains cancellation, and never publishes unstarted supplies", async () => {
    const { step } = createSteps();
    const started = defer();
    const release = defer();
    const controller = new AbortController();
    const validate = vi.fn(async (value: unknown) => {
      started.resolve();
      await release.promise;
      return { value };
    });
    const first = step("first", {
      run: vi.fn(() => 1),
      outputSchema: standardSchema<number, unknown>(validate),
    });
    const second = step("second", { dependsOn: [first], run: vi.fn(() => 2) });
    const pipeline = definePipeline({ id: "supplied-cancel", steps: [first, second] });
    const controls = {
      suppliedOutputs: new Map<"first" | "second", unknown>([
        ["first", 9],
        ["second", 10],
      ]),
    };
    let settled = false;
    const running = pipeline.run({}, controls, { signal: controller.signal }).then((run) => {
      settled = true;
      return run;
    });
    await started.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    expect(await running).toMatchObject({
      status: "cancelled",
      steps: [{ status: "cancelled", outputSource: "supplied" }, { status: "cancelled" }],
    });
    const unstarted = await pipeline.run({}, controls, { signal: controller.signal });
    expect(unstarted.steps.every((report) => !report.outputSource)).toBe(true);
    expect(validate).toHaveBeenCalledOnce();
    expect(first.run).not.toHaveBeenCalled();
    expect(second.run).not.toHaveBeenCalled();
  });
});
