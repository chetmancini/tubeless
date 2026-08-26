import type { PipelineValidationIssue } from "./pipeline.js";

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
  cause?: import("./pipeline.js").PipelineErrorCause;
  code: import("./pipeline.js").PipelineErrorCode;
  kind: import("./pipeline.js").PipelineErrorKind;
  message: string;
  phase: import("./pipeline.js").PipelineErrorPhase;
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

/** Configuration supplied through `PipelineContext.tracing`. */
export interface PipelineTracingOptions {
  exporter: PipelineTraceExporter;
  itemKey?: string;
}
