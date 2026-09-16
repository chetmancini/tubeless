import type {
  PipelineErrorCause,
  PipelineErrorCode,
  PipelineErrorKind,
  PipelineErrorPhase,
  PipelineFanOutDiagnostics,
  PipelineRunStatus,
  PipelineStepProgressDetail,
  PipelineStepSelectionReason,
  PipelineStepSkipReason,
  PipelineValidationIssue,
} from "../core/pipeline.js";
import { PartialPipelineTraceExporterError } from "./trace-exporter-error.js";

/** Values that can be safely carried in a structured trace attribute. */
export type PipelineTraceAttributeValue = boolean | number | string;

/** Additional scalar telemetry supplied by a step attempt. */
export type PipelineTraceAttributes = Readonly<
  Record<string, PipelineTraceAttributeValue | undefined>
>;

/** Stable identities propagated through a traced parent/child pipeline tree. */
export interface PipelineTraceContext {
  /** Reusable caller-owned correlation, distinct from the unique run identity. */
  correlationId?: string;
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

/** Static child-pipeline metadata retained in a planned-step trace. */
export interface PipelineTraceNestedPipeline {
  mode: "for-each" | "single";
  pipelineId: string;
  /** Original declared step count, before the bounded `stepIds` snapshot. */
  stepCount: number;
  stepIds: readonly string[];
}

/** Static remote-adapter metadata retained in a planned-step trace. */
export interface PipelineTraceRemote {
  engine: string;
  target?: string;
}

/** Bounded progress snapshot retained in a running-step trace. */
export interface PipelineTraceProgress {
  completed: number;
  /** Original detail count, before the bounded `details` snapshot. */
  detailCount?: number;
  details?: readonly PipelineStepProgressDetail[];
  message?: string;
  total?: number;
}

interface PipelineTraceEventBase extends PipelineTraceContext {
  attemptId?: string;
  durationMs?: number;
  error?: PipelineTraceError;
  pipelineId: string;
  stepId?: string;
  timestampMs: number;
  version: 2;
}

interface PipelineTraceStepEventBase extends PipelineTraceEventBase {
  /** Stable public step identity. */
  stepId: string;
}

interface PipelineTraceAttemptEventBase extends PipelineTraceStepEventBase {
  /** Stable public step-attempt identity. */
  attemptId?: string;
}

export interface PipelineStartedTraceEvent extends PipelineTraceEventBase {
  name: "pipeline.started";
  payload: {
    dryRun: boolean;
    planOk: boolean;
    stepCount: number;
    targetIds: readonly string[];
  };
}

export interface PipelineLogTraceEvent extends PipelineTraceEventBase {
  attemptId?: string;
  name: "pipeline.log";
  payload: { level: "error" | "log" | "warn"; message: string };
  stepId?: string;
}

export interface PipelineCompletedTraceEvent extends PipelineTraceEventBase {
  durationMs?: number;
  error?: PipelineTraceError;
  name: "pipeline.completed";
  payload: {
    dryRun: boolean;
    errorCount: number;
    finalized: boolean;
    status: PipelineRunStatus;
    stepCount: number;
  };
}

export interface PipelineFinalizeStartedTraceEvent extends PipelineTraceEventBase {
  name: "pipeline.finalize.started";
  payload: Readonly<Record<string, never>>;
}

export interface PipelineFinalizeCompletedTraceEvent extends PipelineTraceEventBase {
  durationMs: number;
  name: "pipeline.finalize.completed";
  payload: Readonly<Record<string, never>>;
}

export interface PipelineFinalizeFailedTraceEvent extends PipelineTraceEventBase {
  durationMs: number;
  error: PipelineTraceError;
  name: "pipeline.finalize.failed";
  payload: Readonly<Record<string, never>>;
}

export interface StepPlannedTraceEvent extends PipelineTraceStepEventBase {
  name: "step.planned";
  payload: {
    dependencies: readonly string[];
    description?: string;
    dryRun: "custom" | "run" | "skip";
    name?: string;
    nestedPipeline?: PipelineTraceNestedPipeline;
    optionalDependencies: readonly string[];
    remote?: PipelineTraceRemote;
    runtimeSkipPossible: boolean;
    selected: boolean;
    selectionReasons: readonly PipelineStepSelectionReason[];
    skipAfterFailureOf: readonly string[];
  };
}

export interface StepRunningTraceEvent extends PipelineTraceAttemptEventBase {
  attemptId: string;
  name: "step.running";
  payload: { progress?: PipelineTraceProgress };
}

export interface StepAttemptedTraceEvent extends PipelineTraceAttemptEventBase {
  name: "step.attempted";
  payload: { attempt: number; attributes: PipelineTraceAttributes };
}

export interface StepCompletedTraceEvent extends PipelineTraceAttemptEventBase {
  durationMs?: number;
  name: "step.complete";
  payload: { status: "completed" };
}

export interface StepSkippedTraceEvent extends PipelineTraceAttemptEventBase {
  durationMs?: number;
  name: "step.skipped";
  payload: {
    dependencyId?: string;
    message?: string;
    reason: PipelineStepSkipReason;
    status: "skipped";
  };
}

export interface StepCancelledTraceEvent extends PipelineTraceAttemptEventBase {
  durationMs?: number;
  error: PipelineTraceError;
  name: "step.cancelled";
  payload: { status: "cancelled" };
}

export interface StepFailedTraceEvent extends PipelineTraceAttemptEventBase {
  durationMs?: number;
  error: PipelineTraceError;
  name: "step.failed";
  payload: { status: "failed" };
}

/** A versioned lifecycle record with an event-specific, structured payload. */
export type PipelineTraceEvent =
  | PipelineCompletedTraceEvent
  | PipelineFinalizeCompletedTraceEvent
  | PipelineFinalizeFailedTraceEvent
  | PipelineFinalizeStartedTraceEvent
  | PipelineLogTraceEvent
  | PipelineStartedTraceEvent
  | StepAttemptedTraceEvent
  | StepCancelledTraceEvent
  | StepCompletedTraceEvent
  | StepFailedTraceEvent
  | StepPlannedTraceEvent
  | StepRunningTraceEvent
  | StepSkippedTraceEvent;

/** Stable lifecycle names emitted by the pipeline executor. */
export type PipelineTraceEventName = PipelineTraceEvent["name"];

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
