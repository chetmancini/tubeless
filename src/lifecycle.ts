import type {
  PipelineError,
  PipelineHooks,
  PipelineLogger,
  PipelinePlan,
  PipelineRun,
  PipelineRuntime,
  PipelineStepStatus,
} from "./pipeline.js";
import type { PipelineTraceEmitter } from "./tracing-internal.js";
import type { PipelineTraceAttributes } from "./tracing.js";

/** Internal canonical lifecycle stream. Hooks and tracing are projections of it. */
export interface PipelineLifecycleObserver {
  finalizeComplete(durationMs: number, value: unknown): void;
  finalizeError(error: PipelineError, durationMs: number): void;
  finalizeStart(): void;
  flush(): Promise<void>;
  log(
    level: "error" | "log" | "warn",
    message: unknown,
    params?: readonly unknown[],
    stepId?: string,
    attemptId?: string
  ): void;
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

export function createPipelineLifecycleObserver(
  pipelineId: string,
  runtime: PipelineRuntime,
  trace: PipelineTraceEmitter | undefined
): PipelineLifecycleObserver {
  return {
    pipelineStart(plan, targetIds) {
      emitHook(runtime, (hooks) => hooks.onPipelineStart?.(plan));
      trace?.pipelineStart(plan, targetIds);
    },
    stepStatus(event, traceStatus = true) {
      emitHook(runtime, (hooks) => hooks.onStepStatus?.(event));
      switch (event.status) {
        case "planned":
          emitHook(runtime, (hooks) => hooks.onStepPlan?.(event));
          break;
        case "running":
          if (event.progress) {
            const progress = event.progress;
            emitHook(runtime, (hooks) => hooks.onStepProgress?.({ ...event, progress }));
          } else {
            emitHook(runtime, (hooks) =>
              hooks.onStepStart?.({
                attemptId: event.attemptId,
                pipelineId: event.pipelineId,
                status: "running",
                step: event.step,
              })
            );
          }
          break;
        case "cancelled":
          emitHook(runtime, (hooks) => hooks.onStepCancel?.(event));
          break;
        case "failed":
          emitHook(runtime, (hooks) => hooks.onStepFail?.(event));
          break;
        case "skipped":
          emitHook(runtime, (hooks) => hooks.onStepSkip?.(event));
          break;
        case "completed":
          emitHook(runtime, (hooks) => hooks.onStepComplete?.(event));
          break;
      }
      if (traceStatus) trace?.stepStatus(event);
    },
    reportAttempt: (stepId, attempt, attributes, attemptId) =>
      trace?.reportAttempt(stepId, attempt, attributes, attemptId),
    log: (level, message, params, stepId, attemptId) =>
      trace?.log(level, message, params, stepId, attemptId),
    finalizeStart() {
      emitHook(runtime, (hooks) => hooks.onFinalizeStart?.({ pipelineId }));
      trace?.finalizeStart();
    },
    finalizeComplete(durationMs, value) {
      emitHook(runtime, (hooks) => hooks.onFinalizeComplete?.({ durationMs, pipelineId, value }));
      trace?.finalizeComplete(durationMs);
    },
    finalizeError(error, durationMs) {
      emitHook(runtime, (hooks) => hooks.onFinalizeError?.({ durationMs, error, pipelineId }));
      trace?.finalizeError(error, durationMs);
    },
    pipelineComplete(result) {
      emitHook(runtime, (hooks) => hooks.onPipelineComplete?.(result));
      trace?.pipelineComplete(result);
    },
    flush: () => trace?.flush() ?? Promise.resolve(),
  };
}
