import type {
  PipelineError,
  PipelineLogger,
  PipelinePlan,
  PipelinePlanStep,
  PipelineRun,
  PipelineStepProgress,
  PipelineStepProgressDetail,
  PipelineStepStatus,
} from "../core/pipeline.js";
import type {
  PipelineTraceAttributeValue,
  PipelineTraceAttributes,
  PipelineTraceContext,
  PipelineTraceEvent,
  PipelineTraceError,
  PipelineTraceNestedPipeline,
  PipelineTraceProgress,
  PipelineTraceRemote,
  PipelineTracingOptions,
} from "./tracing.js";
import {
  PIPELINE_TRACE_DETAIL_BYTE_LIMIT,
  PIPELINE_TRACE_LIST_LIMIT,
  PIPELINE_TRACE_STRING_LIMIT,
  PIPELINE_TRACE_VERSION,
} from "./tracing-constants.js";
import { decodePipelineTraceEvent } from "./tracing-codec.js";
import { PARTIAL_PIPELINE_TRACE_EXPORTER_ERROR } from "./trace-exporter-error.js";

/** Runtime trace writer used internally by the pipeline executor. */
export interface PipelineTraceEmitter {
  readonly context: PipelineTraceContext;
  flush(): Promise<void>;
  log(
    level: "error" | "log" | "warn",
    message: unknown,
    params?: readonly unknown[],
    stepId?: string,
    attemptId?: string
  ): void;
  pipelineComplete(result: PipelineRun<unknown>): void;
  pipelineStart(plan: PipelinePlan, targetIds?: readonly string[]): void;
  reportAttempt(
    stepId: string,
    attempt: number,
    attributes?: PipelineTraceAttributes,
    attemptId?: string
  ): void;
  stepStatus(event: PipelineStepStatus): void;
  finalizeComplete(durationMs: number): void;
  finalizeError(error: PipelineError, durationMs: number): void;
  finalizeStart(): void;
}

function compactAttributes(
  attributes: PipelineTraceAttributes = {}
): Record<string, PipelineTraceAttributeValue> {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, PipelineTraceAttributeValue] => entry[1] !== undefined
    )
  );
}

const traceEncoder = new TextEncoder();
const DETAIL_STATUSES = new Set([
  "cancelled",
  "completed",
  "failed",
  "pending",
  "running",
  "skipped",
]);

function boundTraceString(value: string): string {
  return value.length > PIPELINE_TRACE_STRING_LIMIT
    ? value.slice(0, PIPELINE_TRACE_STRING_LIMIT)
    : value;
}

function traceProgress(
  details: PipelineStepProgress["details"]
): Pick<PipelineTraceProgress, "detailCount" | "details"> | undefined {
  if (!details || details.length === 0) return undefined;
  const retained: PipelineStepProgressDetail[] = [];
  for (const detail of details.slice(0, PIPELINE_TRACE_LIST_LIMIT)) {
    const row: PipelineStepProgressDetail = { id: boundTraceString(detail.id) };
    if (detail.name) row.name = boundTraceString(detail.name);
    for (const key of ["depth", "completed", "total"] as const) {
      if (Number.isFinite(detail[key])) row[key] = detail[key];
    }
    if (detail.label) row.label = boundTraceString(detail.label);
    if (detail.status && DETAIL_STATUSES.has(detail.status)) row.status = detail.status;
    const next = [...retained, row];
    if (traceEncoder.encode(JSON.stringify(next)).byteLength > PIPELINE_TRACE_DETAIL_BYTE_LIMIT) {
      break;
    }
    retained.push(row);
  }
  return {
    detailCount: details.length,
    details: retained,
  };
}

function traceNestedPipeline(
  nested: PipelinePlanStep["nestedPipeline"]
): PipelineTraceNestedPipeline | undefined {
  if (!nested) return undefined;
  return {
    mode: nested.mode,
    pipelineId: nested.pipelineId,
    stepCount: nested.stepIds.length,
    stepIds: nested.stepIds.slice(0, PIPELINE_TRACE_LIST_LIMIT),
  };
}

function traceRemote(remote: PipelinePlanStep["remote"]): PipelineTraceRemote | undefined {
  if (!remote) return undefined;
  if (remote.target) {
    return {
      engine: boundTraceString(remote.engine),
      target: boundTraceString(remote.target),
    };
  }
  return { engine: boundTraceString(remote.engine) };
}

