import { describe, expect, it } from "vitest";
import { decideStepDisposition } from "./pipeline-disposition.js";
import { liveStepGraph } from "./pipeline-graph.js";
import { stepToPlanStep } from "./pipeline-plan.js";
import type { AnyStep } from "./pipeline-steps.js";
import type { PipelineStepReport } from "./pipeline-types.js";

function completed(id: string): PipelineStepReport {
  return {
    attemptId: `${id}:attempt`,
    id,
    finishedAtMs: 1,
    startedAtMs: 0,
    status: "completed",
  };
}

function failed(id: string): PipelineStepReport {
  return {
    attemptId: `${id}:attempt`,
    error: {
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      message: `${id} failed`,
      phase: "execution",
      stepId: id,
    },
    id,
    finishedAtMs: 1,
    startedAtMs: 0,
    status: "failed",
  };
}

function policySkipped(id: string): PipelineStepReport {
  return {
    id,
    finishedAtMs: 1,
    reason: "policy",
    status: "skipped",
  };
}

function disposition(
  step: AnyStep,
  options: {
    dryRun?: boolean;
    reports?: readonly (readonly [string, PipelineStepReport])[];
    selected?: boolean;
  } = {}
) {
  const graph = liveStepGraph(step);
  const selected = options.selected ?? true;
  return decideStepDisposition({
    dryRun: options.dryRun ?? false,
    graph,
    planned: stepToPlanStep(step, selected, undefined, undefined, graph),
    reportsByStepId: new Map(options.reports),
    step,
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

    expect(disposition(step, { reports: [[gate.id, failed(gate.id)]] })).toEqual({
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
        reports: [
          [completedDependency.id, completed(completedDependency.id)],
          [skippedDependency.id, policySkipped(skippedDependency.id)],
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
