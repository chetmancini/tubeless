import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createSteps,
  definePipeline,
  requireOutputs,
  type PipelineDefinition,
} from "./pipeline.js";
import { standardSchema, thrownDefinitionErrors } from "./pipeline.test-support.js";

describe("pipeline defaults", () => {
  it("infers domain options and possible targets and outputs from just id and steps", async () => {
    const { step } = createSteps<{ text: string }>();
    const load = step("load", { run: (_, context) => context.options.text });
    const length = step("length", { dependsOn: [load], run: ({ load }) => load.length });
    const pipeline = definePipeline({ id: "minimal", steps: [load, length] });

    expectTypeOf(pipeline.targetIds).toEqualTypeOf<readonly ("load" | "length")[]>();
    expectTypeOf(pipeline.runOrThrow).parameter(0).toEqualTypeOf<{ text: string }>();
    expectTypeOf(pipeline.runOrThrow).returns.resolves.toEqualTypeOf<string | number | undefined>();
    expect(pipeline.targetIds).toEqual(["length"]);
    expect(Object.isFrozen(pipeline.targetIds)).toBe(true);
    expect(pipeline.plan({ targets: ["length"] }).steps.map(({ selected }) => selected)).toEqual([
      true,
      true,
    ]);
    await expect(pipeline.runOrThrow({ text: "hello" }, { targets: ["length"] })).resolves.toBe(5);
    // The graph determines the public target at runtime.
    expect(pipeline.plan({ targets: ["load"] }).errors[0]?.code).toBe(
      "TUBELESS_PLANNING_TARGET_UNDECLARED"
    );
  });

  it("uses topological execution order rather than declaration order", async () => {
    const { step } = createSteps();
    const first = step("first", { run: () => 7 });
    const dependent = step("dependent", { dependsOn: [first], run: () => "executed last" });
    const pipeline = definePipeline({ id: "reordered", steps: [dependent, first] });

    const result = await pipeline.run({});
    expect(result.steps.map(({ id }) => id)).toEqual(["first", "dependent"]);
    expect(result.value).toBe("executed last");
    expect(pipeline.targetIds).toEqual(["dependent"]);
    await expect(pipeline.runOrThrow({}, { targets: ["dependent"] })).resolves.toBe(
      "executed last"
    );
    await expect(pipeline.runOrThrow({}, { stepIds: ["first"] })).resolves.toBeUndefined();
    expectTypeOf(pipeline.runOrThrow).returns.resolves.toEqualTypeOf<string | number | undefined>();
  });

  it("uses the scheduler's stable ordering for multiple terminal steps", async () => {
    const { step } = createSteps();
    const source = step("source", { run: () => 1 });
    const sink = step("sink", { dependsOn: [source], run: () => "sink" });
    const independent = step("independent", { run: () => "independent" });

    const reordered = definePipeline({ id: "branches", steps: [sink, independent, source] });
    expect(reordered.targetIds).toEqual(["sink"]);
    const result = await reordered.run({});
    expect(result.steps.map(({ id }) => id)).toEqual(["independent", "source", "sink"]);
    expect(result.value).toBe("sink");

    const independentLast = definePipeline({ id: "tie", steps: [source, sink, independent] });
    expect(independentLast.targetIds).toEqual(["independent"]);
    await expect(independentLast.runOrThrow({})).resolves.toBe("independent");
  });

  it("includes optional inputs and failure gates when ordering the default step", async () => {
    const { step } = createSteps();
    const optional = step("optional", { run: () => 1 });
    const gate = step("gate", { run: () => 2 });
    const sink = step("sink", {
      optionalDependsOn: [optional],
      skipAfterFailureOf: [gate],
      run: () => "finished",
    });
    const pipeline = definePipeline({ id: "ordered-edges", steps: [sink, optional, gate] });

    expect(pipeline.targetIds).toEqual(["sink"]);
    const result = await pipeline.run({});
    expect(result.steps.map(({ id }) => id)).toEqual(["optional", "gate", "sink"]);
    expect(result.value).toBe("finished");
    const targeted = await pipeline.run({}, { targets: ["sink"] });
    expect(targeted.value).toBe("finished");
    expect(targeted.steps.find(({ id }) => id === "optional")?.status).toBe("skipped");
    expect(targeted.steps.find(({ id }) => id === "gate")?.status).toBe("completed");
  });

  it("validates required outputs against the execution-order target", async () => {
    const { step } = createSteps();
    const source = step("source", { run: () => 1 });
    const sink = step("sink", { dependsOn: [source], run: () => "sink" });
    const pipeline = definePipeline({
      id: "required-sink",
      steps: [sink, source],
      finalize: requireOutputs([sink], ({ sink }) => sink),
    });

    expect(pipeline.targetIds).toEqual(["sink"]);
    expectTypeOf(pipeline.runOrThrow).returns.resolves.toEqualTypeOf<string>();
    await expect(pipeline.runOrThrow({}, { targets: ["sink"] })).resolves.toBe("sink");
  });

  it("still runs all steps without selection controls", async () => {
    const { step } = createSteps();
    const unrelated = step("unrelated", { run: () => 1 });
    const last = step("last", { run: () => 2 });
    const pipeline = definePipeline({ id: "all", steps: [unrelated, last] });

    const result = await pipeline.run({});
    expect(result.steps.map(({ status }) => status)).toEqual(["completed", "completed"]);
    expect(result.value).toBe(2);
    expect(pipeline.plan({ targets: ["last"] }).steps[0]?.selected).toBe(false);
  });

  it("does not return an earlier output when the last output is absent", async () => {
    const { step } = createSteps();
    const first = step("first", { run: () => "earlier" });
    const last = step("last", { dryRun: "skip", run: () => 42 });
    const pipeline = definePipeline({ id: "absent", steps: [first, last], targets: [first, last] });

    for (const controls of [
      { dryRun: true },
      { stepIds: ["first"] },
      { targets: ["first"] },
    ] as const) {
      const result = await pipeline.run({}, controls);
      expect(result).toMatchObject({ status: "completed", finalized: true });
      expect(result.value).toBeUndefined();
    }
  });

  it("does not mistake an inherited property for a published output", async () => {
    const { step } = createSteps();
    const last = step("constructor", { dryRun: "skip", run: () => "own output" });
    const pipeline = definePipeline({ id: "own-slot", steps: [last] });

    await expect(pipeline.runOrThrow({}, { dryRun: true })).resolves.toBeUndefined();
    await expect(pipeline.runOrThrow({})).resolves.toBe("own output");
  });

  it("returns a published undefined or policy skip value", async () => {
    const { step } = createSteps();
    const empty = step("empty", { run: () => undefined });
    const skipped = step("skipped", {
      skip: () => ({ reason: "cached", value: 3 }),
      run: () => 9,
    });

    const result = await definePipeline({ id: "undefined", steps: [empty] }).run({});
    expect(result).toMatchObject({ finalized: true, status: "completed", value: undefined });
    await expect(definePipeline({ id: "cached", steps: [skipped] }).runOrThrow({})).resolves.toBe(
      3
    );
  });

  it("does not make failed runs successful", async () => {
    const { step } = createSteps();
    const fail = step("fail", {
      run: (): number => {
        throw new Error("failed");
      },
    });
    const pipeline = definePipeline({ id: "failure", steps: [fail] });

    const result = await pipeline.run({}, { continueOnError: true });
    expect(result.status).toBe("failed");
    expect(result.value).toBeUndefined();
    await expect(pipeline.runOrThrow({}, { continueOnError: true })).rejects.toThrow();
  });

  it("supports empty and widened step arrays", async () => {
    const empty = definePipeline({ id: "empty", steps: [] });
    expectTypeOf(empty.targetIds).toEqualTypeOf<readonly never[]>();
    expectTypeOf(empty.runOrThrow).returns.resolves.toEqualTypeOf<undefined>();
    expect(empty.targetIds).toEqual([]);
    await expect(empty.runOrThrow({})).resolves.toBeUndefined();

    const { step } = createSteps();
    const first = step("first", { run: () => "first" });
    const last = step("last", { run: () => 2 });
    const steps = [first, last];
    const pipeline = definePipeline({ id: "array", steps });
    expectTypeOf(pipeline.targetIds).toEqualTypeOf<readonly ("first" | "last")[]>();
    expectTypeOf(pipeline.runOrThrow).returns.resolves.toEqualTypeOf<string | number | undefined>();
    expect(pipeline.targetIds).toEqual(["last"]);
    await expect(pipeline.runOrThrow({}, { targets: ["last"] })).resolves.toBe(2);
  });

  it("snapshots the default target and output slot at definition time", async () => {
    const { step } = createSteps();
    const work = step("work", { run: () => 42 });
    const steps = [work];
    const pipeline = definePipeline({ id: "snapshot", steps });
    steps.length = 0;
    Reflect.set(work, "id", "renamed");

    expect(pipeline.targetIds).toEqual(["work"]);
    await expect(pipeline.runOrThrow({}, { targets: ["work"] })).resolves.toBe(42);
  });

  it("retains explicit empty targets and custom finalizers independently", async () => {
    const { step } = createSteps();
    const work = step("work", { run: () => 42 });
    const privatePipeline = definePipeline({ id: "private", steps: [work], targets: [] });
    expectTypeOf(privatePipeline.targetIds).toEqualTypeOf<readonly never[]>();
    expect(privatePipeline.targetIds).toEqual([]);
    await expect(privatePipeline.runOrThrow({})).resolves.toBe(42);

    const custom = definePipeline({ id: "custom", steps: [work], finalize: () => "custom" });
    expect(custom.targetIds).toEqual(["work"]);
    expectTypeOf(custom.runOrThrow).returns.resolves.toEqualTypeOf<string>();
    await expect(custom.runOrThrow({})).resolves.toBe("custom");
  });

  it("validates required outputs against the implicit target", () => {
    const { step } = createSteps();
    const first = step("first", { run: () => 1 });
    const last = step("last", { run: () => 2 });
    const definition = {
      id: "mismatch",
      steps: [first, last],
      finalize: requireOutputs([first], ({ first }) => first),
    };
    expect(thrownDefinitionErrors(() => definePipeline(definition))[0]?.code).toBe(
      "TUBELESS_DEFINITION_TARGET_FINALIZER_MISMATCH"
    );
    expect(definePipeline({ ...definition, targets: [] }).targetIds).toEqual([]);
  });

  it("validates and transforms the default result, including absent outputs", async () => {
    const { step } = createSteps();
    const work = step("work", { dryRun: "skip", run: () => "hello" });
    const resultSchema = standardSchema<string, number>((value) =>
      typeof value === "string"
        ? { value: value.length }
        : { issues: [{ message: "Expected text" }] }
    );
    const pipeline = definePipeline({ id: "schema", steps: [work], resultSchema });
    expectTypeOf(pipeline.runOrThrow).returns.resolves.toEqualTypeOf<number>();
    await expect(pipeline.runOrThrow({})).resolves.toBe(5);
    const absent = await pipeline.run({}, { dryRun: true });
    expect(absent.status).toBe("failed");
    expect(absent.errors[0]?.code).toBe("TUBELESS_FINAL_RESULT_VALIDATION_FAILED");
  });

  it("requires a compatible explicit result and supports reusable definitions", async () => {
    const { step } = createSteps();
    const work = step("work", { run: () => "hello" });
    const resultSchema = standardSchema<number, number>(() => ({ value: 5 }));
    // @ts-expect-error The default string output cannot satisfy a number schema.
    definePipeline({ id: "incompatible", steps: [work], resultSchema });
    // @ts-expect-error Explicit result types cannot misrepresent the default output.
    definePipeline<readonly [typeof work], number>({ id: "wrong-result", steps: [work] });

    const compatible = definePipeline({
      id: "mapped-schema",
      steps: [work],
      resultSchema,
      finalize: requireOutputs([work], ({ work }) => work.length),
    });
    await expect(compatible.runOrThrow({})).resolves.toBe(5);
    const definition: PipelineDefinition<readonly [typeof work]> = {
      id: "reusable",
      steps: [work],
    };
    await expect(definePipeline(definition).runOrThrow({})).resolves.toBe("hello");
    const explicit: PipelineDefinition<readonly [typeof work], number> = {
      id: "explicit-reusable",
      steps: [work],
      finalize: () => 5,
    };
    expectTypeOf(definePipeline(explicit).runOrThrow).returns.resolves.toEqualTypeOf<number>();
    await expect(definePipeline(explicit).runOrThrow({})).resolves.toBe(5);
    // @ts-expect-error An empty pipeline cannot produce a number without a finalizer.
    definePipeline({ id: "empty-schema", steps: [], resultSchema });
    // @ts-expect-error Reusable definitions also require a compatible finalizer.
    const invalid: PipelineDefinition<readonly [typeof work], number> = {
      id: "invalid",
      steps: [work],
    };
    void invalid;
  });
});
