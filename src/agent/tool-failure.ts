import {
  originalHandlerFailure,
  originalPipelineError,
  PipelineChildError,
  PipelineExecutionError,
} from "../core/pipeline-execution-error.js";
import type { PipelineError, PipelineRun } from "../core/pipeline-types.js";
import { ToolError } from "./tools.js";

function childFailures(error: unknown): ToolError[] | undefined {
  if (error instanceof PipelineExecutionError) return failures(error.result);
  if (!(error instanceof PipelineChildError) || error.cancelled) return undefined;
  if (!error.fanOut) return childFailures(error.cause);
  const { failures: children, failureCount, schedulerError } = error.fanOut;
  if (schedulerError !== undefined || children.length !== failureCount) return undefined;
  return collect(
    children.map(({ error: child, cancelled }) => (cancelled ? undefined : childFailures(child)))
  );
}

function collect(groups: readonly (ToolError[] | undefined)[]): ToolError[] | undefined {
  return groups.length > 0 && groups.every((group) => group !== undefined && group.length > 0)
    ? groups.flatMap((group) => group!)
    : undefined;
}

function failure(error: PipelineError): ToolError[] | undefined {
  if (error.code === "TUBELESS_STEP_FAILED") {
    const original = originalHandlerFailure(error);
    return original instanceof ToolError ? [original] : undefined;
  }
  return error.code === "TUBELESS_CHILD_FAILED"
    ? childFailures(originalPipelineError(error))
    : undefined;
}

function failures(result: PipelineRun<unknown>): ToolError[] | undefined {
  return result.status === "failed" ? collect(result.errors.map(failure)) : undefined;
}

/** Classify actual handler failures only; validation, finalizers, and cancellation stay fatal. */
export function expectedToolFailure(
  result: PipelineRun<unknown>
): { code: string; message: string } | undefined {
  const errors = failures(result);
  if (!errors) return undefined;
  if (errors.length === 1) return { code: errors[0]!.code, message: errors[0]!.message };
  return {
    code: "TUBELESS_TOOL_ERRORS",
    message: errors
      .slice(0, 32)
      .map((error) => `${error.code}: ${error.message}`)
      .join("; ")
      .slice(0, 4096),
  };
}