function toTraceError(error: PipelineError | undefined): PipelineTraceError | undefined {
  if (!error) return undefined;
  const traceError: PipelineTraceError = {
    code: error.code,
    kind: error.kind,
    message: error.message,
    phase: error.phase,
    stack: error.stack,
  };
  if (error.cause) traceError.cause = error.cause;
  if (error.fanOut) traceError.fanOut = error.fanOut;
  if (error.issues) traceError.issues = error.issues;
  if (error.sourceCode) traceError.sourceCode = error.sourceCode;
  return traceError;
}

function elapsedMs(record: { finishedAtMs: number; startedAtMs?: number }): number | undefined {
  return record.startedAtMs === undefined ? undefined : record.finishedAtMs - record.startedAtMs;
}

function isPartialExporterError(error: unknown): error is { readonly exporterError: unknown } {
  if (typeof error !== "object" || error === null || !("exporterError" in error)) return false;
  const marker = Object.getOwnPropertyDescriptor(error, PARTIAL_PIPELINE_TRACE_EXPORTER_ERROR);
  return marker !== undefined && "value" in marker && marker.value === true;
}

function formatLogValue(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.message;
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}

/**
 * Creates a serializing, failure-isolated trace emitter for one pipeline run.
 * The executor owns this lifecycle; callers configure it via `context.tracing`.
 */
