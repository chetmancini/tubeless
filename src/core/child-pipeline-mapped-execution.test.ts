import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createSteps, definePipeline, type PipelineStepProgress, type Step } from "./pipeline.js";

describe("mapped child adapter: execution", () => {
  it("runs runtime-selected children with bounded concurrency and stable result order", async () => {
    interface ParentOptions {
      concurrency: number;
    }
    interface ChildOptions {
      delayMs: number;
      itemId: string;
    }

    let active = 0;
    let maxActive = 0;
    const childStep = createSteps<ChildOptions>();
    const process = childStep("process", {
      run: async (_inputs, context) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, context.options.delayMs));
        active -= 1;
        return context.options.itemId;
      },
    });
    const child = definePipeline({
      id: "worker",
      steps: [process],
      finalize: (outputs) => ({ workerId: outputs.process ?? "missing" }),
    });

    const parentStep = createSteps<ParentOptions>();
    const select = parentStep("select", {
      run: () => [
        { delayMs: 20, id: "first" },
        { delayMs: 1, id: "second" },
        { delayMs: 1, id: "third" },
      ],
    });
    const children = parentStep.forEachPipeline("children", {
      pipeline: child,
      dependsOn: [select],
      items: ({ select }) => select,
      key: (item) => item.id,
      concurrency: (_inputs, context) => context.options.concurrency,
      progress: { itemNoun: "shards" },
      mapOptions: (item) => ({ delayMs: item.delayMs, itemId: item.id }),
    });
    expectTypeOf(children).toEqualTypeOf<
      Step<"children", readonly { workerId: string }[], ParentOptions>
    >();
    parentStep.forEachPipeline("skip-requires-skippable", {
      pipeline: child,
      // @ts-expect-error Policy skip belongs on forEachPipeline.skippable.
      skip: () => "fan-out not requested",
      items: (): readonly { delayMs: number; id: string }[] => [],
      key: (item) => item.id,
      mapOptions: (item) => ({ delayMs: item.delayMs, itemId: item.id }),
    });
    const reusableSkippingFanOutDefinition = {
      pipeline: child,
      skip: () => "fan-out not requested",
      items: (): readonly { delayMs: number; id: string }[] => [],
      key: (item: { delayMs: number; id: string }) => item.id,
      mapOptions: (item: { delayMs: number; id: string }) => ({
        delayMs: item.delayMs,
        itemId: item.id,
      }),
    };
    parentStep.forEachPipeline(
      "reusable-skip-requires-skippable",
      // @ts-expect-error Reusable definitions cannot bypass forEachPipeline.skippable.
      reusableSkippingFanOutDefinition
    );
    const skippableChildren = parentStep.forEachPipeline.skippable("skippable-children", {
      pipeline: child,
      dependsOn: [select],
      skip: ({ select }) => (select.length === 0 ? { reason: "no children", value: [] } : false),
      items: ({ select }) => select,
      key: (item) => item.id,
      mapOptions: (item) => ({ delayMs: item.delayMs, itemId: item.id }),
    });
    expectTypeOf(skippableChildren).toEqualTypeOf<
      Step<"skippable-children", readonly { workerId: string }[] | undefined, ParentOptions>
    >();
    const skippableMappedChildren = parentStep.forEachPipeline.skippable(
      "skippable-mapped-children",
      {
        pipeline: child,
        skip: () => ({ reason: "fan-out disabled", value: [{ id: "disabled" }] }),
        items: (): readonly { delayMs: number; id: string }[] => [],
        key: (item) => item.id,
        mapOptions: (item) => ({ delayMs: item.delayMs, itemId: item.id }),
        mapResult: (value) => ({ id: value.workerId }),
      }
    );
    expectTypeOf(skippableMappedChildren).toEqualTypeOf<
      Step<"skippable-mapped-children", readonly { id: string }[] | undefined, ParentOptions>
    >();
    parentStep.forEachPipeline.skippable("invalid-mapped-skip-value", {
      pipeline: child,
      // @ts-expect-error skip value must be the complete mapped output array.
      skip: () => ({ reason: "fan-out disabled", value: [{ workerId: "wrong" }] }),
      items: (): readonly { delayMs: number; id: string }[] => [],
      key: (item) => item.id,
      mapOptions: (item) => ({ delayMs: item.delayMs, itemId: item.id }),
      mapResult: (value) => ({ id: value.workerId }),
    });
    const parent = definePipeline({
      id: "batch-parent",
      steps: [select, children],
      finalize: (outputs) => outputs.children,
    });
    expect(parent.plan().steps[1]?.nestedPipeline).toEqual({
      mode: "for-each",
      pipelineId: "worker",
      stepIds: ["process"],
    });
    const progress: PipelineStepProgress[] = [];

    const result = await parent.run({ concurrency: 2 }, undefined, {
      cwd: "/repo",
      hooks: {
        onStepProgress: ({ progress: nextProgress }) => progress.push(nextProgress),
      },
      log: console,
    });

    expect(result.status).toBe("completed");
    expect(result.value).toEqual([
      { workerId: "first" },
      { workerId: "second" },
      { workerId: "third" },
    ]);
    expect(maxActive).toBe(2);
    expect(
      progress.some(
        ({ message, details }) =>
          message?.includes("running (max 2)") &&
          message.includes("shards") &&
          Boolean(
            details?.some(
              (detail) => detail.id === "first" || detail.id === "second" || detail.id === "third"
            )
          )
      )
    ).toBe(true);
    expect(progress.some(({ message }) => message?.includes("completed"))).toBe(true);
    expect(progress.at(-1)).toMatchObject({
      completed: 3,
      total: 3,
    });
    expect(progress.at(-1)?.message).toMatch(/3\/3 shards/);
    expect(progress.at(-1)?.details?.filter((detail) => !detail.depth)).toEqual([
      { id: "first", status: "completed" },
      { id: "second", status: "completed" },
      { id: "third", status: "completed" },
    ]);
  });

  it("policy-skips mapped children with the parent-facing result array", async () => {
    const runChild = vi.fn(() => "child-result");
    const childStep = createSteps();
    const process = childStep("process", { run: runChild });
    const child = definePipeline({
      id: "skipped-fan-out-child",
      steps: [process],
      finalize: (outputs) => ({ value: outputs.process ?? "missing" }),
    });

    const parentStep = createSteps();
    const items = vi.fn(() => [{ id: "child" }]);
    const mapResult = vi.fn((value: { value: string }) => ({ id: value.value }));
    const children = parentStep.forEachPipeline.skippable("children", {
      pipeline: child,
      skip: () => ({
        reason: "fan-out disabled",
        value: [{ id: "disabled" }],
      }),
      items,
      key: (item) => item.id,
      mapOptions: () => ({}),
      mapResult,
    });
    const after = parentStep("after", {
      dependsOn: [children],
      run: ({ children: values }) => values?.[0]?.id,
    });
    const parent = definePipeline({
      id: "skipped-fan-out-parent",
      steps: [children, after],
      finalize: (outputs) => outputs.after,
    });

    const result = await parent.run({});

    expect(result.status).toBe("completed");
    expect(result.value).toBe("disabled");
    expect(items).not.toHaveBeenCalled();
    expect(runChild).not.toHaveBeenCalled();
    expect(mapResult).not.toHaveBeenCalled();
    expect(result.steps).toMatchObject([
      { id: "children", status: "skipped", reason: "policy", message: "fan-out disabled" },
      { id: "after", status: "completed" },
    ]);
  });
});
