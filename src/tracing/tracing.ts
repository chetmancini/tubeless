import type {
  PipelineErrorCause,
  PipelineErrorCode,
  PipelineErrorKind,
  PipelineErrorPhase,
  PipelineFanOutDiagnostics,
  PipelineValidationIssue,
} from "../core/pipeline.js";
import { PartialPipelineTraceExporterError } from "./trace-exporter-error.js";

/** Values that can be safely carried in a structured trace attribute. */
export type PipelineTraceAttributeValue = boolean | number | string;

/** Additional, serializable data attached to a trace event. */
export type PipelineTraceAttributes = Readonly<
  Record<string, PipelineTraceAttributeValue | undefined>
>;

/** Stable identities propagated through a traced parent/child pipeline tree. */
export interface PipelineTraceContext {
  itemKey?: string;
  parentRunId?: string;
  runId: string;
}

/** Structured error attributes emitted without retaining the original error object. */
export interface PipelineTraceError {
  fanOut?: PipelineFanOutDiagnostics;
  cause?: PipelineErrorCause;
  code: PipelineErrorCode;
  kind: PipelineErrorKind;
  message: string;
  phase: PipelineErrorPhase;
  issues?: readonly PipelineValidationIssue[];
  sourceCode?: string;
  stack?: string;
}

/** Stable lifecycle names emitted by the pipeline executor. */
export type PipelineTraceEventName =
  | "pipeline.completed"
  | "pipeline.log"
  | "pipeline.started"
  | "pipeline.finalize.completed"
  | "pipeline.finalize.failed"
  | "pipeline.finalize.started"
  | "step.attempted"
  | "step.cancelled"
  | "step.failed"
  | "step.planned"
  | "step.running"
  | "step.skipped"
  | "step.complete";

/** A versioned lifecycle record suitable for JSON logs and telemetry adapters. */
export interface PipelineTraceEvent extends PipelineTraceContext {
  attributes: PipelineTraceAttributes;
  /** Stable public step-attempt identity when the event belongs to an execution attempt. */
  attemptId?: string;
  durationMs?: number;
  error?: PipelineTraceError;
  name: PipelineTraceEventName;
  pipelineId: string;
  stepId?: string;
  timestampMs: number;
  version: 1;
}

/** Asynchronous boundary for trace destinations. */
export interface PipelineTraceExporter {
  export(event: PipelineTraceEvent): void | Promise<void>;
  flush?(): void | Promise<void>;
}

/**
 * Fan one trace stream out to multiple exporters. An exporter is retired after
 * its first failure so healthy destinations continue receiving later events. A
 * partial failure rejects that operation after every healthy exporter receives
 * it, allowing tracing error handlers to report the dropped destination.
 */
export function composeTraceExporters(
  exporters: readonly PipelineTraceExporter[]
): PipelineTraceExporter {
  if (exporters.length === 1) return exporters[0]!;
  const failed = new WeakSet<PipelineTraceExporter>();
  let lastError: unknown;
  let hasLastError = false;
  const invokeHealthy = async (
    invoke: (exporter: PipelineTraceExporter) => void | Promise<void>
  ): Promise<void> => {
    let succeeded = 0;
    let roundError: unknown;
    let hadRoundError = false;
    for (const exporter of exporters) {
      if (failed.has(exporter)) continue;
      try {
        await invoke(exporter);
        succeeded += 1;
      } catch (error) {
        failed.add(exporter);
        lastError = error;
        hasLastError = true;
        if (!hadRoundError) roundError = error;
        hadRoundError = true;
      }
    }
    if (hadRoundError) {
      if (succeeded > 0) {
        throw new PartialPipelineTraceExporterError({
          error: roundError,
          message: roundError instanceof Error ? roundError.message : String(roundError),
        });
      }
      throw roundError;
    }
    if (succeeded === 0 && hasLastError) throw lastError;
  };
  return {
    export(event) {
      return invokeHealthy((exporter) => exporter.export(event));
    },
    flush() {
      return invokeHealthy((exporter) => exporter.flush?.());
    },
  };
}

/** Configuration supplied through `PipelineContext.tracing`. */
export interface PipelineTracingOptions {
  exporter: PipelineTraceExporter;
  itemKey?: string;
  /**
   * Called once, on the first exporter failure of the run. The run itself is
   * not failed. A single failed exporter drops later events; a composed exporter
   * retires only the failed destination while healthy destinations continue.
   */
  readonly onExporterError?: (error: unknown) => void;
}
