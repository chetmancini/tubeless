import { describe, expect, expectTypeOf, it } from "vitest";
import { createSteps, definePipeline, type Step } from "./pipeline.js";

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
      Step<"skippable", { count: number } | undefined, { skipChild: boolean }>
    >();
    const consume = step("consume", {
      dependsOn: [mapped, skippable],
      run: ({ mapped, skippable }) => {
        expectTypeOf(mapped).toEqualTypeOf<{ count: number }>();
        expectTypeOf(skippable).toEqualTypeOf<{ count: number } | undefined>();
        // @ts-expect-error Async mapResult publishes its resolved value, not a Promise.
        expectTypeOf(mapped.then).toBeAny();
        return mapped.count + (skippable?.count ?? 0);
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
});
