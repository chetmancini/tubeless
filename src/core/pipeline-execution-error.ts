import { isAbortError } from "../utilities/abort.js";
import { brandTubelessError } from "../utilities/tubeless-error.js";
import { formatPipelineError } from "./pipeline-diagnostics.js";
import { PIPELINE_FINALIZE_STEP_ID } from "./pipeline-step-metadata.js";
import type {
  PipelineError,
  PipelineErrorCause,
  PipelineRun,
  PipelineRuntime,
} from "./pipeline-types.js";
import { PipelineBoundaryValidationError } from "./pipeline-validation.js";

export function isCancellationOnly(errors: readonly PipelineError[]): boolean {
  return errors.length > 0 && errors.every(({ kind }) => kind === "cancellation");
}

export class PipelineChildError extends Error {
  constructor(
    message: string,
    readonly cancelled = false,
    cause?: unknown,
    readonly fanOut?: {
      failures: readonly { error: Error; key: string; index: number; cancelled: boolean }[];
      failureCount: number;
      schedulerError?: Error;
    }
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PipelineChildError";
  }
}

const originalPipelineErrors = new WeakMap<PipelineError, unknown>();

function defaultExecutionErrorMessage(result: PipelineRun<unknown>): string {
  const firstError = result.errors[0];
  const disposition = isCancellationOnly(result.errors) ? "cancelled" : "failed";
  return firstError
    ? `Pipeline ${result.pipelineId} ${disposition}: ${formatPipelineError(firstError)}`
    : `Pipeline ${result.pipelineId} ${disposition}`;
}

function firstOriginalPipelineError(errors: readonly PipelineError[]): unknown {
  for (const error of errors) {
    if (originalPipelineErrors.has(error)) return originalPipelineErrors.get(error);
  }
  return undefined;
}

/** Error thrown by `runOrThrow` when a pipeline run does not complete successfully. */
export class PipelineExecutionError extends Error {
  constructor(
    readonly result: PipelineRun<unknown>,
    message = defaultExecutionErrorMessage(result)
  ) {
    const cause = firstOriginalPipelineError(result.errors);
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PipelineExecutionError";
    brandTubelessError(this, "pipeline-execution");
  }
}

const MAX_PIPELINE_CAUSE_DEPTH = 8;

