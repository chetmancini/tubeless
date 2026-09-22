import { describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline, type PipelineRunControls } from "tubeless";
import { definePipelineCommand } from "tubeless/cli";

describe("public selection controls", () => {
  it("accepts either selection mode, omitted selections, and explicit undefined", async () => {
    const { step } = createSteps();
    const work = step("work", { run: () => 42 });
    const pipeline = definePipeline({ id: "selection", steps: [work], finalize: work });
    const controls: PipelineRunControls<"work", "work">[] = [
      {},
      { stepIds: undefined, targets: undefined },
      { stepIds: ["work"], targets: undefined, dryRun: true },
      { targets: ["work"], stepIds: undefined, maxConcurrency: 2, continueOnError: true },
    ];
    for (const selection of controls) {
      expect(pipeline.plan(selection).ok).toBe(true);
      await expect(pipeline.runOrThrow({}, selection)).resolves.toBe(42);
    }
  });

  it("rejects conflicting object, spread, command, and child controls at the type boundary", () => {
    const { step, fromPipeline, forEachPipeline } = createSteps();
    const work = step("work", { run: () => 42 });
    const pipeline = definePipeline({ id: "typed-selection", steps: [work], finalize: work });
    const command = definePipelineCommand(pipeline, { params: {} });
    const exact = { stepIds: ["work"] } as const;
    const targeted = { targets: ["work"] } as const;
    const conflict = { ...exact, ...targeted };
    // @ts-expect-error The exported type excludes simultaneous selection modes.
    const invalid: PipelineRunControls<"work", "work"> = conflict;
    expect(invalid).toEqual(conflict);
    // @ts-expect-error Stored objects cannot bypass the selection union.
    expect(pipeline.plan(conflict).ok).toBe(false);
    // @ts-expect-error Spread objects cannot bypass the selection union.
    expect(command.plan({ ...exact, ...targeted }).ok).toBe(false);

    // oxlint-disable-next-line no-constant-condition -- typecheck-only child control probes
    if (false) {
      fromPipeline("single", {
        pipeline,
        mapOptions: () => ({}),
        // @ts-expect-error Static child controls exclude simultaneous selection modes.
        controls: conflict,
      });
      fromPipeline("single-callback", {
        pipeline,
        mapOptions: () => ({}),
        // @ts-expect-error Computed child controls exclude simultaneous selection modes.
        controls: () => conflict,
      });
      forEachPipeline("many", {
        pipeline,
        items: () => ["one"],
        key: (item) => item,
        mapOptions: () => ({}),
        // @ts-expect-error Static fan-out controls exclude simultaneous selection modes.
        controls: conflict,
      });
      forEachPipeline("many-callback", {
        pipeline,
        items: () => ["one"],
        key: (item) => item,
        mapOptions: () => ({}),
        // @ts-expect-error Per-item fan-out controls exclude simultaneous selection modes.
        controls: () => conflict,
      });
      // @ts-expect-error Literal step IDs remain checked.
      pipeline.plan({ stepIds: ["missing"] });
      // @ts-expect-error Literal target IDs remain checked.
      pipeline.plan({ targets: ["missing"] });
    }
  });

  it("retains runtime rejection without executing work for untyped run callers", async () => {
    const run = vi.fn(() => 42);
    const { step } = createSteps();
    const work = step("work", { run });
    const pipeline = definePipeline({ id: "runtime-selection", steps: [work], finalize: work });
    const conflict = { stepIds: ["work"], targets: ["work"] } as const;
    // @ts-expect-error Exercise the runtime backstop with a statically rejected object.
    const result = await pipeline.run({}, conflict);
    expect(result).toMatchObject({ status: "failed", finalized: false });
    expect(result.errors[0]?.code).toBe("TUBELESS_PLANNING_SELECTION_CONFLICT");
    // @ts-expect-error runOrThrow has the same mutually exclusive controls.
    await expect(pipeline.runOrThrow({}, conflict)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
