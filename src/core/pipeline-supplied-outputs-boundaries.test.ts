import { describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline, type PipelineRunControls } from "./pipeline.js";
import { standardSchema } from "./pipeline.test-support.js";
import { defer } from "./child-pipeline.test-support.js";
import { createPipelineTestRuntime, overrideStep } from "../testing/testing.js";

describe("supplied output admission and scope", () => {
  it.each([
    null,
    {},
    [],
    [["load", 1]],
    new Map([["missing", 1]]),
    new Map([["load", Promise.resolve(1)]]),
    new Map([["load", { then() {} }]]),
    new Map([["load", Object.assign(() => 1, { then() {} })]]),
    {
      get() {},
      has() {},
      [Symbol.iterator]() {
        throw new Error("private iterator failure");
      },
    },
    new Map([
      [
        "load",
        {
          get then() {
            throw new Error("private getter failure");
          },
        },
      ],
    ]),
  ])("rejects invalid maps or values before callbacks %#", async (suppliedOutputs) => {
    const run = vi.fn(() => 1);
    const validate = vi.fn(() => ({ value: {} }));
    const optionsSchema = standardSchema<{}, {}>(validate);
    const load = createSteps(optionsSchema).step("load", { run });
    const pipeline = definePipeline({ id: "invalid-supply", steps: [load] });
    const encode = vi.fn(() => new Uint8Array());
    const write = vi.fn();
    const controls = { suppliedOutputs, outputObserver: { encode, write } } as PipelineRunControls<
      "load",
      "load"
    >;
    expect(pipeline.plan(controls)).toMatchObject({
      ok: false,
      steps: [],
      errors: [
        { code: "TUBELESS_RUN_OUTPUT_RECOVERY_INVALID", phase: "planning", kind: "validation" },
      ],
    });
    const result = await pipeline.run({}, controls);
    expect(result).toMatchObject({
      status: "failed",
      errors: [{ code: "TUBELESS_RUN_OUTPUT_RECOVERY_INVALID" }],
    });
    expect(JSON.stringify(result.errors)).not.toContain("private");
    await expect(pipeline.runOrThrow({}, controls)).rejects.toMatchObject({
      result: { status: "failed" },
    });
    for (const callback of [run, validate, encode, write]) expect(callback).not.toHaveBeenCalled();
  });

  it("combines admission and planning diagnostics before any execution", async () => {
    const load = createSteps().step("load", { run: vi.fn(() => 1) });
    const pipeline = definePipeline({ id: "combined-recovery-errors", steps: [load] });
    const controls = {
      suppliedOutputs: new Map([["load", Promise.resolve(9)]]),
      outputObserver: {},
      maxConcurrency: 0,
    } as unknown as PipelineRunControls<"load", "load">;
    const plan = pipeline.plan(controls);
    expect(plan).toMatchObject({ ok: false, steps: [] });
    expect(plan.errors).toHaveLength(3);
    expect(plan.errors.map(({ code }) => code).sort()).toEqual([
      "TUBELESS_RUN_CONCURRENCY_INVALID",
      "TUBELESS_RUN_OUTPUT_RECOVERY_INVALID",
      "TUBELESS_RUN_OUTPUT_RECOVERY_INVALID",
    ]);
    expect(await pipeline.run({}, controls)).toMatchObject({
      status: "failed",
      steps: [],
      errors: plan.errors,
    });
    expect(load.run).not.toHaveBeenCalled();
  });

  it.each(["exact", "target"] as const)(
    "rejects supplies outside %s selection before I/O",
    async (mode) => {
      const { step } = createSteps();
      const load = step("load", { run: vi.fn(() => 1) });
      const finish = step("finish", { run: vi.fn(() => 2) });
      const pipeline = definePipeline({
        id: "unselected-supply",
        steps: [load, finish],
        targets: [finish],
      });
      const controls = {
        ...(mode === "exact" ? { stepIds: ["finish"] as const } : { targets: ["finish"] as const }),
        suppliedOutputs: new Map<"load", unknown>([["load", 9]]),
      };
      expect(pipeline.plan(controls).ok).toBe(false);
      expect(await pipeline.run({}, controls)).toMatchObject({
        status: "failed",
        errors: [{ code: "TUBELESS_RUN_OUTPUT_RECOVERY_INVALID" }],
      });
      expect(load.run).not.toHaveBeenCalled();
      expect(finish.run).not.toHaveBeenCalled();
    }
  );

  it("snapshots entries before asynchronous options validation and isolates simultaneous runs", async () => {
    const ready = defer();
    const release = defer();
    const { step } = createSteps(
      standardSchema<{}, {}>(async () => {
        ready.resolve();
        await release.promise;
        return { value: {} };
      })
    );
    const load = step("load", { run: vi.fn(() => 1) });
    const pipeline = definePipeline({ id: "snapshot-supply", steps: [load] });
    const definition = JSON.stringify(pipeline.definition);
    const suppliedOutputs = new Map<"load", unknown>([["load", 9]]);
    const first = pipeline.runOrThrow({}, { suppliedOutputs });
    await ready.promise;
    suppliedOutputs.set("load", 10);
    const second = pipeline.runOrThrow({}, { suppliedOutputs });
    suppliedOutputs.clear();
    release.resolve();
    expect(await Promise.all([first, second])).toEqual([9, 10]);
    expect(await pipeline.runOrThrow()).toBe(1);
    expect(JSON.stringify(pipeline.definition)).toBe(definition);
    expect(load.run).toHaveBeenCalledOnce();
  });

  it("rejects test overrides with supply even when the supplied map is empty", async () => {
    const { step } = createSteps();
    const load = step("load", { run: vi.fn(() => 1) });
    const pipeline = definePipeline({ id: "override-supply-conflict", steps: [load] });
    const test = createPipelineTestRuntime();
    expect(
      await test.run(
        pipeline,
        {},
        { overrides: [overrideStep(load, 2)], suppliedOutputs: new Map() }
      )
    ).toMatchObject({
      status: "failed",
      errors: [{ code: "TUBELESS_RUN_OUTPUT_RECOVERY_INVALID" }],
    });
    expect(
      await test.run(pipeline, {}, { overrides: [], suppliedOutputs: new Map([["load", 3]]) })
    ).toMatchObject({ status: "completed", value: 3 });
    expect(load.run).not.toHaveBeenCalled();
  });

  it("bypasses opaque child, fan-out, iteration, and remote execution", async () => {
    const { step, fromPipeline, forEachPipeline, iteratePipeline, fromRemote } = createSteps();
    const leaf = step("leaf", { run: vi.fn(() => "real") });
    const child = definePipeline({ id: "child", steps: [leaf] });
    const mapOptions = vi.fn(() => ({}));
    const single = fromPipeline("single", { pipeline: child, mapOptions });
    const items = vi.fn(() => [1, 2]);
    const many = forEachPipeline("many", { pipeline: child, items, key: String, mapOptions });
    const initialState = vi.fn(() => 0);
    const loop = iteratePipeline("loop", {
      pipeline: child,
      maxIterations: 1,
      initialState,
      mapOptions,
      transition: (result) => ({ kind: "finish", result }),
    });
    const invoke = vi.fn(async () => "real");
    const mapInput = vi.fn(() => ({}));
    const remote = fromRemote("remote", {
      adapter: { engine: "test", invoke },
      mapInput,
      outputSchema: standardSchema<string, string>((value) => ({ value: String(value) })),
    });
    const pipeline = definePipeline({
      id: "supplied-wrappers",
      steps: [single, many, loop, remote],
    });
    const suppliedOutputs = new Map<"single" | "many" | "loop" | "remote", unknown>([
      ["single", "saved"],
      ["many", ["saved"]],
      ["loop", "saved"],
      ["remote", "saved"],
    ]);
    const result = await pipeline.run({}, { suppliedOutputs, maxConcurrency: 4 });
    expect(result).toMatchObject({ status: "completed", value: "saved" });
    expect(result.steps.every((report) => report.outputSource === "supplied")).toBe(true);
    for (const callback of [leaf.run, mapOptions, items, initialState, invoke, mapInput])
      expect(callback).not.toHaveBeenCalled();
  });

  it("does not inherit parent supplies into children sharing a declared step", async () => {
    const { step, fromPipeline } = createSteps();
    const value = step("value", { run: vi.fn(() => 1) });
    const child = definePipeline({ id: "child", steps: [value] });
    const wrapper = fromPipeline("wrapper", { pipeline: child });
    const parent = definePipeline({ id: "parent", steps: [value, wrapper] });
    const result = await parent.run({}, { suppliedOutputs: new Map([["value", 9]]) });
    expect(result).toMatchObject({ status: "completed", value: 1 });
    expect(result.steps[0]).toMatchObject({ outputSource: "supplied" });
    expect(result.steps[1]).not.toHaveProperty("outputSource");
    expect(value.run).toHaveBeenCalledOnce();
  });

  it("rejects static and dynamic child recovery controls instead of dropping them", async () => {
    const { step, fromPipeline, forEachPipeline, iteratePipeline } = createSteps();
    const leaf = step("leaf", { run: vi.fn(() => 1) });
    const child = definePipeline({ id: "child", steps: [leaf] });
    const controls = { suppliedOutputs: new Map([["leaf", 9]]) } as never;
    expect(() => fromPipeline("static-child", { pipeline: child, controls })).toThrow(
      "direct pipeline run"
    );
    expect(() =>
      forEachPipeline("static-many", {
        pipeline: child,
        controls,
        items: () => [1],
        key: String,
        mapOptions: () => ({}),
      })
    ).toThrow("direct pipeline run");
    expect(() =>
      iteratePipeline("static-loop", {
        pipeline: child,
        controls,
        maxIterations: 1,
        initialState: () => 0,
        mapOptions: () => ({}),
        transition: (result) => ({ kind: "finish", result }),
      })
    ).toThrow("direct pipeline run");
    const single = fromPipeline("dynamic-child", { pipeline: child, controls: () => controls });
    const many = forEachPipeline("dynamic-many", {
      pipeline: child,
      controls: () => controls,
      items: () => [1],
      key: String,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({ id: "invalid-child-recovery", steps: [single, many] });
    const result = await parent.run({}, { continueOnError: true });
    expect(result.steps.map((report) => report.status)).toEqual(["failed", "failed"]);
    expect(leaf.run).not.toHaveBeenCalled();
  });
});
