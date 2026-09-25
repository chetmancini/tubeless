import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createSteps, definePipeline, type StandardSchemaV1 } from "tubeless";
import { createPipelineTestRuntime, overrideStep } from "tubeless/testing";
import { runOverrideExample } from "../../examples/step-output-overrides.js";

function numberSchema(validate?: () => void): StandardSchemaV1<string, number> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: async (value) => {
        validate?.();
        return typeof value === "string" && Number.isFinite(Number(value))
          ? { value: Number(value) }
          : { issues: [{ message: "Expected numeric text" }] };
      },
    },
  };
}

describe("typed step overrides", () => {
  it("runs the public recipe without loading upstream rows", async () => {
    const { run, logs } = await runOverrideExample();
    expect(run.value).toEqual({ count: 2, rows: ["alice", "bob"] });
    expect(run.steps.map(({ status }) => status)).toEqual(["skipped", "completed", "completed"]);
    expect(logs).toEqual([]);
  });
  it("publishes validated overrides without invoking normal, skip, or dry-run handlers", async () => {
    const { step } = createSteps();
    const run = vi.fn(() => "1");
    const skip = vi.fn(() => ({ reason: "cached", value: "2" }));
    const dryRun = vi.fn(() => "3");
    const validate = vi.fn();
    const load = step("load", { run, skip, dryRun, outputSchema: numberSchema(validate) });
    const double = step("double", { dependsOn: [load], run: ({ load }) => load * 2 });
    const pipeline = definePipeline({ id: "override", steps: [load, double], finalize: double });
    const test = createPipelineTestRuntime();
    const complete = vi.fn();
    const started = vi.fn();
    test.context.hooks = [
      ...(Array.isArray(test.context.hooks) ? test.context.hooks : [test.context.hooks!]),
      { onStepComplete: complete, onStepStart: started },
    ];
    const result = await test.run(
      pipeline,
      {},
      { dryRun: true, overrides: [overrideStep(load, "21")] }
    );
    expectTypeOf(result.value).toEqualTypeOf<number | undefined>();
    expect(result).toMatchObject({ status: "completed", value: 42, finalized: true });
    expect(result.steps.map(({ status }) => status)).toEqual(["completed", "completed"]);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]![0]).toMatchObject({
      outputSource: "override",
      id: "load",
      status: "completed",
      attemptId: expect.any(String),
    });
    expect(complete.mock.calls[1]![0].id).toBe("double");
    expect(complete.mock.calls[1]![0]).not.toHaveProperty("outputSource");
    expect(started.mock.calls[0]![0]).toMatchObject({
      outputSource: "override",
      status: "running",
    });
    expect(result.steps[0]).toMatchObject({ outputSource: "override" });
    expect(result.steps[1]).not.toHaveProperty("outputSource");
    expect(validate).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(skip).not.toHaveBeenCalled();
    expect(dryRun).not.toHaveBeenCalled();
    expect(await pipeline.runOrThrow()).toBe(4);
  });

  it("keeps the value tied to the step's pre-schema output type", () => {
    const { step } = createSteps();
    const text = step("text", { run: () => "real" });
    const numeric = step("numeric", { run: () => 1 });
    const transformed = step("transformed", { run: () => "1", outputSchema: numberSchema() });
    overrideStep(text, "fake");
    overrideStep(numeric, 2);
    overrideStep(transformed, "2");
    // @ts-expect-error A different output type must not widen the inferred step.
    overrideStep(text, 2);
    // @ts-expect-error Schema-backed overrides use schema input, not transformed output.
    overrideStep(transformed, 2);
    // @ts-expect-error Overrides accept resolved values, not promises.
    overrideStep(numeric, Promise.resolve(2));
    const pipeline = definePipeline({ id: "types", steps: [text] });
    // @ts-expect-error Production run controls do not expose overrides.
    void pipeline.run({}, { overrides: [overrideStep(text, "fake")] });
  });

  it("validates fresh default options for overridden run and runOrThrow calls", async () => {
    const inputs: unknown[] = [];
    const optionsSchema: StandardSchemaV1<{}, { limit: number }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => {
          inputs.push(value);
          return typeof value === "object" && value !== null
            ? { value: { limit: 10 } }
            : { issues: [{ message: "Expected options object" }] };
        },
      },
    };
    const { step } = createSteps(optionsSchema);
    const load = step("load", { run: vi.fn(() => 1) });
    const finish = step("finish", {
      dependsOn: [load],
      run: ({ load }, context) => load + context.options.limit,
    });
    const pipeline = definePipeline({ id: "default-options", steps: [load, finish] });
    const test = createPipelineTestRuntime();
    const controls = { overrides: [overrideStep(load, 2)] };
    // Exercise JavaScript callers; the test runtime's typed API requires options.
    await expect(test.run(pipeline, undefined as never, controls)).resolves.toMatchObject({
      status: "completed",
      value: 12,
    });
    await expect(test.runOrThrow(pipeline, undefined as never, controls)).resolves.toBe(12);
    expect(inputs).toEqual([{}, {}]);
    expect(inputs[0]).not.toBe(inputs[1]);
    expect(load.run).not.toHaveBeenCalled();
  });

  it("supports exact selection beyond a supplied intermediate without upstream I/O", async () => {
    const { step } = createSteps();
    const upstream = step("upstream", { run: vi.fn(() => "network") });
    const middle = step("middle", { dependsOn: [upstream], dryRun: "skip", run: () => 1 });
    const finish = step("finish", { dependsOn: [middle], run: ({ middle }) => middle + 1 });
    const pipeline = definePipeline({
      id: "selection",
      steps: [upstream, middle, finish],
      finalize: finish,
    });
    const test = createPipelineTestRuntime();
    const result = await test.run(
      pipeline,
      {},
      {
        stepIds: ["middle", "finish"],
        dryRun: true,
        overrides: [overrideStep(middle, 9)],
      }
    );
    expect(result.value).toBe(10);
    expect(result.steps.map(({ status }) => status)).toEqual(["skipped", "completed", "completed"]);
    expect(upstream.run).not.toHaveBeenCalled();
    const filtered = await test.run(
      pipeline,
      {},
      { stepIds: ["finish"], overrides: [overrideStep(middle, 9)] }
    );
    expect(filtered.steps).toMatchObject([
      { id: "upstream", status: "skipped", reason: "filtered" },
      { id: "middle", status: "skipped", reason: "filtered" },
      { id: "finish", status: "skipped", reason: "unmet-dependency" },
    ]);
    expect(filtered.steps.every((report) => report.outputSource === undefined)).toBe(true);
    expect(filtered.finalized).toBe(false);
    await test.run(pipeline, {}, { targets: ["finish"], overrides: [overrideStep(middle, 9)] });
    expect(upstream.run).toHaveBeenCalledOnce();
  });

  it("rejects foreign, same-named, duplicate, and forged overrides before execution", async () => {
    const { step } = createSteps();
    const local = step("load", { run: vi.fn(() => 1) });
    const foreign = step("load", { run: () => "foreign" });
    const pipeline = definePipeline({ id: "membership", steps: [local] });
    const test = createPipelineTestRuntime();
    await expect(
      test.run(pipeline, {}, { overrides: [overrideStep(foreign, "fake")] })
    ).rejects.toThrow("does not belong");
    await expect(
      test.run(pipeline, {}, { overrides: [overrideStep(local, 1), overrideStep(local, 2)] })
    ).rejects.toThrow("Duplicate override");
    await expect(test.run(pipeline, {}, { overrides: [{} as never] })).rejects.toThrow(
      "created by overrideStep"
    );
    expect(local.run).not.toHaveBeenCalled();
    expect(test.statuses).toEqual([]);
  });

  it("preserves validation failures, dependency blocking, and runOrThrow errors", async () => {
    const { step } = createSteps();
    const load = step("load", { run: () => "1", outputSchema: numberSchema() });
    const dependent = step("dependent", { dependsOn: [load], run: vi.fn(() => 2) });
    const independent = step("independent", { run: () => 3 });
    const pipeline = definePipeline({ id: "invalid", steps: [load, dependent, independent] });
    const test = createPipelineTestRuntime();
    const controls = { continueOnError: true, overrides: [overrideStep(load, "invalid")] };
    const result = await test.run(pipeline, {}, controls);
    expect(result.status).toBe("failed");
    expect(result.steps[0]).toMatchObject({ status: "failed", outputSource: "override" });
    expect(test.statuses.find((event) => event.status === "failed")).toMatchObject({
      outputSource: "override",
    });
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED",
      kind: "validation",
      stepId: "load",
    });
    expect(result.steps.map(({ status }) => status)).toEqual(["failed", "skipped", "completed"]);
    expect(dependent.run).not.toHaveBeenCalled();
    await expect(test.runOrThrow(pipeline, {}, controls)).rejects.toMatchObject({
      result: { status: "failed" },
    });
  });

  it("honors fail-fast while allowing an explicit override past failed prerequisites in continue mode", async () => {
    const { step } = createSteps();
    const fail = step("fail", {
      run: () => {
        throw new Error("upstream failed");
      },
    });
    const guarded = step("guarded", { skipAfterFailureOf: [fail], run: vi.fn(() => 1) });
    const required = step("required", { dependsOn: [fail], run: vi.fn(() => 2) });
    const pipeline = definePipeline({
      id: "failure-gates",
      steps: [fail, guarded, required],
      targets: [],
      finalize: guarded,
    });
    const test = createPipelineTestRuntime();
    const overrides = [overrideStep(guarded, 10), overrideStep(required, 20)];
    const stopped = await test.run(pipeline, {}, { overrides });
    expect(stopped.steps.map(({ status }) => status)).toEqual(["failed", "skipped", "skipped"]);
    const continued = await test.run(pipeline, {}, { overrides, continueOnError: true });
    expect(continued.steps.map(({ status }) => status)).toEqual([
      "failed",
      "completed",
      "completed",
    ]);
    expect(continued).toMatchObject({ status: "failed", finalized: true, value: 10 });
    expect(guarded.run).not.toHaveBeenCalled();
    expect(required.run).not.toHaveBeenCalled();
  });

  it("publishes explicit undefined and function values without invoking them", async () => {
    const { step } = createSteps();
    const absent = step("absent", { run: (): undefined => undefined });
    const callback = vi.fn(() => "value");
    const fn = step("fn", { optionalDependsOn: [absent], run: () => callback });
    const pipeline = definePipeline({
      id: "values",
      steps: [absent, fn],
      targets: [],
      finalize: absent,
    });
    const test = createPipelineTestRuntime();
    const result = await test.run(
      pipeline,
      {},
      { overrides: [overrideStep(absent, undefined), overrideStep(fn, callback)] }
    );
    expect(result).toMatchObject({ finalized: true, value: undefined });
    expect(
      result.steps.every(
        ({ status, outputSource }) => status === "completed" && outputSource === "override"
      )
    ).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it("never launches overridden children, fan-out mappings, or remote adapters", async () => {
    const { step, fromPipeline, forEachPipeline, fromRemote } = createSteps();
    const childStep = step("child", { run: vi.fn(() => "real") });
    const child = definePipeline({ id: "child", steps: [childStep], finalize: childStep });
    const mapOptions = vi.fn(() => ({}));
    const single = fromPipeline("single", { pipeline: child, mapOptions });
    const items = vi.fn(() => [1, 2]);
    const many = forEachPipeline("many", {
      pipeline: child,
      items,
      key: (item) => String(item),
      mapOptions,
    });
    const execute = vi.fn(async () => "1");
    const mapInput = vi.fn(() => ({}));
    const remote = fromRemote("remote", {
      adapter: { engine: "test", invoke: execute },
      mapInput,
      outputSchema: numberSchema(),
    });
    const pipeline = definePipeline({
      id: "wrappers",
      steps: [single, many, remote],
      finalize: remote,
    });
    const result = await createPipelineTestRuntime().run(
      pipeline,
      {},
      {
        maxConcurrency: 3,
        overrides: [
          overrideStep(single, "single fake"),
          overrideStep(many, ["fan-out fake"]),
          overrideStep(remote, "9"),
        ],
      }
    );
    expect(result.value).toBe(9);
    for (const spy of [childStep.run, mapOptions, items, execute, mapInput])
      expect(spy).not.toHaveBeenCalled();
    expect(
      result.steps.every(
        ({ status, outputSource }) => status === "completed" && outputSource === "override"
      )
    ).toBe(true);
  });

  it("respects cancellation before dispatch and during asynchronous output validation", async () => {
    const { step } = createSteps();
    const test = createPipelineTestRuntime();
    const validate = vi.fn(() => test.abort());
    const load = step("load", { run: vi.fn(() => "1"), outputSchema: numberSchema(validate) });
    const pipeline = definePipeline({ id: "cancel", steps: [load] });
    const controls = { overrides: [overrideStep(load, "2")] };
    const result = await test.run(pipeline, {}, controls);
    expect(result.steps[0]).toMatchObject({ status: "cancelled", outputSource: "override" });
    expect(test.statuses.find((event) => event.status === "cancelled")).toMatchObject({
      outputSource: "override",
    });
    expect(result.status).toBe("cancelled");
    const unstarted = await test.run(pipeline, {}, controls);
    expect(unstarted.steps[0]).not.toHaveProperty("outputSource");
    expect(validate).toHaveBeenCalledOnce();
    expect(load.run).not.toHaveBeenCalled();
  });

  it("isolates simultaneous override runs and leaves ordinary child runs untouched", async () => {
    const { step, fromPipeline } = createSteps();
    const value = step("value", { run: () => 1 });
    const child = definePipeline({ id: "child", steps: [value], finalize: value });
    const wrapper = fromPipeline("wrapper", { pipeline: child });
    const parent = definePipeline({ id: "parent", steps: [value, wrapper], finalize: wrapper });
    const test = createPipelineTestRuntime();
    expect(
      await Promise.all(
        [2, 3].map((n) => test.runOrThrow(child, {}, { overrides: [overrideStep(value, n)] }))
      )
    ).toEqual([2, 3]);
    expect(await test.runOrThrow(parent, {}, { overrides: [overrideStep(value, 9)] })).toBe(1);
    expect(await child.runOrThrow()).toBe(1);
  });
});
