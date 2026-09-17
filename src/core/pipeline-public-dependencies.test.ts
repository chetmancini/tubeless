import { describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "./pipeline.js";
import { PIPELINE_FINALIZE_STEP_ID } from "./pipeline-step-metadata.js";
import {
  inspectDependencyInputs,
  makePipeline,
  type TestOptions,
} from "./pipeline.test-support.js";

describe("definePipeline dependencies and dry runs", () => {
  it("skips dependent steps after a failed dependency with continueOnError", async () => {
    const result = await makePipeline("test").run(
      {
        failStep: "build",
      },
      {
        continueOnError: true,
      }
    );
    expect(result.status).not.toBe("completed");
    expect(result.finalized).toBe(true);
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["build", "failed"],
      ["write", "skipped"],
    ]);
    expect(result.value).toEqual([]);
  });

  it("throws from runOrThrow when a best-effort run contains errors", async () => {
    await expect(
      makePipeline("test").runOrThrow({ failStep: "build" }, { continueOnError: true })
    ).rejects.toThrow("Pipeline test failed");
  });

  it("tags finalize failures with a sentinel step id", async () => {
    const result = await makePipeline("test").run({ failFinalize: true });
    expect(result.status).not.toBe("completed");
    expect(result.finalized).toBe(false);
    expect(result.errors[0]).toMatchObject({
      message: "finalize failed",
      stepId: PIPELINE_FINALIZE_STEP_ID,
    });
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["build", "completed"],
      ["write", "completed"],
    ]);
  });

  it("still throws from runOrThrow when finalize fails while continuing on error", async () => {
    await expect(
      makePipeline("test").runOrThrow(
        {
          failStep: "build",
          failFinalize: true,
        },
        {
          continueOnError: true,
        }
      )
    ).rejects.toThrow("Pipeline test failed");
  });

  it("optionalDependsOn passes the output through when the dependency ran", async () => {
    const { step } = createSteps();
    const a = step("a", { run: () => "a-value" });
    const b = step("b", {
      optionalDependsOn: [a],
      run: (inputs) => inputs.a ?? "fallback",
    });
    const pipeline = definePipeline({
      id: "optional",
      steps: [a, b],
      finalize: (outputs) => outputs.b ?? "",
    });
    const result = await pipeline.run({});
    expect(result.value).toBe("a-value");
  });

  it("optionalDependsOn does not auto-skip when the dependency was filtered out", async () => {
    const { step } = createSteps();
    const a = step("a", { run: () => "a-value" });
    const b = step("b", {
      optionalDependsOn: [a],
      run: (inputs) => inputs.a ?? "fallback",
    });
    const pipeline = definePipeline({
      id: "optional",
      steps: [a, b],
      finalize: (outputs) => outputs.b ?? "",
    });
    const result = await pipeline.run({}, { stepIds: ["b"] });
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["a", "skipped"],
      ["b", "completed"],
    ]);
    expect(result.value).toBe("fallback");
  });

  it.each([
    { name: "primitive", value: 42 },
    { name: "object", value: { marker: true } },
    { name: "undefined", value: undefined },
  ])("preserves required __proto__ $name output as an own data property", async ({ value }) => {
    const { step } = createSteps();
    const upstream = step("__proto__", { run: () => value });
    const inspect = step("inspect", {
      dependsOn: [upstream],
      run: (inputs) => inspectDependencyInputs(inputs, "__proto__"),
    });
    const pipeline = definePipeline({
      id: "required-proto",
      steps: [upstream, inspect],
      finalize: (outputs) => outputs.inspect,
    });

    const result = await pipeline.run({});
    expect(result.status).toBe("completed");
    expect(result.value?.hasOwn).toBe(true);
    expect(result.value?.value).toBe(value);
    expect(result.value?.proto).toBe(Object.prototype);
  });

  it.each(["source", "constructor", "toString"] as const)(
    "preserves required %s dependency values as own data properties",
    async (id) => {
      const objectValue = { marker: id };
      const { step } = createSteps();
      const upstream = step(id, { run: () => objectValue });
      const inspect = step("inspect", {
        dependsOn: [upstream],
        run: (inputs) => inspectDependencyInputs(inputs, id),
      });
      const pipeline = definePipeline({
        id: `required-${id}`,
        steps: [upstream, inspect],
        finalize: (outputs) => outputs.inspect,
      });

      const result = await pipeline.run({});
      expect(result.status).toBe("completed");
      expect(result.value?.hasOwn).toBe(true);
      expect(result.value?.value).toBe(objectValue);
      expect(result.value?.proto).toBe(Object.prototype);
    }
  );

  it("keeps present optional special-key values, including published undefined", async () => {
    const { step } = createSteps();
    const proto = step("__proto__", { run: () => undefined });
    const ctor = step("constructor", { run: () => "ctor-value" });
    const inspect = step("inspect", {
      optionalDependsOn: [proto, ctor],
      run: (inputs) => ({
        proto: inspectDependencyInputs(inputs, "__proto__"),
        ctor: inspectDependencyInputs(inputs, "constructor"),
      }),
    });
    const pipeline = definePipeline({
      id: "optional-present-special",
      steps: [proto, ctor, inspect],
      finalize: (outputs) => outputs.inspect,
    });

    const result = await pipeline.run({});
    expect(result.status).toBe("completed");
    expect(result.value?.proto).toEqual({
      hasOwn: true,
      proto: Object.prototype,
      value: undefined,
    });
    expect(result.value?.ctor).toEqual({
      hasOwn: true,
      proto: Object.prototype,
      value: "ctor-value",
    });
  });

  it("omits absent optional dependencies, including filtered special-key producers", async () => {
    const { step } = createSteps();
    const proto = step("__proto__", { run: () => 1 });
    const ordinary = step("hint", { run: () => "hint" });
    const inspect = step("inspect", {
      optionalDependsOn: [proto, ordinary],
      run: (inputs) => ({
        proto: inspectDependencyInputs(inputs, "__proto__"),
        hint: inspectDependencyInputs(inputs, "hint"),
        keys: Object.keys(inputs),
      }),
    });
    const pipeline = definePipeline({
      id: "optional-absent-special",
      steps: [proto, ordinary, inspect],
      finalize: (outputs) => outputs.inspect,
    });

    const result = await pipeline.run({}, { stepIds: ["inspect"] });
    expect(result.status).toBe("completed");
    expect(result.steps.map((report) => [report.id, report.status])).toEqual([
      ["__proto__", "skipped"],
      ["hint", "skipped"],
      ["inspect", "completed"],
    ]);
    expect(result.value?.proto.hasOwn).toBe(false);
    expect(result.value?.hint.hasOwn).toBe(false);
    expect(result.value?.keys).toEqual([]);
    expect(result.value?.proto.proto).toBe(Object.prototype);
  });

  it("feeds skippable predicates the same own-property-safe inputs", async () => {
    const objectValue = { marker: "skip-input" };
    const { step } = createSteps();
    const upstream = step("__proto__", { run: () => objectValue });
    let skipSnapshot: ReturnType<typeof inspectDependencyInputs> | undefined;
    const gated = step("gated", {
      dependsOn: [upstream],
      skip: (inputs) => {
        skipSnapshot = inspectDependencyInputs(inputs, "__proto__");
        return false;
      },
      run: (inputs) => inspectDependencyInputs(inputs, "__proto__"),
    });
    const pipeline = definePipeline({
      id: "skippable-special-inputs",
      steps: [upstream, gated],
      finalize: (outputs) => outputs.gated,
    });

    const result = await pipeline.run({});
    expect(result.status).toBe("completed");
    expect(skipSnapshot).toEqual({
      hasOwn: true,
      proto: Object.prototype,
      value: objectValue,
    });
    expect(result.value).toEqual(skipSnapshot);
    expect(skipSnapshot?.value).toBe(objectValue);
    expect(result.value?.value).toBe(objectValue);
  });

  it("skipAfterFailureOf skips a step when the referenced step failed, even without a data dependency", async () => {
    const { step } = createSteps<TestOptions>();
    const a = step("a", {
      run: (_inputs, context) => {
        if (context.options.failStep === "a") {
          throw new Error("a failed");
        }
        return "a-value";
      },
    });
    const b = step("b", {
      skipAfterFailureOf: [a],
      run: () => "b-value",
    });
    const pipeline = definePipeline({
      id: "skip-after-failure",
      steps: [a, b],
      finalize: (outputs) => outputs,
    });

    const result = await pipeline.run({ failStep: "a" }, { continueOnError: true });
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["a", "failed"],
      ["b", "skipped"],
    ]);
  });

  it("skipAfterFailureOf skips a step when the referenced step was cancelled", async () => {
    const { step } = createSteps();
    const cancelled = step("cancelled", {
      run: async (_inputs, context) => {
        const localController = new AbortController();
        localController.abort("local cancellation");
        await context.sleep(1, localController.signal);
      },
    });
    const publish = step("publish", {
      skipAfterFailureOf: [cancelled],
      run: () => "published",
    });
    const pipeline = definePipeline({
      id: "skip-after-cancellation",
      steps: [cancelled, publish],
      finalize: (outputs) => outputs,
    });

    const result = await pipeline.run({}, { continueOnError: true });

    expect(result.steps.map((report) => [report.id, report.status])).toEqual([
      ["cancelled", "cancelled"],
      ["publish", "skipped"],
    ]);
    expect(result.steps[1]).toMatchObject({
      dependencyId: "cancelled",
      reason: "failed-dependency",
      status: "skipped",
    });
  });

  it('dryRun: "skip" prevents the normal handler from running', async () => {
    const { step } = createSteps();
    const writeRan = vi.fn();
    const write = step("write", {
      description: "Persist output",
      dryRun: "skip",
      run: () => {
        writeRan();
        return "written";
      },
    });
    const pipeline = definePipeline({
      id: "effect-dry-run",
      steps: [write],
      finalize: (outputs) => outputs.write,
    });

    const plan = pipeline.plan({ dryRun: true });
    const result = await pipeline.run({}, { dryRun: true });

    expect(plan.steps[0]).toMatchObject({ dryRun: "skip", id: "write" });
    expect(writeRan).not.toHaveBeenCalled();
    expect(result.steps[0]).toMatchObject({ id: "write", reason: "dry-run", status: "skipped" });
  });

  it("uses a custom dry-run handler in place of run and publishes its typed output", async () => {
    const { step } = createSteps<{ source: string }>();
    const runWrite = vi.fn(() => ({ id: "live" }));
    const prepare = step("prepare", {
      run: (_inputs, context) => context.options.source.trim(),
    });
    const write = step("write", {
      dependsOn: [prepare],
      dryRun: ({ prepare: value }, context) => {
        expect(context.dryRun).toBe(true);
        return { id: `preview:${value}` };
      },
      run: runWrite,
    });
    const consume = step("consume", {
      dependsOn: [write],
      run: ({ write: result }) => result.id,
    });
    const pipeline = definePipeline({
      id: "custom-dry-run",
      steps: [prepare, write, consume],
      finalize: (outputs) => outputs.consume,
    });

    const plan = pipeline.plan({ dryRun: true });
    const result = await pipeline.runOrThrow({ source: " artifact " }, { dryRun: true });

    expect(plan.steps.map(({ dryRun: policy }) => policy)).toEqual(["run", "custom", "run"]);
    expect(runWrite).not.toHaveBeenCalled();
    expect(result).toBe("preview:artifact");

    await expect(pipeline.runOrThrow({ source: "artifact" })).resolves.toBe("live");
    expect(runWrite).toHaveBeenCalledOnce();
  });
});
