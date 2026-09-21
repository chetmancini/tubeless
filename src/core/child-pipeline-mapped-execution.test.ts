import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createSteps, definePipeline, type PipelineStepProgress, type Step } from "./pipeline.js";

import { defer } from "./child-pipeline.test-support.js";

describe("mapped child adapter: execution", () => {
  it("retains successful undefined child outputs in input order", async () => {
    const { step } = createSteps<{ index: number }>();
    const process = step("process", {
      run: (_inputs, context) => (context.options.index === 0 ? undefined : "second"),
    });
    const child = definePipeline({ id: "optional-child", steps: [process] });
    const { forEachPipeline } = createSteps();
    const mapOptions = vi.fn((_item: string, index: number) => ({ index }));
    const children = forEachPipeline("children", {
      pipeline: child,
      items: () => ["a", "b"],
      key: (item) => item,
      concurrency: 2,
      mapOptions,
    });
    const parent = definePipeline({ id: "optional-parent", steps: [children] });

    const result = await parent.run({});

    expect(result.status).toBe("completed");
    expect(result.value).toEqual([undefined, "second"]);
    expect(Object.keys(result.value!)).toEqual(["0", "1"]);
    expect(mapOptions.mock.calls.map(([item, index]) => [item, index])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  it("runs runtime-selected children with bounded concurrency and stable result order", async () => {
    interface ParentOptions {
      concurrency: number;
    }
    interface ChildOptions {
      itemId: string;
    }

    const started = { first: defer(), second: defer(), third: defer() };
    const release = { first: defer(), second: defer(), third: defer() };
    let active = 0;
    let maxActive = 0;
    const { step: childStep } = createSteps<ChildOptions>();
    const process = childStep("process", {
      run: async (_inputs, context) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const id = context.options.itemId as keyof typeof started;
        started[id].resolve();
        await release[id].promise;
        active -= 1;
        return context.options.itemId;
      },
    });
    const child = definePipeline({
      id: "worker",
      steps: [process],
      finalize: (outputs) => ({ workerId: outputs.process ?? "missing" }),
    });

    const { step: parentStep, forEachPipeline: parentForEachPipeline } =
      createSteps<ParentOptions>();
    const select = parentStep("select", {
      run: () => [{ id: "first" }, { id: "second" }, { id: "third" }],
    });
    const children = parentForEachPipeline("children", {
      pipeline: child,
      dependsOn: [select],
      items: ({ select }) => select,
      key: (item) => item.id,
      concurrency: (_inputs, context) => context.options.concurrency,
      progress: { itemNoun: "shards" },
      mapOptions: (item) => ({ itemId: item.id }),
    });
    expectTypeOf(children).toEqualTypeOf<
      Step<"children", readonly { workerId: string }[], ParentOptions>
    >();
    const skippedChildren = parentForEachPipeline("skipped-children", {
      pipeline: child,
      skip: () => "fan-out not requested",
      items: (): readonly { id: string }[] => [],
      key: (item) => item.id,
      mapOptions: (item) => ({ itemId: item.id }),
    });
    expectTypeOf(skippedChildren).toEqualTypeOf<
      Step<"skipped-children", readonly { workerId: string }[] | undefined, ParentOptions>
    >();
    const reusableSkippingFanOutDefinition = {
      pipeline: child,
      skip: () => "fan-out not requested",
      items: (): readonly { id: string }[] => [],
      key: (item: { id: string }) => item.id,
      mapOptions: (item: { id: string }) => ({
        itemId: item.id,
      }),
    };
    const reusableSkippingFanOut = parentForEachPipeline(
      "reusable-skipping-fan-out",
      reusableSkippingFanOutDefinition
    );
    expectTypeOf(reusableSkippingFanOut).toEqualTypeOf<
      Step<"reusable-skipping-fan-out", readonly { workerId: string }[] | undefined, ParentOptions>
    >();
    const skippableChildren = parentForEachPipeline("skippable-children", {
      pipeline: child,
      dependsOn: [select],
      skip: ({ select }) => (select.length === 0 ? { reason: "no children", value: [] } : false),
      items: ({ select }) => select,
      key: (item) => item.id,
      mapOptions: (item) => ({ itemId: item.id }),
    });
    expectTypeOf(skippableChildren).toEqualTypeOf<
      Step<"skippable-children", readonly { workerId: string }[], ParentOptions>
    >();
    const skippableMappedChildren = parentForEachPipeline("skippable-mapped-children", {
      pipeline: child,
      skip: () => ({ reason: "fan-out disabled", value: [{ id: "disabled" }] }),
      items: (): readonly { id: string }[] => [],
      key: (item) => item.id,
      mapOptions: (item) => ({ itemId: item.id }),
      mapResult: (value) => ({ id: value.workerId }),
    });
    expectTypeOf(skippableMappedChildren).toEqualTypeOf<
      Step<"skippable-mapped-children", readonly { id: string }[], ParentOptions>
    >();
    parentForEachPipeline("invalid-mapped-skip-value", {
      pipeline: child,
      // @ts-expect-error skip value must be the complete mapped output array.
      skip: () => ({ reason: "fan-out disabled", value: [{ workerId: "wrong" }] }),
      items: (): readonly { id: string }[] => [],
      key: (item) => item.id,
      mapOptions: (item) => ({ itemId: item.id }),
      mapResult: (value) => ({ id: value.workerId }),
    });
    const parent = definePipeline({
      id: "batch-parent",
      steps: [select, children],
      finalize: (outputs) => outputs.children,
    });
    expect(parent.plan().steps[1]?.nestedPipeline).toEqual({
      identity: child.definition.identity,
      concurrency: "dynamic",
      mode: "for-each",
      pipelineId: "worker",
      stepIds: ["process"],
    });
    const progress: PipelineStepProgress[] = [];

    const run = parent.run({ concurrency: 2 }, undefined, {
      cwd: "/repo",
      hooks: {
        onStepProgress: ({ progress: nextProgress }) => progress.push(nextProgress),
      },
      log: console,
    });

    await Promise.all([started.first.promise, started.second.promise]);
    expect(active).toBe(2);
    release.second.resolve();
    await started.third.promise;
    release.third.resolve();
    release.first.resolve();
    const result = await run;

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
    const { step: childStep } = createSteps();
    const process = childStep("process", { run: runChild });
    const child = definePipeline({
      id: "skipped-fan-out-child",
      steps: [process],
      finalize: (outputs) => ({ value: outputs.process ?? "missing" }),
    });

    const { step: parentStep, forEachPipeline: parentForEachPipeline } = createSteps();
    const items = vi.fn(() => [{ id: "child" }]);
    const mapResult = vi.fn((value: { value: string }) => ({ id: value.value }));
    const children = parentForEachPipeline("children", {
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
