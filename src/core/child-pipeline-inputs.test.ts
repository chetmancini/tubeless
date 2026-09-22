import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createSteps,
  definePipeline,
  type PipelineInput,
  type PipelineResult,
} from "./pipeline.js";
import { standardSchema } from "./pipeline.test-support.js";

describe("inherited child inputs", () => {
  it("forwards compatible parent options without mixing in execution controls", async () => {
    const { step } = createSteps<{ value: number; dryRun: string }>();
    let observed: object | undefined;
    const work = step("work", {
      run: (_inputs, context) => {
        observed = context.options;
        return {
          value: context.options.value,
          domainDryRun: context.options.dryRun,
          dryRun: context.dryRun,
        };
      },
    });
    const child = definePipeline({ id: "child", steps: [work], finalize: work });
    const { fromPipeline } = createSteps<{ value: number; dryRun: string; label: string }>();
    const nested = fromPipeline("nested", { pipeline: child, controls: { dryRun: false } });
    const parent = definePipeline({ id: "parent", steps: [nested], finalize: nested });
    expectTypeOf<PipelineResult<typeof parent>>().toEqualTypeOf<{
      value: number;
      domainDryRun: string;
      dryRun: boolean;
    }>();
    const input = { value: 7, dryRun: "domain", label: "extra" };
    await expect(parent.runOrThrow(input, { dryRun: true, maxConcurrency: 2 })).resolves.toEqual({
      value: 7,
      domainDryRun: "domain",
      dryRun: true,
    });
    expect(observed).toBe(input);
    expect(observed).not.toHaveProperty("maxConcurrency");
  });

  it("uses validated parent output as child schema input and preserves child validation", async () => {
    const parentSchema = standardSchema<{ raw: string }, { value: number }>((value) => {
      // SAFETY: the test supplies the declared input shape.
      return { value: { value: Number((value as { raw: string }).raw) } };
    });
    const childSchema = standardSchema<{ value: number }, { text: string }>((value) => {
      // SAFETY: inherited parent options have this declared child input shape.
      const number = (value as { value: number }).value;
      return number > 0
        ? { value: { text: String(number) } }
        : { issues: [{ message: "Expected a positive value" }] };
    });
    const { step } = createSteps(childSchema);
    const work = step("work", { run: (_inputs, context) => context.options.text });
    const child = definePipeline({ id: "validated-child", steps: [work], finalize: work });
    const { fromPipeline } = createSteps(parentSchema);
    const nested = fromPipeline("nested", { pipeline: child });
    const parent = definePipeline({ id: "validated-parent", steps: [nested], finalize: nested });
    expectTypeOf<PipelineInput<typeof parent>>().toEqualTypeOf<{ raw: string }>();
    expectTypeOf<PipelineResult<typeof parent>>().toEqualTypeOf<string>();
    await expect(parent.runOrThrow({ raw: "12" })).resolves.toBe("12");
    const rejected = await parent.run({ raw: "-1" });
    expect(rejected.status).toBe("failed");
    expect(rejected.errors[0]?.code).toBe("TUBELESS_CHILD_FAILED");
  });

  it("supports no-input composition, result mapping, and policy skips", async () => {
    const { step, fromPipeline } = createSteps();
    const run = vi.fn(() => 3);
    const work = step("work", { run });
    const child = definePipeline({ id: "no-input-child", steps: [work], finalize: work });
    const nested = fromPipeline("nested", {
      pipeline: child,
      mapResult: async (value) => String(value),
    });
    const skipped = fromPipeline("skipped", {
      pipeline: child,
      skip: () => ({ reason: "cached", value: "cached" }),
      mapResult: (value) => String(value),
    });
    const parent = definePipeline({
      id: "no-input-parent",
      steps: [nested, skipped],
      finalize: skipped,
    });
    expectTypeOf<PipelineResult<typeof parent>>().toEqualTypeOf<string>();
    await expect(parent.runOrThrow()).resolves.toBe("cached");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("requires mapping for incompatible parent types and honors explicit overrides", async () => {
    const { step } = createSteps<{ value: number }>();
    const work = step("work", { run: (_inputs, context) => context.options.value });
    const child = definePipeline({ id: "required-child", steps: [work], finalize: work });
    const { fromPipeline } = createSteps<{ raw: string }>();
    const nested = fromPipeline("nested", {
      pipeline: child,
      mapOptions: (_inputs, context) => ({ value: Number(context.options.raw) }),
    });
    const parent = definePipeline({ id: "mapped-parent", steps: [nested], finalize: nested });
    await expect(parent.runOrThrow({ raw: "5" })).resolves.toBe(5);
    const { fromPipeline: compatibleChild } = createSteps<{ value: number }>();
    const overridden = compatibleChild("override", {
      pipeline: child,
      mapOptions: () => ({ value: 9 }),
    });
    await expect(
      definePipeline({ id: "override", steps: [overridden], finalize: overridden }).runOrThrow({
        value: 1,
      })
    ).resolves.toBe(9);

    // oxlint-disable-next-line no-constant-condition -- typecheck-only input compatibility probes
    if (false) {
      // @ts-expect-error Parent options do not satisfy the child input contract.
      fromPipeline("missing-map", { pipeline: child });
      // @ts-expect-error Result mapping does not remove the need for input mapping.
      fromPipeline("missing-map-result", { pipeline: child, mapResult: (value) => String(value) });
      // @ts-expect-error A skip policy does not remove the need for input mapping.
      fromPipeline("missing-map-skip", { pipeline: child, skip: () => "skip" });
      const { fromPipeline: optionalChild } = createSteps<{ value?: number }>();
      // @ts-expect-error An optional parent field cannot satisfy a required child field.
      optionalChild("optional", { pipeline: child });
      const { fromPipeline: unionChild } = createSteps<{ value: number } | { raw: string }>();
      // @ts-expect-error Every possible parent option shape must satisfy the child.
      unionChild("union", { pipeline: child });
    }
  });
});
