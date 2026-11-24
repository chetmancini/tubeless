import { describe, expect, it, vi } from "vitest";
import type { AnyStep } from "./pipeline-steps.js";
import { executeStepAttempt } from "./pipeline-step-executor.js";
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
      pipelineId: "test",
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
});
