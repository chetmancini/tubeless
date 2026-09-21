import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createSteps,
  definePipeline,
  PipelineDefinitionError,
  requireOutputs,
} from "./pipeline.js";
import type { AnyStep } from "./pipeline-steps.js";
import { PIPELINE_FINALIZE_STEP_ID } from "./pipeline-step-metadata.js";
import { makePipeline, thrownDefinitionErrors } from "./pipeline.test-support.js";

describe("definePipeline targets and definitions", () => {
  it("supports shared target inputs, policy skips, and dry-run target omission", async () => {
    let sourceRuns = 0;
    const { step } = createSteps();
    const source = step("source", { run: () => (sourceRuns += 1) });
    const valuedSkip = step("valued-skip", {
      dependsOn: [source],
      skip: () => ({ reason: "cached", value: "cached-value" }),
      run: () => "fresh-value",
    });
    const emptySkip = step("empty-skip", {
      dependsOn: [source],
      skip: () => "not needed",
      run: () => "unexpected",
    });
    const write = step("write", {
      dependsOn: [source],
      dryRun: "skip",
      run: () => "written",
    });
    const pipeline = definePipeline({
      id: "target-policies",
      steps: [source, valuedSkip, emptySkip, write],
      targets: [valuedSkip, emptySkip, write],
      finalize: (outputs) => outputs,
    });

    const skipped = await pipeline.run({}, { targets: ["valued-skip", "empty-skip"] });
    expect(skipped.status).toBe("completed");
    expect(skipped.value).toMatchObject({ "valued-skip": "cached-value" });
    expect(Object.prototype.hasOwnProperty.call(skipped.value, "empty-skip")).toBe(true);
    expect(sourceRuns).toBe(1);
    expect(
      pipeline
        .plan({ targets: ["valued-skip", "empty-skip"] })
        .steps.find(({ id }) => id === "source")?.selectionReasons
    ).toEqual([
      {
        dependentId: "valued-skip",
        kind: "required-dependency",
        targetId: "valued-skip",
      },
      {
        dependentId: "empty-skip",
        kind: "required-dependency",
        targetId: "empty-skip",
      },
    ]);

    const dryRun = await pipeline.run({}, { dryRun: true, targets: ["write"] });
    expect(dryRun.status).toBe("completed");
    expect(dryRun.steps.find(({ id }) => id === "write")).toMatchObject({
      reason: "dry-run",
      status: "skipped",
    });
    expect(pipeline.plan({ dryRun: true, targets: ["write"] }).steps.at(-1)).toMatchObject({
      selectionReasons: [{ kind: "target", targetId: "write" }],
      skipReason: "dry-run",
    });
  });

  it("rejects invalid target selections and combining targets with stepIds", () => {
    const pipeline = makePipeline("target-validation");

    expect(pipeline.plan({ targets: [] }).errors[0]).toMatchObject({
      code: "TUBELESS_PLANNING_TARGET_SELECTION_EMPTY",
      kind: "selection",
      phase: "planning",
    });
    expect(pipeline.plan({ targets: ["build", "build"] }).errors[0]).toMatchObject({
      code: "TUBELESS_PLANNING_TARGET_SELECTION_DUPLICATE",
      kind: "selection",
      phase: "planning",
    });
    expect(pipeline.plan({ targets: ["missing" as never] }).errors[0]).toMatchObject({
      code: "TUBELESS_PLANNING_TARGET_UNKNOWN",
      kind: "selection",
      phase: "planning",
    });
    expect(pipeline.plan({ stepIds: ["build", "build"] }).errors[0]).toMatchObject({
      code: "TUBELESS_PLANNING_STEP_SELECTION_DUPLICATE",
      kind: "selection",
      phase: "planning",
    });
    expect(pipeline.plan({ stepIds: ["build"], targets: ["write"] }).errors[0]).toMatchObject({
      code: "TUBELESS_PLANNING_SELECTION_CONFLICT",
      kind: "selection",
      phase: "planning",
    });
  });

  it("exposes only declared targets and rejects internal steps as targets", () => {
    const { step } = createSteps();
    const load = step("load", { run: () => "loaded" });
    const publish = step("publish", {
      dependsOn: [load],
      run: ({ load }) => `${load}:published`,
    });
    const pipeline = definePipeline({
      id: "declared-targets",
      steps: [load, publish],
      targets: [publish],
      finalize: (outputs) => outputs.publish,
    });

    expect(pipeline.targetIds).toEqual(["publish"]);
    expect(Object.isFrozen(pipeline.targetIds)).toBe(true);
    expectTypeOf(pipeline.targetIds).toEqualTypeOf<readonly "publish"[]>();
    expect(pipeline.plan({ targets: ["publish"] }).ok).toBe(true);
    // @ts-expect-error Internal steps are available through exact stepIds, not targets.
    pipeline.plan({ targets: ["load"] });
    expect(pipeline.plan({ targets: ["load" as never] }).errors[0]).toMatchObject({
      code: "TUBELESS_PLANNING_TARGET_UNDECLARED",
      kind: "selection",
      phase: "planning",
    });
  });

  it("rejects declared targets that cannot satisfy required finalizer outputs", () => {
    const { step } = createSteps();
    const load = step("load", { run: () => "loaded" });
    const normalize = step("normalize", {
      dependsOn: [load],
      run: ({ load }) => load.toUpperCase(),
    });

    expect(
      thrownDefinitionErrors(() =>
        definePipeline({
          id: "invalid-target-result",
          steps: [load, normalize],
          targets: [load],
          finalize: requireOutputs([normalize], ({ normalize }) => normalize),
        })
      )[0]
    ).toMatchObject({
      code: "TUBELESS_DEFINITION_TARGET_FINALIZER_MISMATCH",
      kind: "definition",
      phase: "definition",
      stepId: "load",
    });
  });

  it("rejects duplicate and foreign target declarations", () => {
    const { step } = createSteps();
    const included = step("included", { run: () => true });
    const foreign = step("foreign", { run: () => true });

    expect(
      thrownDefinitionErrors(() =>
        definePipeline({
          id: "invalid-target-declarations",
          steps: [included],
          // @ts-expect-error Duplicate and foreign targets are rejected at definition time.
          targets: [included, included, foreign],
          finalize: () => undefined,
        })
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TUBELESS_DEFINITION_TARGETS_DUPLICATE",
          kind: "definition",
          phase: "definition",
        }),
        expect.objectContaining({
          code: "TUBELESS_DEFINITION_TARGET_NOT_IN_STEPS",
          kind: "definition",
          phase: "definition",
        }),
      ])
    );
  });

  it("rejects required finalizer steps that are not in the pipeline", () => {
    const { step } = createSteps();
    const included = step("included", { run: () => true });
    const foreign = step("foreign", { run: () => true });

    expect(
      thrownDefinitionErrors(() =>
        definePipeline({
          id: "foreign-finalizer-output",
          steps: [included],
          // @ts-expect-error Required finalizer steps must be in the pipeline.
          finalize: requireOutputs([foreign], ({ foreign }) => foreign),
        })
      )[0]
    ).toMatchObject({
      code: "TUBELESS_DEFINITION_FINALIZER_STEP_NOT_IN_STEPS",
      kind: "definition",
      phase: "definition",
    });
  });

  it("rejects duplicate step ids when the pipeline is defined", () => {
    const { step } = createSteps();
    const duplicate = step("build", { run: () => "a" });
    let thrown: unknown;
    try {
      const dynamicSteps: readonly AnyStep<object>[] = [duplicate, duplicate];
      definePipeline({
        id: "test",
        // Widened/dynamic definitions retain the runtime backstop; literal tuples
        // are rejected by TypeScript (covered by the validated-boundaries example).
        steps: dynamicSteps,
        finalize: () => undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PipelineDefinitionError);
    expect((thrown as PipelineDefinitionError).errors[0]).toMatchObject({
      code: "TUBELESS_DEFINITION_STEP_IDS_DUPLICATE",
      kind: "definition",
      phase: "definition",
    });
    expect((thrown as PipelineDefinitionError).message).toContain(
      "TUBELESS_DEFINITION_STEP_IDS_DUPLICATE"
    );
  });

  it("rejects blank, reserved, repeated, and contradictory graph declarations", () => {
    const { step } = createSteps();
    const source = step("source", { run: () => "source" });
    const contradictory = step("contradictory", {
      dependsOn: [source, source],
      optionalDependsOn: [source],
      run: () => "unreachable",
    });
    expect(
      thrownDefinitionErrors(() =>
        definePipeline({
          id: " ",
          steps: [source, contradictory],
          finalize: () => undefined,
        })
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TUBELESS_DEFINITION_PIPELINE_ID_BLANK",
          kind: "definition",
          phase: "definition",
        }),
        expect.objectContaining({
          code: "TUBELESS_DEFINITION_DEPENDENCY_DUPLICATE",
          kind: "definition",
          phase: "definition",
          stepId: "contradictory",
        }),
        expect.objectContaining({
          code: "TUBELESS_DEFINITION_DEPENDENCY_CONTRADICTORY",
          kind: "definition",
          phase: "definition",
          stepId: "contradictory",
        }),
      ])
    );

    const reserved = step(PIPELINE_FINALIZE_STEP_ID, { run: () => undefined });
    expect(
      thrownDefinitionErrors(() =>
        definePipeline({ id: "reserved", steps: [reserved], finalize: () => undefined })
      )[0]
    ).toMatchObject({
      code: "TUBELESS_DEFINITION_STEP_ID_RESERVED",
      kind: "definition",
      phase: "definition",
      stepId: PIPELINE_FINALIZE_STEP_ID,
    });
  });

  it("rejects a blank step id when the pipeline is defined", () => {
    const blank: AnyStep<object> = { id: " ", run: () => true };

    expect(
      thrownDefinitionErrors(() =>
        definePipeline({
          id: "blank-step-id",
          steps: [blank],
          finalize: () => undefined,
        })
      )[0]
    ).toMatchObject({
      code: "TUBELESS_DEFINITION_STEP_ID_BLANK",
      kind: "definition",
      phase: "definition",
      stepId: " ",
    });
  });
});
