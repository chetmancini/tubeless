import { describe, expect, it, vi } from "vitest";
import type { PipelineLifecycleObserver } from "./lifecycle.js";
import { PipelineRunState } from "./pipeline-run-state.js";
import type {
  PipelineError,
  PipelinePlan,
  PipelinePlanStep,
  PipelineStepStatus,
} from "./pipeline-types.js";

function plannedStep(id: string): PipelinePlanStep {
  return {
    dependencies: [],
    dryRun: "run",
    id,
    optionalDependencies: [],
    runtimeSkipPossible: false,
    selected: true,
    selectionReasons: [{ kind: "all" }],
    skipAfterFailureOf: [],
  };
}

function testPlan(steps: PipelinePlanStep[]): PipelinePlan {
  return { dryRun: false, errors: [], ok: true, pipelineId: "test", steps };
}

function testError(
  kind: PipelineError["kind"],
  code: PipelineError["code"],
  stepId: string
): PipelineError {
  return { code, kind, message: `${kind} failed`, phase: "execution", stepId };
}

function setup(ids: string[]) {
  const statuses: PipelineStepStatus[] = [];
  const lifecycle: PipelineLifecycleObserver = {
    finalizeComplete: vi.fn(),
    finalizeError: vi.fn(),
    finalizeStart: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    log: vi.fn(),
    pipelineComplete: vi.fn(),
    pipelineStart: vi.fn(),
    reportAttempt: vi.fn(),
    stepStatus: (event) => statuses.push(event),
  };
  let timestamp = 100;
  const steps = ids.map(plannedStep);
  const state = new PipelineRunState<string>(
    "test",
    false,
    timestamp++,
    { runId: "run-test" },
    () => timestamp++,
    lifecycle
  );
  state.start(testPlan(steps), []);
  for (const step of steps) state.planStep(step);
  return { lifecycle, state, statuses, steps };
}

describe("PipelineRunState", () => {
  it("derives fail-fast reports, lookup state, lifecycle events, and run status together", async () => {
    const { state, statuses, steps } = setup(["build", "write", "publish"]);
    const failure = testError("step", "TUBELESS_STEP_FAILED", "build");
    state.failStep(steps[0]!, state.beginAttempt(steps[0]!), failure);
    state.skipStep(steps[1]!, {
      dependencyId: "build",
      message: "Not run because fail-fast stopped after build failed.",
      reason: "fail-fast",
    });
    state.skipStep(steps[2]!, {
      dependencyId: "build",
      message: "Not run because fail-fast stopped after build failed.",
      reason: "fail-fast",
    });

    const result = await state.finish();

    expect(result.status).toBe("failed");
    expect(result.errors).toEqual([failure]);
    expect(result.steps.map(({ id, status }) => [id, status])).toEqual([
      ["build", "failed"],
      ["write", "skipped"],
      ["publish", "skipped"],
    ]);
    expect(state.reportsByStepId.get("build")).toBe(result.steps[0]);
    expect(statuses.map(({ status, step }) => `${step.id}:${status}`)).toEqual([
      "build:planned",
      "write:planned",
      "publish:planned",
      "build:running",
      "build:failed",
      "write:skipped",
      "publish:skipped",
    ]);
  });

  it("records one cancellation error while cancelling every remaining step", async () => {
    const { state, steps } = setup(["first", "second"]);
    const cancellation = testError("cancellation", "TUBELESS_RUN_CANCELLED", "first");
    state.recordRunErrors([cancellation]);
    state.cancelStep(steps[0]!, cancellation, false);
    state.cancelStep(steps[1]!, { ...cancellation, stepId: "second" }, false);

    const result = await state.finish();

    expect(result.status).toBe("cancelled");
    expect(result.errors).toEqual([cancellation]);
    expect(result.steps.map(({ id, status }) => [id, status])).toEqual([
      ["first", "cancelled"],
      ["second", "cancelled"],
    ]);
  });

  it("publishes a policy-skip value and unlocks a later completion", async () => {
    const { state, steps } = setup(["cached", "consume"]);
    state.skipStep(steps[0]!, {
      message: "already cached",
      output: { value: undefined },
      reason: "policy",
    });
    state.completeStep(steps[1]!, state.beginAttempt(steps[1]!), "consumed");
    state.beginFinalization();
    state.completeFinalization("done", 5);

    const result = await state.finish();

    expect(state.outputs.has("cached")).toBe(true);
    expect(state.outputs.get("consume")).toBe("consumed");
    expect(result).toMatchObject({ finalized: true, status: "completed", value: "done" });
    expect(result.steps[0]).toMatchObject({ reason: "policy", status: "skipped" });
  });

  it.each([
    {
      code: "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED" as const,
      kind: "validation" as const,
      name: "validation failure",
    },
    {
      code: "TUBELESS_CHILD_FAILED" as const,
      kind: "child" as const,
      name: "child failure",
    },
  ])("records a focused $name transition", async ({ code, kind }) => {
    const { state, steps } = setup(["work"]);
    const error = testError(kind, code, "work");
    state.failStep(steps[0]!, state.beginAttempt(steps[0]!), error);

    const result = await state.finish();

    expect(result).toMatchObject({
      errors: [{ code, kind }],
      status: "failed",
      steps: [{ error: { code, kind }, status: "failed" }],
    });
  });

  it("supports continue-on-error sequencing before a failed finalized run", async () => {
    const { state, steps } = setup(["optional", "independent"]);
    state.failStep(
      steps[0]!,
      state.beginAttempt(steps[0]!),
      testError("step", "TUBELESS_STEP_FAILED", "optional")
    );
    state.completeStep(steps[1]!, state.beginAttempt(steps[1]!), "kept");
    state.beginFinalization();
    state.completeFinalization("partial", 3);

    const result = await state.finish();

    expect(result).toMatchObject({ finalized: true, status: "failed", value: "partial" });
    expect(result.steps.map(({ id, status }) => [id, status])).toEqual([
      ["optional", "failed"],
      ["independent", "completed"],
    ]);
  });

  it("rejects invalid step and run transitions", async () => {
    const { state, steps } = setup(["work"]);
    expect(() =>
      state.completeStep(steps[0]!, { attemptId: "missing", startedAtMs: 0 }, "x")
    ).toThrowError("Invalid step status transition for work: planned -> completed");
    await expect(state.finish()).rejects.toThrowError(
      "Cannot finish pipeline run while step work is planned"
    );
    state.skipStep(steps[0]!, { reason: "filtered" });
    await state.finish();
    expect(() => state.beginFinalization()).toThrowError(
      "Invalid pipeline run transition: expected running, found finished"
    );
  });
});
