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

  it("records both roles of a dependency and expands its prerequisites once per target", () => {
    const { step } = createSteps();
    const source = step("source", { run: () => 1 });
    const build = step("build", { dependsOn: [source], run: () => 2 });
    const publish = step("publish", {
      dependsOn: [build],
      skipAfterFailureOf: [build],
      run: () => 3,
    });
    const pipeline = definePipeline({
      id: "overlap",
      steps: [source, build, publish],
      targets: [build, publish],
    });

    const plan = pipeline.plan({ targets: ["publish", "build"] });
    expect(plan.steps.map((entry) => entry.selectionReasons)).toEqual([
      [
        { kind: "required-dependency", dependentId: "build", targetId: "publish" },
        { kind: "required-dependency", dependentId: "build", targetId: "build" },
      ],
      [
        { kind: "required-dependency", dependentId: "publish", targetId: "publish" },
        { kind: "failure-gate", dependentId: "publish", targetId: "publish" },
        { kind: "target", targetId: "build" },
      ],
      [{ kind: "target", targetId: "publish" }],
    ]);
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

  it("suggests near-miss ids and explains target selection failures", () => {
    const { step } = createSteps();
    const lint = step("lint", { run: () => true });
    const build = step("build", { run: () => true });
    const publish = step("publish", { dependsOn: [build], run: () => true });
    const pipeline = definePipeline({
      id: "selection",
      steps: [lint, build, publish],
      targets: [build, publish],
    });
    const message = (controls: { stepIds?: string[]; targets?: string[] }) =>
      pipeline.plan(controls as never).errors.map((error) => error.message);

    expect(message({ stepIds: ["buld"] })).toEqual([
      'Pipeline selection requested unknown step ids: buld. Did you mean "build"?',
    ]);
    expect(message({ stepIds: ["buld", "lnt"] })).toEqual([
      'Pipeline selection requested unknown step ids: buld, lnt. Did you mean "build" for "buld"? Did you mean "lint" for "lnt"?',
    ]);
    expect(message({ stepIds: ["deploy"] })).toEqual([
      "Pipeline selection requested unknown step ids: deploy",
    ]);
    expect(message({ targets: ["publsh"] })).toEqual([
      'Pipeline selection requested unknown targets: publsh. Did you mean "publish"?',
    ]);
    expect(message({ targets: ["deploy"] })).toEqual([
      "Pipeline selection requested unknown targets: deploy. Declared targets: build, publish.",
    ]);
    expect(message({ targets: ["lint"] })).toEqual([
      'Pipeline selection requested undeclared targets: lint. "lint" is a step, not a declared target; select steps exactly with stepIds. Declared targets: build, publish.',
    ]);
    const untargeted = definePipeline({ id: "untargeted", steps: [lint], targets: [] });
    expect(untargeted.plan({ targets: ["lint" as never] }).errors[0]?.message).toBe(
      'Pipeline untargeted requested undeclared targets: lint. "lint" is a step, not a declared target; select steps exactly with stepIds. Pipeline untargeted declares no targets.'
    );
  });
});
