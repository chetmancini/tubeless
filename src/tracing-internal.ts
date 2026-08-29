import type {
  PipelineError,
  PipelineLogger,
  PipelinePlan,
  PipelinePlanStep,
  PipelineRun,
  PipelineStepProgress,
  PipelineStepStatus,
} from "./pipeline.js";
import type {
  PipelineTraceAttributeValue,
  PipelineTraceAttributes,
  PipelineTraceContext,
  PipelineTraceEvent,
  PipelineTraceEventName,
  PipelineTraceError,
  PipelineTracingOptions,
} from "./tracing.js";

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

const TRACE_LIST_LIMIT = 128;
const TRACE_STRING_LIMIT = 4_096;
const DETAIL_STATUSES = new Set(["completed", "failed", "pending", "running", "skipped"]);

function boundTraceString(value: string): string {
  return value.length > TRACE_STRING_LIMIT ? value.slice(0, TRACE_STRING_LIMIT) : value;
}

interface SerializedProgressDetail {
  id: string;
  label?: string;
  status?: "completed" | "failed" | "pending" | "running" | "skipped";
}

function serializeProgressDetails(
  details: PipelineStepProgress["details"]
): { detail_count: number; details: string } | undefined {
  if (!details || details.length === 0) return undefined;
  const serialized = details.slice(0, TRACE_LIST_LIMIT).map((detail) => {
    const row: SerializedProgressDetail = { id: boundTraceString(detail.id) };
    if (detail.label) row.label = boundTraceString(detail.label);
    if (detail.status && DETAIL_STATUSES.has(detail.status)) row.status = detail.status;
    return row;
  });
  return {
    detail_count: details.length,
    details: JSON.stringify(serialized),
  };
}

function serializeNestedPipeline(nested: PipelinePlanStep["nestedPipeline"]): string | undefined {
  if (!nested) return undefined;
  return JSON.stringify({
    mode: nested.mode,
    pipelineId: nested.pipelineId,
    stepIds: nested.stepIds.slice(0, TRACE_LIST_LIMIT),
  });
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
  if (error.issues) traceError.issues = error.issues;
  if (error.sourceCode) traceError.sourceCode = error.sourceCode;
  return traceError;
}

function elapsedMs(record: { finishedAtMs: number; startedAtMs?: number }): number | undefined {
  return record.startedAtMs === undefined ? undefined : record.finishedAtMs - record.startedAtMs;
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

  const emit = (
    name: PipelineTraceEventName,
    fields: Omit<
      PipelineTraceEvent,
      "name" | "timestampMs" | "version" | keyof PipelineTraceContext
    >
  ): void => {
    const event: PipelineTraceEvent = {
      ...context,
      ...fields,
      attributes: compactAttributes(fields.attributes),
      name,
      timestampMs: now(),
      version: 1,
    };
    queue = queue
      .then(() => options.exporter.export(event))
      .catch((error) => {
        log.warn(
          `Pipeline trace exporter failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  };

  type EmitFields = Parameters<typeof emit>[1];

  return {
    context,
    pipelineStart: (plan, targetIds = []) =>
      emit("pipeline.started", {
        attributes: {
          dry_run: plan.dryRun,
          plan_ok: plan.ok,
          step_count: plan.steps.length,
          target_ids: JSON.stringify(targetIds),
        },
        pipelineId,
      }),
    log: (level, message, params = [], stepId, attemptId) => {
      const fields: EmitFields = {
        attributes: {
          level,
          message: [message, ...params].map(formatLogValue).join(" "),
        },
        pipelineId,
      };
      if (attemptId) fields.attemptId = attemptId;
      if (stepId) fields.stepId = stepId;
      emit("pipeline.log", fields);
    },
    pipelineComplete: (result) =>
      emit("pipeline.completed", {
        attributes: {
          dry_run: result.dryRun,
          error_count: result.errors.length,
          finalized: result.finalized,
          status: result.status,
          step_count: result.steps.length,
        },
        durationMs: elapsedMs(result),
        error: toTraceError(result.errors[0]),
        pipelineId,
      }),
    stepStatus: (event) => {
      if (event.status === "planned") {
        emit("step.planned", {
          attributes: {
            dependencies: JSON.stringify(event.step.dependencies),
            description: event.step.description,
            dry_run: event.step.dryRun,
            name: event.step.name,
            nested_pipeline: serializeNestedPipeline(event.step.nestedPipeline),
            optional_dependencies: JSON.stringify(event.step.optionalDependencies),
            runtime_skip_possible: event.step.runtimeSkipPossible,
            selected: event.step.selected,
            selection_reasons: JSON.stringify(event.step.selectionReasons),
            skip_after_failure_of: JSON.stringify(event.step.skipAfterFailureOf),
          },
          pipelineId,
          stepId: event.step.id,
        });
        return;
      }
      if (event.status === "running") {
        emit("step.running", {
          attributes: event.progress
            ? {
                completed: event.progress.completed,
                ...(serializeProgressDetails(event.progress.details) ?? {}),
                message: event.progress.message,
                total: event.progress.total,
              }
            : {},
          attemptId: event.attemptId,
          pipelineId,
          stepId: event.step.id,
        });
        return;
      }
      if (event.status === "complete") {
        const fields: EmitFields = {
          attributes: { status: event.status },
          durationMs: elapsedMs(event),
          pipelineId,
          stepId: event.id,
        };
        if (event.attemptId) fields.attemptId = event.attemptId;
        emit("step.complete", fields);
        return;
      }
      if (event.status === "skipped") {
        const fields: EmitFields = {
          attributes: {
            dependency_id: event.dependencyId,
            message: event.message,
            reason: event.reason,
            status: event.status,
          },
          durationMs: elapsedMs(event),
          pipelineId,
          stepId: event.id,
        };
        if (event.attemptId) fields.attemptId = event.attemptId;
        emit("step.skipped", fields);
        return;
      }
      const fields: EmitFields = {
        attributes: { status: event.status },
        durationMs: elapsedMs(event),
        error: toTraceError(event.error),
        pipelineId,
        stepId: event.id,
      };
      if (event.attemptId) fields.attemptId = event.attemptId;
      emit(event.status === "cancelled" ? "step.cancelled" : "step.failed", fields);
    },
    reportAttempt: (stepId, attempt, attributes = {}, attemptId) => {
      const fields: EmitFields = {
        attributes: { ...attributes, attempt },
        pipelineId,
        stepId,
      };
      if (attemptId) fields.attemptId = attemptId;
      emit("step.attempted", fields);
    },
    finalizeStart: () => emit("pipeline.finalize.started", { attributes: {}, pipelineId }),
    finalizeComplete: (durationMs) =>
      emit("pipeline.finalize.completed", { attributes: {}, durationMs, pipelineId }),
    finalizeError: (error, durationMs) =>
      emit("pipeline.finalize.failed", {
        attributes: {},
        durationMs,
        error: toTraceError(error),
        pipelineId,
      }),
    flush: async () => {
      await queue;
      try {
        await options.exporter.flush?.();
      } catch (error) {
        log.warn(
          `Pipeline trace exporter flush failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  };
}
