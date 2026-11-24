import { describe, expect, it } from "vitest";
import { decideStepDisposition, type DependencyState } from "./pipeline-disposition.js";
import { compilePipelineGraph, stepEdges } from "./pipeline-graph.js";
import type { AnyStep } from "./pipeline-steps.js";

function disposition(
  step: AnyStep,
  options: {
    dryRun?: boolean;
    dependencies?: readonly (readonly [string, DependencyState])[];
    selected?: boolean;
  } = {}
) {
  const graph = compilePipelineGraph({ orderedSteps: [...stepEdges(step), step] });
  return decideStepDisposition({
    dryRun: options.dryRun ?? false,
    selected: options.selected ?? true,
    dependencyStates: new Map(options.dependencies),
    step: graph.compiledByAuthorStep.get(step)!,
  });
}

describe("step disposition", () => {
  it("filters an unselected step before considering dependencies or dry-run policy", () => {
    const dependency: AnyStep = { id: "dependency", run: () => undefined };
    const step: AnyStep = {
      dependsOn: [dependency],
      dryRun: "skip",
      id: "work",
      run: () => undefined,
    };

    expect(disposition(step, { dryRun: true, selected: false })).toEqual({
      kind: "skip",
      reason: "filtered",
    });
  });

  it("identifies the first unsuccessful failure gate", () => {
    const gate: AnyStep = { id: "gate", run: () => undefined };
    const step: AnyStep = {
      id: "publish",
      run: () => undefined,
      skipAfterFailureOf: [gate],
    };

    expect(disposition(step, { dependencies: [[gate.id, { status: "failed" }]] })).toEqual({
      dependencyId: "gate",
      kind: "skip",
      reason: "failed-dependency",
    });
  });

  it("identifies an unmet required dependency", () => {
    const dependency: AnyStep = { id: "build", run: () => undefined };
    const step: AnyStep = {
      dependsOn: [dependency],
      id: "write",
      run: () => undefined,
    };

    expect(disposition(step)).toEqual({
      dependencyId: "build",
      kind: "skip",
      reason: "unmet-dependency",
    });
  });

  it("treats completed and policy-skipped required dependencies as met", () => {
    const completedDependency: AnyStep = { id: "built", run: () => undefined };
    const skippedDependency: AnyStep = { id: "cached", run: () => undefined };
    const step: AnyStep = {
      dependsOn: [completedDependency, skippedDependency],
      id: "consume",
      run: () => undefined,
    };

    expect(
      disposition(step, {
        dependencies: [
          [completedDependency.id, { status: "completed" }],
          [skippedDependency.id, { status: "skipped", reason: "policy" }],
        ],
      })
    ).toEqual({ kind: "run" });
  });

  it("skips only explicitly skipped steps during a dry run", () => {
    const skipped: AnyStep = { dryRun: "skip", id: "write", run: () => undefined };
    const previewed: AnyStep = {
      dryRun: () => undefined,
      id: "preview",
      run: () => undefined,
    };

    expect(disposition(skipped, { dryRun: true })).toEqual({
      kind: "skip",
      reason: "dry-run",
    });
    expect(disposition(previewed, { dryRun: true })).toEqual({ kind: "run" });
  });
});
