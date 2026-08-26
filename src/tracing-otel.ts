import type {
  PipelineTraceAttributeValue,
  PipelineTraceEvent,
  PipelineTraceExporter,
} from "./tracing.js";

// `SpanStatusCode.ERROR` from `@opentelemetry/api`. Keep the adapter
// dependency-free while using the exact numeric value the API expects.
const OPEN_TELEMETRY_ERROR_STATUS_CODE = 2;

/** Minimal structural span contract accepted by the OpenTelemetry adapter. */
export interface OpenTelemetryLikeSpan {
  addEvent(
    name: string,
    attributes?: Readonly<Record<string, PipelineTraceAttributeValue>>,
    timestampMs?: number
  ): void;
  end(timestampMs?: number): void;
  recordException?(exception: { message: string; name: string; stack?: string }): void;
  setAttribute?(name: string, value: PipelineTraceAttributeValue): void;
  setStatus?(status: { code: number; message?: string }): void;
}

/** Minimal structural tracer contract accepted by the OpenTelemetry adapter. */
export interface OpenTelemetryLikeTracer {
  startSpan(
    name: string,
    options?: {
      attributes?: Readonly<Record<string, PipelineTraceAttributeValue>>;
      startTime?: number;
    }
  ): OpenTelemetryLikeSpan;
}

/** Configuration for adapting pipeline events to application-owned spans. */
export interface OpenTelemetryTraceExporterOptions {
  /** A tracer compatible with `@opentelemetry/api`'s `Tracer` shape. */
  tracer: OpenTelemetryLikeTracer;
  /** Customize the span name for a pipeline run. */
  spanName?(event: PipelineTraceEvent): string;
}

function attributesFor(event: PipelineTraceEvent) {
  const attributes = new Map<string, PipelineTraceAttributeValue>();
  for (const [key, value] of Object.entries(event.attributes)) {
    if (value !== undefined) attributes.set(key, value);
  }
  attributes.set("pipeline.id", event.pipelineId);
  attributes.set("pipeline.item_key", event.itemKey ?? "");
  attributes.set("pipeline.parent_run_id", event.parentRunId ?? "");
  attributes.set("pipeline.run_id", event.runId);
  attributes.set("pipeline.trace_version", event.version);
  if (event.attemptId) attributes.set("pipeline.attempt_id", event.attemptId);
  if (event.stepId) attributes.set("pipeline.step_id", event.stepId);
  if (event.durationMs !== undefined) attributes.set("pipeline.duration_ms", event.durationMs);
  if (event.error?.code) attributes.set("error.code", event.error.code);
  if (event.error) attributes.set("error.message", event.error.message);
  return Object.fromEntries(attributes);
}

/**
 * Adapt structured events to OpenTelemetry without importing an OpenTelemetry
 * package. Pass a real tracer from `@opentelemetry/api` at the application edge.
 */
export function createOpenTelemetryTraceExporter(
  options: OpenTelemetryTraceExporterOptions
): PipelineTraceExporter {
  const spans = new Map<string, OpenTelemetryLikeSpan>();

  return {
    export: (event) => {
      let span = spans.get(event.runId);
      if (!span) {
        span = options.tracer.startSpan(
          options.spanName?.(event) ?? `pipeline ${event.pipelineId}`,
          {
            attributes: attributesFor(event),
            startTime: event.timestampMs,
          }
        );
        spans.set(event.runId, span);
      }

      const attributes = attributesFor(event);
      span.addEvent(event.name, attributes, event.timestampMs);
      if (event.error) {
        span.recordException?.({
          message: event.error.message,
          name: "PipelineTraceError",
          stack: event.error.stack,
        });
        span.setStatus?.({ code: OPEN_TELEMETRY_ERROR_STATUS_CODE, message: event.error.message });
      }
      if (event.name === "pipeline.completed") {
        span.end(event.timestampMs);
        spans.delete(event.runId);
      }
    },
  };
}
