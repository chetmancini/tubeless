import type { PipelineError, PipelineErrorCause } from "./pipeline.js";

function deepestPipelineCause(
  cause: PipelineErrorCause | undefined
): PipelineErrorCause | undefined {
  let current = cause;
  while (current?.cause) current = current.cause;
  return current;
}

/** One-line human format used by kernel exceptions and shared renderers. */
export function formatPipelineError(error: PipelineError): string {
  const step = error.stepId ? ` at step ${error.stepId}` : "";
  const sourceCode = error.sourceCode ? ` (${error.sourceCode})` : "";
  const deepestCause = deepestPipelineCause(error.cause);
  const cause = deepestCause
    ? `; caused by${deepestCause.sourceCode ? ` ${deepestCause.sourceCode}` : ""}: ${deepestCause.message}`
    : "";
  return `${error.phase}${step} [${error.code}]${sourceCode}: ${error.message}${cause}`;
}
