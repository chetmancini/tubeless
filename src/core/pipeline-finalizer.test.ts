import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createSteps,
  definePipeline,
  requireOutputs,
  type PipelineDefinition,
  type PipelineResult,
} from "./pipeline.js";
import { PIPELINE_FINALIZE_STEP_ID } from "./pipeline-step-metadata.js";
import { standardSchema, thrownDefinitionErrors } from "./pipeline.test-support.js";

describe("pipeline finalizers", () => {
  it("infers the selected step's exact output and preserves pipeline identity and inputs", async () => {
    const { step } = createSteps<{ text: string }>();
    const load = step("load", { run: (_inputs, context) => context.options.text });
    const count = step("count", { dependsOn: [load], run: async ({ load }) => load.length });
    const pipeline = definePipeline({ id: "counted", steps: [count, load], finalize: count });

    expectTypeOf<PipelineResult<typeof pipeline>>().toEqualTypeOf<number>();
    expectTypeOf(pipeline.id).toEqualTypeOf<"counted">();
    expectTypeOf(pipeline.runOrThrow).parameter(0).toEqualTypeOf<{ text: string }>();
    await expect(pipeline.runOrThrow({ text: "hello" })).resolves.toBe(5);
    const run = await pipeline.run({ text: "hi" });
    if (run.finalized) expectTypeOf(run.value).toEqualTypeOf<number>();
    const wrapped = definePipeline({
      id: "counted",
      steps: [count, load],
      finalize: requireOutputs([count], ({ count }) => count),
    });
    expect(pipeline.definition).toEqual(wrapped.definition);
  });

  it("uses the validated step output and transforms the final result", async () => {
    const { step } = createSteps();
    const parsed = step("parsed", {
      run: () => "42",
      outputSchema: standardSchema<string, number>((value) => ({ value: Number(value) })),
    });
    const plain = definePipeline({ id: "parsed", steps: [parsed], finalize: parsed });
    expectTypeOf<PipelineResult<typeof plain>>().toEqualTypeOf<number>();
    await expect(plain.runOrThrow({})).resolves.toBe(42);
    const transformed = definePipeline({
      id: "transformed",
      steps: [parsed],
      finalize: parsed,
      resultSchema: standardSchema<number, { total: number }>((value) => ({
        value: { total: Number(value) },
      })),
    });
    expectTypeOf<PipelineResult<typeof transformed>>().toEqualTypeOf<{ total: number }>();
    await expect(transformed.runOrThrow({})).resolves.toEqual({ total: 42 });
  });

  it("preserves undefined and policy-skip output types", async () => {
    const { step } = createSteps();
    const empty = step("empty", { run: () => undefined });
    const skipped = step("skipped", { skip: () => "nothing to do", run: () => 1 });
    const cached = step("cached", { skip: () => ({ reason: "cached", value: 2 }), run: () => 1 });
    const emptyPipeline = definePipeline({ id: "empty-output", steps: [empty], finalize: empty });
    const skippedPipeline = definePipeline({
      id: "skipped-output",
      steps: [skipped],
      finalize: skipped,
    });
    const cachedPipeline = definePipeline({
      id: "cached-output",
      steps: [cached],
      finalize: cached,
    });
    expectTypeOf<PipelineResult<typeof emptyPipeline>>().toEqualTypeOf<undefined>();
    expectTypeOf<PipelineResult<typeof skippedPipeline>>().toEqualTypeOf<number | undefined>();
    expectTypeOf<PipelineResult<typeof cachedPipeline>>().toEqualTypeOf<number>();
    await expect(emptyPipeline.run({})).resolves.toMatchObject({
      status: "completed",
      finalized: true,
      value: undefined,
    });
    await expect(skippedPipeline.runOrThrow({})).resolves.toBeUndefined();
    await expect(cachedPipeline.runOrThrow({})).resolves.toBe(2);
  });

  it("fails finalization for structurally missing outputs and snapshots the selected step", async () => {
    const { step } = createSteps();
    const load = step("load", { run: () => "input" });
    const write = step("write", { dependsOn: [load], dryRun: "skip", run: () => 42 });
    const pipeline = definePipeline({ id: "required", steps: [load, write], finalize: write });
    Reflect.set(write, "id", "renamed");
    for (const controls of [{ dryRun: true }, { stepIds: ["load"] }] as const) {
      const run = await pipeline.run({}, controls);
      expect(run).toMatchObject({ status: "failed", finalized: false });
      expect(run.errors[0]).toMatchObject({
        message: "Required pipeline outputs missing: write",
        stepId: PIPELINE_FINALIZE_STEP_ID,
      });
      await expect(pipeline.runOrThrow({}, controls)).rejects.toThrow();
    }
    await expect(pipeline.runOrThrow({})).resolves.toBe(42);
  });

  it("checks result contracts, step membership, and target compatibility", () => {
    const { step } = createSteps();
    const first = step("first", { run: () => "first" });
    const last = step("last", { dependsOn: [first], run: () => 1 });
    const other = step("last", { run: () => 2 });
    const definition: PipelineDefinition<readonly [typeof first, typeof last], number> = {
      id: "reusable",
      steps: [first, last],
      finalize: last,
    };
    expectTypeOf(definePipeline(definition).runOrThrow).returns.resolves.toEqualTypeOf<number>();
    definePipeline<readonly [typeof first], number>({
      id: "wrong-result",
      steps: [first],
      // @ts-expect-error A string output cannot satisfy the explicit number contract.
      finalize: first,
    });
    definePipeline({
      id: "wrong-schema",
      steps: [first, last],
      // @ts-expect-error The chosen step output must satisfy the result schema input.
      finalize: first,
      resultSchema: standardSchema<number, number>(() => ({ value: 1 })),
    });
    const absent = step("absent", { run: () => 1 });
    expect(
      thrownDefinitionErrors(() => {
        // @ts-expect-error A finalizer step must belong to the declared step tuple.
        return definePipeline({ id: "absent", steps: [first, last], finalize: absent });
      })[0]?.code
    ).toBe("TUBELESS_DEFINITION_FINALIZER_STEP_NOT_IN_STEPS");
    expect(
      thrownDefinitionErrors(() =>
        definePipeline({ id: "foreign", steps: [last, first], finalize: other })
      )[0]?.code
    ).toBe("TUBELESS_DEFINITION_FINALIZER_STEP_NOT_IN_STEPS");
    expect(
      thrownDefinitionErrors(() =>
        definePipeline({ id: "mismatch", steps: [first, last], targets: [first], finalize: last })
      )[0]?.code
    ).toBe("TUBELESS_DEFINITION_TARGET_FINALIZER_MISMATCH");
  });

  it("requires declared finalizer outputs without rejecting a published undefined", async () => {
    const { step } = createSteps();
    const build = step("build", { run: () => "built" });
    const write = step("write", {
      dependsOn: [build],
      run: () => undefined,
    });
    const pipeline = definePipeline({
      id: "required-finalizer-outputs",
      steps: [build, write],
      finalize: requireOutputs([build, write], (outputs) => {
        expectTypeOf(outputs.build).toEqualTypeOf<string>();
        expectTypeOf(outputs.write).toEqualTypeOf<undefined>();
        return `${outputs.build}:${String(outputs.write)}`;
      }),
    });

    await expect(pipeline.runOrThrow({})).resolves.toBe("built:undefined");

    const filtered = await pipeline.run({}, { stepIds: ["write"] });
    expect(filtered.status).toBe("failed");
    expect(filtered.finalized).toBe(false);
    expect(Object.hasOwn(filtered, "value")).toBe(true);
    expect(filtered.value).toBeUndefined();
    expect(filtered.errors[0]).toMatchObject({
      message: "Required pipeline outputs missing: build, write",
      stepId: PIPELINE_FINALIZE_STEP_ID,
    });
  });

  it("snapshots required finalizer output ids when the pipeline is defined", async () => {
    const { step } = createSteps();
    const value = step("value", { run: () => 1 });
    const pipeline = definePipeline({
      id: "required-finalizer-id-snapshot",
      steps: [value],
      finalize: requireOutputs([value], ({ value }) => value),
    });

    Reflect.set(value, "id", "renamed");

    await expect(pipeline.runOrThrow({})).resolves.toBe(1);
  });
});
