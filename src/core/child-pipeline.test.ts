import { describe, expect, expectTypeOf, it } from "vitest";
import { createSteps, definePipeline, type Step } from "./pipeline.js";
import { stubCheckpointStore } from "../utilities/checkpoint-store.test-support.js";
import type { CheckpointStore } from "../utilities/checkpoint-store.js";

describe("child-pipeline composition", () => {
  it("publishes resolved async child mappings to dependents and accepts resolved skip values", async () => {
    const { step, fromPipeline } = createSteps<{ skipChild: boolean }>();
    const source = step("source", { run: () => 3 });
    const child = definePipeline({
      id: "async-mapping-child",
      steps: [source],
      finalize: () => 3,
    });
    const mapped = fromPipeline("mapped", {
      pipeline: child,
      mapOptions: (_inputs, context) => context.options,
      mapResult: async (value) => ({ count: value }),
    });
    const skippable = fromPipeline("skippable", {
      pipeline: child,
      mapOptions: (_inputs, context) => context.options,
      mapResult: async (value) => ({ count: value }),
      skip: (_inputs, context) =>
        context.options.skipChild ? { reason: "cached", value: { count: 7 } } : undefined,
    });
    expectTypeOf(mapped).toEqualTypeOf<Step<"mapped", { count: number }, { skipChild: boolean }>>();
    expectTypeOf(skippable).toEqualTypeOf<
      Step<"skippable", { count: number }, { skipChild: boolean }>
    >();
    const consume = step("consume", {
      dependsOn: [mapped, skippable],
      run: ({ mapped, skippable }) => {
        expectTypeOf(mapped).toEqualTypeOf<{ count: number }>();
        expectTypeOf(skippable).toEqualTypeOf<{ count: number }>();
        // @ts-expect-error Async mapResult publishes its resolved value, not a Promise.
        expectTypeOf(mapped.then).toBeAny();
        return mapped.count + skippable.count;
      },
    });
    const parent = definePipeline({
      id: "async-mapping-parent",
      steps: [mapped, skippable, consume],
      finalize: (outputs) => outputs.consume,
    });
    expect(await parent.runOrThrow({ skipChild: false })).toBe(6);
    expect(await parent.runOrThrow({ skipChild: true })).toBe(10);
  });

  it("publishes resolved async mapped child mappings and fails the step when one rejects", async () => {
    const { step: childStep } = createSteps<{ value: number }>();
    const child = definePipeline({
      id: "async-mapped-child",
      steps: [childStep("echo", { run: (_inputs, context) => context.options.value })],
      finalize: (outputs) => outputs.echo ?? 0,
    });
    const { step, forEachPipeline } = createSteps<{ failAt?: number }>();
    const mapped = forEachPipeline("mapped", {
      pipeline: child,
      items: () => [1, 2, 3],
      key: (item) => String(item),
      concurrency: 2,
      mapOptions: (item) => ({ value: item }),
      mapResult: async (value, _result, _item, index, context) => {
        await Promise.resolve();
        if (index === context.options.failAt) throw new Error(`map ${index} failed`);
        return { doubled: value * 2 };
      },
    });
    expectTypeOf(mapped).toEqualTypeOf<
      Step<"mapped", readonly { doubled: number }[], { failAt?: number }>
    >();
    const consume = step("consume", {
      dependsOn: [mapped],
      run: ({ mapped }) => mapped.map((entry) => entry.doubled),
    });
    const parent = definePipeline({ id: "async-mapped-parent", steps: [mapped, consume] });

    expect(await parent.runOrThrow({})).toEqual([2, 4, 6]);
    const failed = await parent.run({ failAt: 1 });
    expect(failed.status).toBe("failed");
    expect(failed.steps.map((step) => [step.id, step.status])).toEqual([
      ["mapped", "failed"],
      ["consume", "skipped"],
    ]);
    expect(failed.steps[0]).toMatchObject({
      error: { message: expect.stringContaining("map 1 failed") },
    });
  });

  it("child pipelines inherit the parent's checkpoint", async () => {
    const stub = stubCheckpointStore();
    const seen: (CheckpointStore | undefined)[] = [];
    const { step: childStep } = createSteps<{ value: number }>();
    const child = definePipeline({
      id: "checkpoint-child",
      steps: [
        childStep("capture", {
          run: (_inputs, context) => {
            seen.push(context.checkpoint);
            return context.options.value;
          },
        }),
      ],
      finalize: (outputs) => outputs.capture ?? 0,
    });
    const { fromPipeline, forEachPipeline } = createSteps();
    const single = fromPipeline("single", { pipeline: child, mapOptions: () => ({ value: 1 }) });
    const many = forEachPipeline("many", {
      pipeline: child,
      items: () => [2, 3],
      key: (item) => String(item),
      mapOptions: (item) => ({ value: item }),
    });
    const parent = definePipeline({
      id: "checkpoint-parent",
      steps: [single, many],
      finalize: (outputs) => outputs.many,
    });

    expect(await parent.runOrThrow({}, undefined, { checkpoint: stub })).toEqual([2, 3]);
    expect(seen).toEqual([stub, stub, stub]);
  });
});
