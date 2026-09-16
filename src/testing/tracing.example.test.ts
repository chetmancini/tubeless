import { describe, expect, it, vi } from "vitest";
import { createOpenTelemetryExporter } from "../../examples/tracing.js";

describe("OpenTelemetry tracing recipe", () => {
  it("keeps trace identities and attempt attributes queryable", () => {
    const span = {
      addEvent: vi.fn(),
      end: vi.fn(),
      recordException: vi.fn(),
      setStatus: vi.fn(),
    };
    const tracer = { startSpan: vi.fn(() => span) };
    const exporter = createOpenTelemetryExporter(tracer);

    exporter.export({
      correlationId: "job-1",
      name: "pipeline.started",
      payload: { dryRun: false, planOk: true, stepCount: 1, targetIds: [] },
      pipelineId: "import",
      runId: "run-1",
      timestampMs: 10,
      version: 2,
    });
    exporter.export({
      attemptId: "attempt-1",
      correlationId: "job-1",
      durationMs: 3,
      itemKey: "item-1",
      name: "step.attempted",
      parentRunId: "parent-1",
      payload: { attempt: 2, attributes: { operation: "normalize", retryable: true } },
      pipelineId: "import",
      runId: "run-1",
      stepId: "fetch",
      timestampMs: 11,
      version: 2,
    });
    exporter.export({
      attemptId: "attempt-1",
      error: {
        code: "TUBELESS_STEP_FAILED",
        kind: "step",
        message: "network unavailable",
        phase: "execution",
      },
      name: "step.failed",
      payload: { status: "failed" },
      pipelineId: "import",
      runId: "run-1",
      stepId: "fetch",
      timestampMs: 12,
      version: 2,
    });
    exporter.export({
      durationMs: 5,
      name: "pipeline.completed",
      payload: {
        dryRun: false,
        errorCount: 1,
        finalized: false,
        status: "failed",
        stepCount: 1,
      },
      pipelineId: "import",
      runId: "run-1",
      timestampMs: 15,
      version: 2,
    });

    expect(tracer.startSpan).toHaveBeenCalledWith("pipeline import", {
      attributes: expect.objectContaining({
        "pipeline.correlation_id": "job-1",
        "pipeline.run_id": "run-1",
      }),
      startTime: 10,
    });
    expect(span.addEvent).toHaveBeenCalledWith(
      "step.attempted",
      expect.objectContaining({
        attempt: 2,
        operation: "normalize",
        retryable: true,
        "pipeline.attempt_id": "attempt-1",
        "pipeline.correlation_id": "job-1",
        "pipeline.duration_ms": 3,
        "pipeline.item_key": "item-1",
        "pipeline.parent_run_id": "parent-1",
        "pipeline.step_id": "fetch",
      }),
      11
    );
    expect(span.addEvent).toHaveBeenCalledWith(
      "step.failed",
      expect.objectContaining({
        "error.code": "TUBELESS_STEP_FAILED",
        "error.message": "network unavailable",
      }),
      12
    );
    expect(span.recordException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "network unavailable" })
    );
    expect(span.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "network unavailable",
    });
    expect(span.end).toHaveBeenCalledWith(15);
  });
});