export function createPipelineTraceEmitter(
  pipelineId: string,
  options: PipelineTracingOptions | undefined,
  log: Pick<PipelineLogger, "warn">,
  identity: PipelineTraceContext,
  now: () => number
): PipelineTraceEmitter | undefined {
  if (!options) return undefined;

  const context: PipelineTraceContext = identity;
  let queue = Promise.resolve();
  let sawExporterError = false;
  let stopExporting = false;

  const formatExporterError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  const warnCallbackError = (callbackError: unknown): void => {
    log.warn(`Pipeline trace onExporterError failed: ${formatExporterError(callbackError)}`);
  };

  const captureExporterError = (error: unknown, message: string, terminal: boolean): void => {
    if (terminal) stopExporting = true;
    if (!sawExporterError) {
      sawExporterError = true;
      log.warn(message);
      if (!options.onExporterError) return;
      try {
        void Promise.resolve(options.onExporterError(error)).catch(warnCallbackError);
      } catch (callbackError) {
        warnCallbackError(callbackError);
      }
    }
  };

  type PipelineTraceEmission = PipelineTraceEvent extends infer TEvent
    ? TEvent extends PipelineTraceEvent
      ? Omit<TEvent, "timestampMs" | "version" | keyof PipelineTraceContext>
      : never
    : never;

  const emit = (fields: PipelineTraceEmission): void => {
    const encoded = {
      ...context,
      ...fields,
      timestampMs: now(),
      version: PIPELINE_TRACE_VERSION,
    };
    queue = queue
      .then(() => {
        if (stopExporting) return;
        return options.exporter.export(decodePipelineTraceEvent(encoded));
      })
      .catch((error) => {
        const partial = isPartialExporterError(error);
        const exporterError = partial ? error.exporterError : error;
        captureExporterError(
          exporterError,
          partial
            ? `Pipeline trace exporter failed; the destination was retired while healthy exporters continue: ${formatExporterError(exporterError)}`
            : `Pipeline trace exporter failed; further trace events for this run will be dropped: ${formatExporterError(exporterError)}`,
          !partial
        );
      });
  };

  return {
    context,
    pipelineStart: (plan, targetIds = []) =>
      emit({
        name: "pipeline.started",
        payload: {
          dryRun: plan.dryRun,
          planOk: plan.ok,
          stepCount: plan.steps.length,
          targetIds: targetIds.slice(0, PIPELINE_TRACE_LIST_LIMIT),
        },
        pipelineId,
      }),
    log: (level, message, params = [], stepId, attemptId) => {
      const fields: Extract<PipelineTraceEmission, { name: "pipeline.log" }> = {
        name: "pipeline.log",
        payload: { level, message: [message, ...params].map(formatLogValue).join(" ") },
        pipelineId,
      };
      if (attemptId) fields.attemptId = attemptId;
      if (stepId) fields.stepId = stepId;
      emit(fields);
    },
    pipelineComplete: (result) =>
      emit({
        name: "pipeline.completed",
        payload: {
          dryRun: result.dryRun,
          errorCount: result.errors.length,
          finalized: result.finalized,
          status: result.status,
          stepCount: result.steps.length,
        },
        durationMs: elapsedMs(result),
        error: toTraceError(result.errors[0]),
        pipelineId,
      }),
    stepStatus: (event) => {
      if (event.status === "planned") {
        emit({
          name: "step.planned",
          payload: {
            dependencies: event.step.dependencies.slice(0, PIPELINE_TRACE_LIST_LIMIT),
            description: event.step.description,
            dryRun: event.step.dryRun,
            name: event.step.name,
            nestedPipeline: traceNestedPipeline(event.step.nestedPipeline),
            remote: traceRemote(event.step.remote),
            optionalDependencies: event.step.optionalDependencies.slice(
              0,
              PIPELINE_TRACE_LIST_LIMIT
            ),
            runtimeSkipPossible: event.step.runtimeSkipPossible,
            selected: event.step.selected,
            selectionReasons: event.step.selectionReasons.slice(0, PIPELINE_TRACE_LIST_LIMIT),
            skipAfterFailureOf: event.step.skipAfterFailureOf.slice(0, PIPELINE_TRACE_LIST_LIMIT),
          },
          pipelineId,
          stepId: event.step.id,
        });
        return;
      }
      if (event.status === "running") {
        emit({
          name: "step.running",
          payload: event.progress
            ? {
                progress: {
                  completed: event.progress.completed,
                  ...(traceProgress(event.progress.details) ?? {}),
                  message: event.progress.message,
                  total: event.progress.total,
                },
              }
            : {},
          attemptId: event.attemptId,
          pipelineId,
          stepId: event.step.id,
        });
        return;
      }
      if (event.status === "completed") {
        const fields: Extract<PipelineTraceEmission, { name: "step.complete" }> = {
          name: "step.complete",
          payload: { status: event.status },
          durationMs: elapsedMs(event),
          pipelineId,
          stepId: event.id,
        };
        if (event.attemptId) fields.attemptId = event.attemptId;
        emit(fields);
        return;
      }
      if (event.status === "skipped") {
        const fields: Extract<PipelineTraceEmission, { name: "step.skipped" }> = {
          name: "step.skipped",
          payload: {
            dependencyId: event.dependencyId,
            message: event.message,
            reason: event.reason,
            status: event.status,
          },
          durationMs: elapsedMs(event),
          pipelineId,
          stepId: event.id,
        };
        if (event.attemptId) fields.attemptId = event.attemptId;
        emit(fields);
        return;
      }
      const error = toTraceError(event.error);
      if (!error) throw new Error("A failed or cancelled step trace requires an error.");
      if (event.status === "cancelled") {
        const fields: Extract<PipelineTraceEmission, { name: "step.cancelled" }> = {
          name: "step.cancelled",
          payload: { status: "cancelled" },
          durationMs: elapsedMs(event),
          error,
          pipelineId,
          stepId: event.id,
        };
        if (event.attemptId) fields.attemptId = event.attemptId;
        emit(fields);
        return;
      }
      const fields: Extract<PipelineTraceEmission, { name: "step.failed" }> = {
        name: "step.failed",
        payload: { status: "failed" },
        durationMs: elapsedMs(event),
        error,
        pipelineId,
        stepId: event.id,
      };
      if (event.attemptId) fields.attemptId = event.attemptId;
      emit(fields);
    },
    reportAttempt: (stepId, attempt, attributes = {}, attemptId) => {
      const fields: Extract<PipelineTraceEmission, { name: "step.attempted" }> = {
        name: "step.attempted",
        payload: { attempt, attributes: compactAttributes(attributes) },
        pipelineId,
        stepId,
      };
      if (attemptId) fields.attemptId = attemptId;
      emit(fields);
    },
    finalizeStart: () => emit({ name: "pipeline.finalize.started", payload: {}, pipelineId }),
    finalizeComplete: (durationMs) =>
      emit({
        durationMs,
        name: "pipeline.finalize.completed",
        payload: {},
        pipelineId,
      }),
    finalizeError: (error, durationMs) =>
      emit({
        durationMs,
        error: toTraceError(error)!,
        name: "pipeline.finalize.failed",
        payload: {},
        pipelineId,
      }),
    flush: async () => {
      await queue;
      try {
        await options.exporter.flush?.();
      } catch (error) {
        const partial = isPartialExporterError(error);
        const exporterError = partial ? error.exporterError : error;
        captureExporterError(
          exporterError,
          partial
            ? `Pipeline trace exporter flush failed for a retired destination: ${formatExporterError(exporterError)}`
            : `Pipeline trace exporter flush failed: ${formatExporterError(exporterError)}`,
          !partial
        );
      }
    },
  };
}
