import type {
  PipelineError,
  PipelineHooks,
  PipelineLogger,
  PipelinePlan,
  PipelineRun,
  PipelineRuntime,
  PipelineStepStatus,
} from "./pipeline-types.js";
import { createPipelineTraceEmitter } from "../tracing/tracing-internal.js";
import type {
  PipelineTraceAttributes,
  PipelineTraceContext,
} from "../tracing/tracing-contracts.js";

/** Internal canonical lifecycle stream. Hooks and tracing are projections of it. */
export interface PipelineLifecycleObserver {
  readonly traceContext: PipelineTraceContext | undefined;
  finalizeComplete(durationMs: number, value: unknown): void;
  finalizeError(error: PipelineError, durationMs: number): void;
  finalizeStart(): void;
  flush(): Promise<void>;
  logger(stepId?: string, attemptId?: string): PipelineLogger;
  pipelineComplete(result: PipelineRun<unknown>): void;
  pipelineStart(plan: PipelinePlan, targetIds: readonly string[]): void;
  reportAttempt(
    stepId: string,
    attempt: number,
    attributes?: PipelineTraceAttributes,
    attemptId?: string
  ): void;
  stepStatus(event: PipelineStepStatus, trace?: boolean): void;
}

const PIPELINE_LOGGER_BASE = Symbol("pipelineLoggerBase");

type TracedPipelineLogger = PipelineLogger & { [PIPELINE_LOGGER_BASE]?: PipelineLogger };

function basePipelineLogger(log: PipelineLogger): PipelineLogger {
  // SAFETY: the optional symbol exists only on loggers created by this module.
  return (log as TracedPipelineLogger)[PIPELINE_LOGGER_BASE] ?? log;
}

function emitHook(runtime: PipelineRuntime, emit: (hooks: PipelineHooks) => void): void {
  if (!runtime.hooks) return;
  const hookSets = Array.isArray(runtime.hooks) ? runtime.hooks : [runtime.hooks];
  for (const hooks of hookSets) {
    try {
      emit(hooks);
    } catch (error) {
      runtime.log.warn(
        `Pipeline hook failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

function snapshotRun(result: PipelineRun<unknown>): PipelineRun<unknown> {
  if (!result.finalized) return structuredClone(result);
  // Domain results may contain functions or class instances. Only lifecycle
  // metadata belongs to Tubeless; preserve the domain value's identity.
  const { value, ...metadata } = result;
  return { ...structuredClone(metadata), value };
}

export function createPipelineLifecycleObserver(
  pipelineId: string,
  runtime: PipelineRuntime,
  identity: PipelineTraceContext
): PipelineLifecycleObserver {
  const base = basePipelineLogger(runtime.log);
  const trace = createPipelineTraceEmitter(
    pipelineId,
    runtime.tracing,
    base,
    identity,
    runtime.now
  );
  return {
    traceContext: trace?.context,
    logger(stepId, attemptId) {
      if (!trace) return runtime.log;
      // A child run inherits its parent's logger, but owns its own trace events.
      const log: TracedPipelineLogger = {
        error: (message, ...params) => {
          trace.log("error", message, params, stepId, attemptId);
          base.error(message, ...params);
        },
        log: (message, ...params) => {
          trace.log("log", message, params, stepId, attemptId);
          base.log(message, ...params);
        },
        warn: (message, ...params) => {
          trace.log("warn", message, params, stepId, attemptId);
          base.warn(message, ...params);
        },
      };
      log[PIPELINE_LOGGER_BASE] = base;
      return log;
    },
    pipelineStart(plan, targetIds) {
      emitHook(runtime, (hooks) => hooks.onPipelineStart?.(structuredClone(plan)));
      trace?.pipelineStart(plan, targetIds);
    },
    stepStatus(event, traceStatus = true) {
      emitHook(runtime, (hooks) => hooks.onStepStatus?.(structuredClone(event)));
      switch (event.status) {
        case "planned":
          emitHook(runtime, (hooks) => hooks.onStepPlan?.(structuredClone(event)));
          break;
        case "running":
          if (event.progress) {
            const progress = event.progress;
            emitHook(runtime, (hooks) =>
              hooks.onStepProgress?.(structuredClone({ ...event, progress }))
            );
          } else {
            emitHook(runtime, (hooks) =>
              hooks.onStepStart?.({
                attemptId: event.attemptId,
                pipelineId: event.pipelineId,
                status: "running",
                step: structuredClone(event.step),
              })
            );
          }
          break;
        case "cancelled":
          emitHook(runtime, (hooks) => hooks.onStepCancel?.(structuredClone(event)));
          break;
        case "failed":
          emitHook(runtime, (hooks) => hooks.onStepFail?.(structuredClone(event)));
          break;
        case "skipped":
          emitHook(runtime, (hooks) => hooks.onStepSkip?.(structuredClone(event)));
          break;
        case "completed":
          emitHook(runtime, (hooks) => hooks.onStepComplete?.(structuredClone(event)));
          break;
      }
      if (traceStatus) trace?.stepStatus(event);
    },
    reportAttempt: (stepId, attempt, attributes, attemptId) =>
      trace?.reportAttempt(stepId, attempt, attributes, attemptId),
    finalizeStart() {
      emitHook(runtime, (hooks) => hooks.onFinalizeStart?.({ pipelineId }));
      trace?.finalizeStart();
    },
    finalizeComplete(durationMs, value) {
      emitHook(runtime, (hooks) => hooks.onFinalizeComplete?.({ durationMs, pipelineId, value }));
      trace?.finalizeComplete(durationMs);
    },
    finalizeError(error, durationMs) {
      emitHook(runtime, (hooks) =>
        hooks.onFinalizeError?.({ durationMs, error: structuredClone(error), pipelineId })
      );
      trace?.finalizeError(error, durationMs);
    },
    pipelineComplete(result) {
      emitHook(runtime, (hooks) => hooks.onPipelineComplete?.(snapshotRun(result)));
      trace?.pipelineComplete(result);
    },
    flush: () => trace?.flush() ?? Promise.resolve(),
  };
}

/** Same start/complete projection executePlannedRun uses for an invalid plan. */
export async function emitRejectedPlanLifecycle(
  pipelineId: string,
  targetIds: readonly string[],
  plan: PipelinePlan,
  runtime: PipelineRuntime,
  result: PipelineRun<unknown>
): Promise<void> {
  const identity: PipelineTraceContext = { runId: result.runId };
  if (result.correlationId !== undefined) identity.correlationId = result.correlationId;
  if (result.parentRunId) identity.parentRunId = result.parentRunId;
  if (runtime.tracing?.itemKey) identity.itemKey = runtime.tracing.itemKey;
  const lifecycle = createPipelineLifecycleObserver(pipelineId, runtime, identity);
  lifecycle.pipelineStart(plan, targetIds);
  lifecycle.pipelineComplete(result);
  await lifecycle.flush();
}
