import { describe, expect, it, vi } from "vitest";
import type { AnyStep } from "./pipeline-steps.js";
import {
  evaluateStepSkip,
  executeStepAttempt,
  validateStepOutput,
} from "./pipeline-step-executor.js";
import { PipelineBoundaryValidationError } from "./pipeline-validation.js";
import type { PipelineExecutionContext, StandardSchemaV1 } from "./pipeline-types.js";

const log = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
const context: PipelineExecutionContext<{ mode: string }> = {
  cwd: "/tmp",
  dryRun: false,
  log,
  now: () => 0,
  options: { mode: "test" },
  runId: "run-test",
  sleep: () => Promise.resolve(),
};

describe("pipeline step executor", () => {
  it("invokes a handler, reports live progress, and validates its published output", async () => {
    let lateProgress!: () => void;
    const outputSchema: StandardSchemaV1<string, number> = {
      "~standard": {
        validate: (value) => ({ value: Number(value) }),
        vendor: "test",
        version: 1,
      },
    };
    const step: AnyStep<{ mode: string }> = {
      id: "work",
      outputSchema,
      run: (_inputs, stepContext) => {
        expect(stepContext.options.mode).toBe("test");
        stepContext.reportProgress({ completed: 1, total: 2 });
        lateProgress = () => stepContext.reportProgress({ completed: 2, total: 2 });
        return "42";
      },
    };
    const progress = vi.fn();

    const output = await executeStepAttempt({
      attemptId: "attempt-1",
      context,
      dryRun: false,
      inputs: {},
      log,
      onProgress: progress,
      onReportAttempt: vi.fn(),
      outputBoundary: "work output",
      step,
    });
    lateProgress();

    expect(output).toBe(42);
    expect(progress).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith({ completed: 1, total: 2 });
  });

  it("uses the dry-run handler without invoking the live handler", async () => {
    const run = vi.fn(() => "live");
    const dryRun = vi.fn(() => "preview");
    const step: AnyStep<{ mode: string }> = { dryRun, id: "write", run };

    const output = await executeStepAttempt({
      attemptId: "attempt-1",
      context: { ...context, dryRun: true },
      dryRun: true,
      inputs: {},
      log,
      onProgress: vi.fn(),
      onReportAttempt: vi.fn(),
      outputBoundary: "write output",
      step,
    });

    expect(output).toBe("preview");
    expect(dryRun).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("normalizes policy decisions independently from orchestration", async () => {
    const step: AnyStep<{ mode: string }> = {
      id: "cached",
      run: () => "live",
      skip: () => ({ reason: "  already cached  ", value: "cached" }),
    };

    await expect(evaluateStepSkip(step, {}, context)).resolves.toEqual({
      reason: "already cached",
      value: "cached",
    });
  });

  it("surfaces output validation failures to the run orchestrator", async () => {
    const step: AnyStep = {
      id: "invalid",
      outputSchema: {
        "~standard": {
          validate: () => ({ issues: [{ message: "Expected a number", path: ["value"] }] }),
          vendor: "test",
          version: 1,
        },
      },
      run: () => "invalid",
    };

    await expect(validateStepOutput(step, "invalid", "invalid output")).rejects.toMatchObject({
      issues: [{ message: "Expected a number", path: ["value"] }],
      name: PipelineBoundaryValidationError.name,
    });
  });
});
