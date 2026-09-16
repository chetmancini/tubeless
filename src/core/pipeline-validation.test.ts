import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createSteps,
  definePipeline,
  PIPELINE_FINALIZE_STEP_ID,
  requireOutputs,
  type StandardSchemaV1,
} from "./pipeline.js";

function standardSchema<TInput, TOutput>(
  validate: StandardSchemaV1<TInput, TOutput>["~standard"]["validate"],
  vendor = "test"
): StandardSchemaV1<TInput, TOutput> {
  return { "~standard": { validate, vendor, version: 1 } };
}

describe("pipeline boundary validation", () => {
  it("validates and transforms options, step outputs, and final results", async () => {
    const inputMarker = Symbol("input-options");
    class InputOptions {
      readonly hidden!: string;
      readonly [inputMarker] = "input-symbol";
      readonly #suffix = "!";

      constructor(readonly raw: string) {
        Object.defineProperty(this, "hidden", {
          enumerable: false,
          value: "input-non-enumerable",
        });
      }

      read(): string {
        return `${this.raw}${this.#suffix}`;
      }
    }
    const outputMarker = Symbol("validated-options");
    class ValidatedOptions {
      readonly hidden!: string;
      readonly [outputMarker] = "symbol-value";
      readonly #factor = 2;

      constructor(readonly count: number) {
        Object.defineProperty(this, "hidden", { enumerable: false, value: "non-enumerable" });
      }

      double(): number {
        return this.count * this.#factor;
      }

      get tripled(): number {
        return this.count * (this.#factor + 1);
      }
    }
    let validatedOptions: ValidatedOptions | undefined;
    const optionsSchema = standardSchema<InputOptions, ValidatedOptions>(async (value) => {
      const input = value as InputOptions;
      expect(input).toBeInstanceOf(InputOptions);
      expect(input.read()).toBe("4!");
      expect(input.hidden).toBe("input-non-enumerable");
      expect(input[inputMarker]).toBe("input-symbol");
      expect(Object.getOwnPropertyDescriptor(input, "hidden")?.enumerable).toBe(false);
      expect(Object.keys(input)).toEqual(["raw"]);
      expect(Reflect.ownKeys(input)).toHaveLength(3);
      expect(Reflect.ownKeys(input)).toEqual(
        expect.arrayContaining(["raw", "hidden", inputMarker])
      );
      expect(input).not.toHaveProperty("dryRun");
      expect("dryRun" in input).toBe(false);
      validatedOptions = new ValidatedOptions(Number(input.raw));
      return { value: validatedOptions };
    });
    const outputSchema = standardSchema<string, number>((value) =>
      typeof value === "string"
        ? { value: Number(value) }
        : { issues: [{ message: "Expected text output" }] }
    );
    const resultSchema = standardSchema<{ total: number }, string>((value) => ({
      value: `total:${(value as { total: number }).total}`,
    }));
    const step = createSteps(optionsSchema);
    const load = step("load", {
      outputSchema,
      run: (_inputs, context) => {
        expectTypeOf(context.options.count).toEqualTypeOf<number>();
        expect(context.options).toBe(validatedOptions);
        expect(context.options).toBeInstanceOf(ValidatedOptions);
        expect(context.options.double()).toBe(8);
        expect(context.options.tripled).toBe(12);
        expect(context.options.hidden).toBe("non-enumerable");
        expect(context.options[outputMarker]).toBe("symbol-value");
        expect(Object.getOwnPropertyDescriptor(context.options, "hidden")?.enumerable).toBe(false);
        expect(context.dryRun).toBe(true);
        expect(context.options).not.toHaveProperty("dryRun");
        expect(context.options).not.toHaveProperty("raw");
        return String(context.options.count + 1);
      },
    });
    expectTypeOf<Awaited<ReturnType<typeof load.run>>>().toEqualTypeOf<string>();
    const total = step("total", {
      dependsOn: [load],
      run: ({ load }) => {
        expectTypeOf(load).toEqualTypeOf<number>();
        return load * 2;
      },
    });
    const pipeline = definePipeline({
      id: "validated-boundaries",
      steps: [load, total],
      resultSchema,
      finalize: requireOutputs([total], ({ total }) => ({ total })),
    });

    const input = new InputOptions("4");
    const value = await pipeline.runOrThrow(input, { dryRun: true });

    expectTypeOf(value).toEqualTypeOf<string>();
    expect(value).toBe("total:10");
    expect(validatedOptions).not.toHaveProperty("dryRun");
  });

  it("keeps reusable validated domain options separate from run controls", async () => {
    const reusable = { count: 3 };
    const optionsSchema = standardSchema<object, typeof reusable>(() => ({ value: reusable }));
    const step = createSteps(optionsSchema);
    const read = step("read", {
      run: (_inputs, context) => ({ count: context.options.count, dryRun: context.dryRun }),
    });
    const pipeline = definePipeline({
      id: "reusable-validated-options",
      steps: [read],
      finalize: requireOutputs([read], ({ read }) => read),
    });

    await expect(pipeline.runOrThrow({}, { dryRun: true })).resolves.toEqual({
      count: 3,
      dryRun: true,
    });
    expect(reusable).not.toHaveProperty("dryRun");
    await expect(pipeline.runOrThrow({})).resolves.toEqual({ count: 3, dryRun: false });
  });

  it("applies controls independently when an options schema returns its input", async () => {
    const optionsSchema = standardSchema<{ label: string }, { label: string }>((value) => ({
      // SAFETY: identity schema; validate receives unknown and this test only
      // needs the value echoed as the declared options object.
      value: value as { label: string },
    }));
    const step = createSteps(optionsSchema);
    const fail = step("fail", {
      run: () => {
        throw new Error("expected failure");
      },
    });
    const observe = step("observe", {
      run: (_inputs, context) => context.options.label,
    });
    const pipeline = definePipeline({
      id: "identity-options-schema",
      steps: [fail, observe],
      finalize: (outputs) => outputs.observe,
    });

    const result = await pipeline.run({ label: "identity" }, { continueOnError: true });

    expect(result.status).not.toBe("completed");
    expect(result.finalized).toBe(true);
    expect(result.value).toBe("identity");
    expect(result.steps.map(({ id, status }) => [id, status])).toEqual([
      ["fail", "failed"],
      ["observe", "completed"],
    ]);
  });

  it("does not need to overlay controls on non-extensible validated options", async () => {
    class FrozenOptions {
      readonly #value = 7;

      read(): number {
        return this.#value;
      }
    }
    const frozen = new FrozenOptions();
    Object.freeze(frozen);
    const optionsSchema = standardSchema<object, FrozenOptions>(() => ({ value: frozen }));
    const step = createSteps(optionsSchema);
    const read = step("read", {
      run: (_inputs, context) => {
        expect(context.options).toBeInstanceOf(FrozenOptions);
        expect(context.options.read()).toBe(7);
        expect(context.dryRun).toBe(true);
        return context.options.read();
      },
    });
    const pipeline = definePipeline({
      id: "frozen-validated-options",
      steps: [read],
      finalize: requireOutputs([read], ({ read }) => read),
    });

    await expect(pipeline.runOrThrow({}, { dryRun: true })).resolves.toBe(7);
  });

  it("reports option validation issues before any step starts", async () => {
    const input = { source: "bad" };
    const validate = vi.fn((value: unknown) => {
      expect(value).toBe(input);
      return {
        issues: [
          { message: "Required", path: ["source"] },
          { message: "Nested", path: [{ key: "config" }, 0] },
        ],
      };
    });
    const optionsSchema = standardSchema<{ source: string }, { source: string }>(validate);
    const step = createSteps(optionsSchema);
    const load = step("load", { run: () => "never" });
    const pipeline = definePipeline({
      id: "invalid-options",
      steps: [load],
      finalize: () => undefined,
    });

    expect(pipeline.plan().ok).toBe(true);
    expect(validate).not.toHaveBeenCalled();

    const result = await pipeline.run(input);

    expect(result.status).not.toBe("completed");
    expect(validate).toHaveBeenCalledOnce();
    expect(result.steps).toEqual([]);
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_OPTIONS_VALIDATION_FAILED",
      issues: [
        { message: "Required", path: ["source"] },
        { message: "Nested", path: ["config", 0] },
      ],
      kind: "validation",
      phase: "execution",
    });
  });

  it("attaches output and final-result validation failures to their lifecycle boundaries", async () => {
    const rejectedOutput = standardSchema<string, string>(() => ({
      issues: [{ message: "Not publishable", path: ["slug"] }],
    }));
    const step = createSteps();
    const publish = step("publish", { outputSchema: rejectedOutput, run: () => "draft" });
    const outputPipeline = definePipeline({
      id: "invalid-output",
      steps: [publish],
      finalize: () => undefined,
    });

    const outputResult = await outputPipeline.run({});
    expect(outputResult.steps[0]).toMatchObject({
      status: "failed",
      error: {
        code: "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED",
        issues: [{ message: "Not publishable", path: ["slug"] }],
        stepId: "publish",
      },
    });

    const rejectedResult = standardSchema<number, number>(() => ({
      issues: [{ message: "Must be positive" }],
    }));
    const value = step("value", { run: () => -1 });
    const resultPipeline = definePipeline({
      id: "invalid-result",
      steps: [value],
      resultSchema: rejectedResult,
      finalize: () => -1,
    });

    const result = await resultPipeline.run({});
    expect(result.finalized).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_FINAL_RESULT_VALIDATION_FAILED",
      issues: [{ message: "Must be positive" }],
      kind: "validation",
      phase: "finalization",
      stepId: PIPELINE_FINALIZE_STEP_ID,
    });
  });
});