function readErrorField(value: object, field: "cause" | "code" | "message" | "name"): unknown {
  try {
    // SAFETY: any object may be probed for an optional string-keyed field; a
    // getter that throws is caught below, so the cast only enables the lookup.
    return (value as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function safeErrorMessage(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "Unknown thrown value";
  }
}

function normalizePipelineCause(
  value: unknown,
  seen: WeakSet<object>,
  depth = 0
): PipelineErrorCause {
  if (depth >= MAX_PIPELINE_CAUSE_DEPTH) {
    return { message: "Cause chain truncated" };
  }
  if (typeof value !== "object" || value === null) {
    return { message: safeErrorMessage(value) };
  }
  if (seen.has(value)) {
    return { message: "Circular cause" };
  }
  seen.add(value);

  const message = readErrorField(value, "message");
  const name = readErrorField(value, "name");
  const sourceCode = readErrorField(value, "code");
  const nested = readErrorField(value, "cause");
  const cause: PipelineErrorCause = {
    message: typeof message === "string" ? message : safeErrorMessage(value),
  };
  if (typeof name === "string") cause.name = name;
  if (typeof sourceCode === "string") cause.sourceCode = sourceCode;
  if (nested !== undefined) cause.cause = normalizePipelineCause(nested, seen, depth + 1);
  return cause;
}

// Fan-out snapshots bound every string as well as cause depth and item count.
function fanOutCause(error: unknown): PipelineErrorCause {
  const cause = normalizePipelineCause(error, new WeakSet<object>());
  let current: PipelineErrorCause | undefined = cause;
  while (current) {
    current.message = current.message.slice(0, 1024);
    if (current.name) current.name = current.name.slice(0, 1024);
    if (current.sourceCode) current.sourceCode = current.sourceCode.slice(0, 1024);
    current = current.cause;
  }
  return cause;
}

function normalizedNestedCause(error: unknown): PipelineErrorCause | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const cause = readErrorField(error, "cause");
  if (cause === undefined) return undefined;
  const seen = new WeakSet<object>();
  seen.add(error);
  return normalizePipelineCause(cause, seen);
}

export function toPipelineError(
  error: unknown,
  classification: Omit<PipelineError, "cause" | "message" | "sourceCode" | "stack">
): PipelineError {
  const sourceCode =
    typeof error === "object" && error !== null ? readErrorField(error, "code") : undefined;
  const cause = normalizedNestedCause(error);
  const pipelineError: PipelineError = {
    ...classification,
    message: error instanceof Error ? error.message : safeErrorMessage(error),
  };
  if (error instanceof Error && error.stack) pipelineError.stack = error.stack;
  if (typeof sourceCode === "string") pipelineError.sourceCode = sourceCode;
  if (cause) pipelineError.cause = cause;
  if (error instanceof PipelineBoundaryValidationError) pipelineError.issues = error.issues;
  if (error instanceof PipelineChildError && error.fanOut) {
    const { failures, failureCount, schedulerError } = error.fanOut;
    pipelineError.fanOut = {
      failures: failures.map(({ error: itemError, key, index, cancelled }) => ({
        index,
        key: key.slice(0, 1024),
        keyTruncated: key.length > 1024,
        cancelled,
        error: fanOutCause(itemError),
      })),
      failureCount,
      omittedFailureCount: failureCount - failures.length,
    };
    if (schedulerError !== undefined)
      pipelineError.fanOut.schedulerError = fanOutCause(schedulerError);
  }
  originalPipelineErrors.set(pipelineError, error);
  return pipelineError;
}

export function isPipelineCancellation(
  error: unknown,
  runtime: Pick<PipelineRuntime, "signal">
): boolean {
  if (isAbortError(error)) return true;
  if (runtime.signal?.aborted === true && error === runtime.signal.reason) return true;
  if (error instanceof PipelineChildError) return error.cancelled;
  return error instanceof PipelineExecutionError && error.result.status === "cancelled";
}

/** Classify a failed attempt without exposing error subclasses to execution. */
export function stepExecutionError(
  error: unknown,
  runtime: Pick<PipelineRuntime, "signal">,
  stepId: string
): PipelineError {
  const cancelled = isPipelineCancellation(error, runtime);
  const childFailure =
    error instanceof PipelineExecutionError || error instanceof PipelineChildError;
  const validationFailure = error instanceof PipelineBoundaryValidationError;
  return toPipelineError(error, {
    code: cancelled
      ? "TUBELESS_RUN_CANCELLED"
      : validationFailure
        ? "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED"
        : childFailure
          ? "TUBELESS_CHILD_FAILED"
          : "TUBELESS_STEP_FAILED",
    kind: cancelled
      ? "cancellation"
      : validationFailure
        ? "validation"
        : childFailure
          ? "child"
          : "step",
    phase: "execution",
    stepId: stepId,
  });
}

export function finalizationError(
  error: unknown,
  runtime: Pick<PipelineRuntime, "signal">
): PipelineError {
  const cancelled = isPipelineCancellation(error, runtime);
  const validationFailure = error instanceof PipelineBoundaryValidationError;
  return toPipelineError(error, {
    code: cancelled
      ? "TUBELESS_FINALIZATION_CANCELLED"
      : validationFailure
        ? "TUBELESS_FINAL_RESULT_VALIDATION_FAILED"
        : "TUBELESS_FINALIZATION_FAILED",
    kind: cancelled ? "cancellation" : validationFailure ? "validation" : "finalization",
    phase: "finalization",
    stepId: PIPELINE_FINALIZE_STEP_ID,
  });
}
