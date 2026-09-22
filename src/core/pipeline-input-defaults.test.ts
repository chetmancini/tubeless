import { describe, expect, expectTypeOf, it } from "vitest";
import { createSteps, definePipeline, type PipelineInput } from "./pipeline.js";
import { standardSchema } from "./pipeline.test-support.js";

describe("pipeline input defaults", () => {
  it("runs no-input and empty pipelines without an empty object", async () => {
    const { step } = createSteps();
    const work = step("work", { run: () => 42 });
    const pipeline = definePipeline({ id: "no-input", steps: [work], finalize: work });
    expectTypeOf<PipelineInput<typeof pipeline>>().toEqualTypeOf<{}>();
    expectTypeOf(pipeline.runOrThrow).returns.resolves.toEqualTypeOf<number>();
    await expect(pipeline.run()).resolves.toMatchObject({ status: "completed", value: 42 });
    await expect(pipeline.runOrThrow()).resolves.toBe(42);
    await expect(definePipeline({ id: "empty", steps: [] }).runOrThrow()).resolves.toBeUndefined();
    const detached = pipeline.runOrThrow;
    await expect(detached()).resolves.toBe(42);
  });

  it("creates a fresh options object per run and keeps controls and context separate", async () => {
    const { step } = createSteps<{ visits?: number }>();
    const visit = step("visit", {
      run: (_inputs, context) => {
        context.options.visits = (context.options.visits ?? 0) + 1;
        return { visits: context.options.visits, cwd: context.cwd, dryRun: context.dryRun };
      },
    });
    const pipeline = definePipeline({ id: "optional-input", steps: [visit], finalize: visit });
    expectTypeOf<PipelineInput<typeof pipeline>>().toEqualTypeOf<{ visits?: number }>();
    for (let index = 0; index < 2; index += 1) {
      await expect(
        pipeline.runOrThrow(undefined, { dryRun: true }, { cwd: "/tmp/default-input" })
      ).resolves.toEqual({ visits: 1, cwd: "/tmp/default-input", dryRun: true });
    }
    await expect(pipeline.runOrThrow({ visits: 4 })).resolves.toMatchObject({ visits: 5 });
  });

  it("validates and transforms default options through the input schema", async () => {
    const optionsSchema = standardSchema<{ limit?: number }, { limit: number }>((value) => {
      // SAFETY: this test supplies object inputs to the declared schema.
      const options = value as { limit?: number };
      return { value: { limit: options.limit ?? 10 } };
    });
    const { step } = createSteps(optionsSchema);
    const work = step("work", { run: (_inputs, context) => context.options.limit });
    const pipeline = definePipeline({ id: "schema-default", steps: [work], finalize: work });
    expectTypeOf<PipelineInput<typeof pipeline>>().toEqualTypeOf<{ limit?: number }>();
    await expect(pipeline.runOrThrow()).resolves.toBe(10);
    await expect(pipeline.runOrThrow({ limit: 2 })).resolves.toBe(2);

    const { step: rejectingStep } = createSteps(
      standardSchema<{}, {}>(() => ({ issues: [{ message: "Rejected default" }] }))
    );
    const rejected = definePipeline({
      id: "rejected-default",
      steps: [rejectingStep("work", { run: () => 1 })],
    });
    const result = await rejected.run();
    expect(result.status).toBe("failed");
    expect(result.errors[0]?.code).toBe("TUBELESS_OPTIONS_VALIDATION_FAILED");
  });

  it("still requires domain fields for typed and schema-backed inputs", () => {
    const { step } = createSteps<{ source: string }>();
    const work = step("work", { run: (_inputs, context) => context.options.source });
    const required = definePipeline({ id: "required", steps: [work], finalize: work });
    const { step: schemaStep } = createSteps(
      standardSchema<{ source: string }, {}>(() => ({ value: {} }))
    );
    const schemaRequired = definePipeline({
      id: "schema-required",
      steps: [schemaStep("work", { run: () => 1 })],
    });
    expectTypeOf<PipelineInput<typeof required>>().toEqualTypeOf<{ source: string }>();
    // oxlint-disable-next-line no-constant-condition -- typecheck-only required input probes
    if (false) {
      // @ts-expect-error Required domain options cannot be omitted.
      required.run();
      // @ts-expect-error Required domain options cannot be omitted.
      required.runOrThrow();
      // @ts-expect-error Explicit undefined cannot bypass required input fields.
      required.run(undefined, { dryRun: true });
      // @ts-expect-error Schema output fields do not determine whether input is required.
      schemaRequired.runOrThrow();
    }
  });
});
