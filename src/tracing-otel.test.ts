import { describe, expect, it, vi } from "vitest";
import { createOpenTelemetryTraceExporter } from "./tracing-otel.js";

// Mirrors the numeric enum shape of `@opentelemetry/api` without making this
// dependency-free package test suite install OpenTelemetry itself.
enum SpanStatusCode {
  UNSET,
  OK,
  ERROR,
}

describe("createOpenTelemetryTraceExporter", () => {
  it("creates a pipeline span, records lifecycle events, and ends it", () => {
    const span = {
      addEvent: vi.fn(),
      end: vi.fn(),
      recordException: vi.fn(),
      setStatus: vi.fn(),
    };
    const tracer: {
      startSpan: (
        name: string,
        options?: {
          attributes?: Readonly<Record<string, boolean | number | string>>;
          startTime?: number;
        }
      ) => {
        addEvent: typeof span.addEvent;
        end: typeof span.end;
        recordException: typeof span.recordException;
        setStatus: (status: { code: SpanStatusCode; message?: string }) => unknown;
      };
    } = {
      startSpan: vi.fn(() => span),
    };
    const exporter = createOpenTelemetryTraceExporter({ tracer });

    exporter.export({
      attributes: { dry_run: false },
      name: "pipeline.started",
      pipelineId: "import",
      runId: "run-1",
      timestampMs: 10,
      version: 1,
    });
    exporter.export({
      attemptId: "run-1:attempt:1",
      attributes: {},
      error: {
        // SAFETY: fixture uses a non-kernel code the exporter should copy onto
        // the OTEL event; PipelineTraceError.code is the closed union.
        code: "NETWORK" as import("./pipeline.js").PipelineErrorCode,
        kind: "step",
        message: "network unavailable",
        phase: "execution",
      },
      name: "step.failed",
      pipelineId: "import",
      runId: "run-1",
      stepId: "fetch",
      timestampMs: 12,
      version: 1,
    });
    exporter.export({
      attributes: { ok: false },
      durationMs: 5,
      name: "pipeline.completed",
      pipelineId: "import",
      runId: "run-1",
      timestampMs: 15,
      version: 1,
    });

    expect(tracer.startSpan).toHaveBeenCalledWith("pipeline import", {
      attributes: expect.objectContaining({ "pipeline.run_id": "run-1" }),
      startTime: 10,
    });
    expect(span.addEvent).toHaveBeenCalledWith(
      "step.failed",
      expect.objectContaining({
        "error.code": "NETWORK",
        "pipeline.attempt_id": "run-1:attempt:1",
        "pipeline.step_id": "fetch",
      }),
      12
    );
    expect(span.recordException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "network unavailable" })
    );
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "network unavailable",
    });
    expect(span.end).toHaveBeenCalledWith(15);
  });
});
