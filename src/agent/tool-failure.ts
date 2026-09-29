import { pipelineHandlerFailures } from "../core/pipeline-execution-error.js";
import type { PipelineRun } from "../core/pipeline-types.js";
import { ToolError } from "./tools.js";

/** Classify actual handler failures only; validation, finalizers, and cancellation stay fatal. */
export function expectedToolFailure(
  result: PipelineRun<unknown>
): { code: string; message: string } | undefined {
  const errors = pipelineHandlerFailures(result);
  if (!errors?.every((error) => error instanceof ToolError)) return undefined;
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
