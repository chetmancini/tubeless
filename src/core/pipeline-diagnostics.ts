import type { PipelineError, PipelineErrorCause, PipelineStepReport } from "./pipeline-types.js";

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

/** `sourceCode` of a `requireOutputs` finalizer whose listed outputs were not published. */
export const REQUIRED_OUTPUTS_MISSING_CODE = "TUBELESS_REQUIRED_OUTPUTS_MISSING";

/**
 * True when a step left no output because of a run failure: it failed, was
 * cancelled, or was skipped after a failure. An unmet-dependency skip follows
 * its blocking dependency, which may itself have been filtered or dry-run skipped.
 */
function unpublishedByFailure(
  report: PipelineStepReport | undefined,
  reports: ReadonlyMap<string, PipelineStepReport>
): boolean {
  if (report === undefined || report.status === "completed") return false;
  if (report.status !== "skipped") return true;
  if (report.reason === "failed-dependency" || report.reason === "fail-fast") return true;
  // Dependencies are acyclic, so this walk terminates.
  if (report.reason === "unmet-dependency" && report.dependencyId !== undefined) {
    return unpublishedByFailure(reports.get(report.dependencyId), reports);
  }
  return false;
}

/** Policy skips publish their value; other skips leave no output. */
function unpublished(report: PipelineStepReport): boolean {
  return (
    report.status !== "completed" && !(report.status === "skipped" && report.reason === "policy")
  );
}

/**
 * Errors worth showing a person. A missing-output finalizer failure is dropped
 * only when another error is present and every step that left no output failed,
 * was cancelled, or was skipped because of a failure. Any independently
 * unpublished step might be the missing one, and without step reports the
 * cause is unknown, so the failure is kept in both cases.
 */
export function causalPipelineErrors(run: {
  readonly errors: readonly PipelineError[];
  readonly steps?: readonly PipelineStepReport[];
}): readonly PipelineError[] {
  const causal = run.errors.filter((error) => error.sourceCode !== REQUIRED_OUTPUTS_MISSING_CODE);
  if (causal.length === 0 || !run.steps) return run.errors;
  const reports = new Map(run.steps.map((report) => [report.id, report]));
  const derived = run.steps.every(
    (report) => !unpublished(report) || unpublishedByFailure(report, reports)
  );
  return derived ? causal : run.errors;
}
