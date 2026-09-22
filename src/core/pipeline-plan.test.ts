import { describe, expect, it } from "vitest";
import { createSteps, definePipeline } from "./pipeline.js";

describe("pipeline planning", () => {
  it("exposes a static execution plan without running steps", () => {
    const { step } = createSteps();
    let ran = false;
    const build = step("build", {
      run: () => {
        ran = true;
        return "built";
      },
    });
    const write = step("write", {
      dependsOn: [build],
      dryRun: "skip",
      run: () => "written",
    });
    const pipeline = definePipeline({
      id: "planned",
      steps: [write, build],
      finalize: (outputs) => outputs,
    });

    const plan = pipeline.plan({ dryRun: true, stepIds: ["write"] });

    expect(ran).toBe(false);
    expect(plan).toMatchObject({
      dryRun: true,
      ok: true,
      pipelineId: "planned",
      steps: [
        {
          dependencies: [],
          id: "build",
          optionalDependencies: [],
          selected: false,
          selectionReasons: [{ kind: "not-selected" }],
          skipAfterFailureOf: [],
          skipReason: "filtered",
        },
        {
          dependencies: ["build"],
          id: "write",
          optionalDependencies: [],
          selected: true,
          selectionReasons: [{ kind: "exact" }],
          skipAfterFailureOf: [],
          skipReason: "unmet-dependency",
        },
      ],
    });
  });

  it("normalizes controls once before validating a plan", () => {
    const { step } = createSteps();
    const pipeline = definePipeline({ id: "controls", steps: [step("work", { run: () => true })] });
    let reads = 0;

    const plan = pipeline.plan({
      get maxConcurrency() {
        reads += 1;
        return 0;
      },
    });

    expect(reads).toBe(1);
    expect(plan.errors[0]).toMatchObject({
      code: "TUBELESS_RUN_CONCURRENCY_INVALID",
      phase: "planning",
    });
  });
});
