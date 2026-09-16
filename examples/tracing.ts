import { createSteps, definePipeline } from "tubeless";
import { withRetry } from "tubeless/retry";
import {
  composeTraceExporters,
  type PipelineTraceEvent,
  type PipelineTraceExporter,
} from "tubeless/tracing";

/** Application-owned JSON adapter; `tubeless run --trace` owns file output. */
export function createJsonExporter(write: (line: string) => void): PipelineTraceExporter {
  return { export: (event) => write(JSON.stringify(event)) };
}

interface OpenTelemetrySpan {
  addEvent(
    name: string,
    attributes: Record<string, boolean | number | string>,
    timestampMs?: number
  ): void;
  end(timestampMs?: number): void;
  recordException?(exception: { message: string; name: string; stack?: string }): void;
  setStatus?(status: { code: number; message?: string }): void;
}

interface OpenTelemetryTracer {
  startSpan(
    name: string,
    options: { attributes: Record<string, boolean | number | string>; startTime: number }
  ): OpenTelemetrySpan;
}

// `SpanStatusCode.ERROR` from `@opentelemetry/api` without adding the SDK here.
const OPEN_TELEMETRY_ERROR_STATUS_CODE = 2;

/** Application-edge OpenTelemetry adapter without coupling Tubeless to its SDK. */
export function createOpenTelemetryExporter(tracer: OpenTelemetryTracer): PipelineTraceExporter {
  const spans = new Map<string, OpenTelemetrySpan>();
  const attributes = (event: PipelineTraceEvent): Record<string, boolean | number | string> => {
    const values = new Map<string, boolean | number | string>();
    if (event.name === "step.attempted") {
      for (const [key, value] of Object.entries(event.payload.attributes)) {
        if (value !== undefined) values.set(key, value);
      }
    }
    for (const [key, value] of Object.entries(event.payload)) {
      if (value === undefined || key === "attributes") continue;
      const telemetryKey = key.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      values.set(
        telemetryKey,
        typeof value === "boolean" || typeof value === "number" || typeof value === "string"
          ? value
          : JSON.stringify(value)
      );
    }
    values.set("pipeline.correlation_id", event.correlationId ?? "");
    values.set("pipeline.id", event.pipelineId);
    values.set("pipeline.item_key", event.itemKey ?? "");
    values.set("pipeline.parent_run_id", event.parentRunId ?? "");
    values.set("pipeline.run_id", event.runId);
    values.set("pipeline.trace_version", event.version);
    if (event.attemptId) values.set("pipeline.attempt_id", event.attemptId);
    if (event.stepId) values.set("pipeline.step_id", event.stepId);
    if (event.durationMs !== undefined) values.set("pipeline.duration_ms", event.durationMs);
    if (event.error?.code) values.set("error.code", event.error.code);
    if (event.error) values.set("error.message", event.error.message);
    return Object.fromEntries(values);
  };
  return {
    export(event) {
      let span = spans.get(event.runId);
      if (!span) {
        span = tracer.startSpan(`pipeline ${event.pipelineId}`, {
          attributes: attributes(event),
          startTime: event.timestampMs,
        });
        spans.set(event.runId, span);
      }
      span.addEvent(event.name, attributes(event), event.timestampMs);
      if (event.error) {
        span.recordException?.({
          message: event.error.message,
          name: "PipelineTraceError",
          stack: event.error.stack,
        });
        span.setStatus?.({
          code: OPEN_TELEMETRY_ERROR_STATUS_CODE,
          message: event.error.message,
        });
      }
      if (event.name === "pipeline.completed") {
        span.end(event.timestampMs);
        spans.delete(event.runId);
      }
    },
  };
}

interface TracingExampleOptions {
  rows: readonly string[];
}

const step = createSteps<TracingExampleOptions>();
const normalize = step("normalize", {
  run: async (_inputs, context) =>
    withRetry(
      async ({ attempt }) => {
        context.reportAttempt(attempt, { operation: "normalize" });
        return context.options.rows.map((row) => row.trim().toLowerCase());
      },
      { baseDelayMs: 0, maxAttempts: 1 }
    ),
});

export const TracingExamplePipeline = definePipeline({
  id: "tracing-example",
  steps: [normalize],
  finalize: (outputs) => outputs.normalize ?? [],
});

export async function runTracingExample(
  rows: readonly string[],
  additionalExporters: readonly PipelineTraceExporter[] = []
): Promise<readonly string[]> {
  return TracingExamplePipeline.runOrThrow({ rows }, undefined, {
    tracing: {
      exporter: composeTraceExporters([
        createJsonExporter((line) => console.log(line)),
        ...additionalExporters,
      ]),
      onExporterError: (error) => {
        console.warn("trace export failed", error instanceof Error ? error.message : error);
      },
    },
  });
}
