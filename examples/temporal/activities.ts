import { ApplicationFailure, Context } from "@temporalio/activity";
import { TemporalPipeline } from "./pipeline.js";

export interface TemporalJob {
  lines: readonly string[];
  dryRun?: boolean;
  parentRunId?: string;
}

// TypeScript types do not validate Workflow/Activity payloads on the wire.
function validateJob(value: unknown): asserts value is TemporalJob {
  if (
    typeof value !== "object" ||
    value === null ||
    !("lines" in value) ||
    !Array.isArray(value.lines) ||
    !value.lines.every((line: unknown) => typeof line === "string") ||
    ("dryRun" in value && value.dryRun !== undefined && typeof value.dryRun !== "boolean") ||
    ("parentRunId" in value &&
      value.parentRunId !== undefined &&
      (typeof value.parentRunId !== "string" || value.parentRunId.length === 0))
  ) {
    throw ApplicationFailure.nonRetryable(
      "Expected string rows and optional dryRun/parentRunId",
      "InvalidTubelessJob"
    );
  }
}

export async function runPipeline(job: TemporalJob) {
  validateJob(job);
  const activity = Context.current();
  const { namespace, workflowExecution, activityId, attempt } = activity.info;
  if (!workflowExecution) {
    throw ApplicationFailure.nonRetryable(
      "This example Activity must be scheduled by a Workflow",
      "MissingWorkflow"
    );
  }
  // Stable across Activity retries; each Tubeless execution still gets a new runId.
  const correlationId = JSON.stringify([
    "temporal",
    namespace,
    workflowExecution.workflowId,
    workflowExecution.runId,
    activityId,
  ]);
  let progress: { stepId: string; completed: number; total?: number } = {
    stepId: "starting",
    completed: 0,
  };
  // A periodic heartbeat also covers a step that waits on I/O without progress.
  // It carries observation only: this example does not resume from heartbeat details.
  const timer = setInterval(() => activity.heartbeat(progress), 5000);
  timer.unref();
  try {
    activity.heartbeat(progress);
    activity.log.info("Starting Tubeless pipeline", { correlationId, attempt });
    return await TemporalPipeline.runOrThrow(
      { lines: job.lines },
      { dryRun: job.dryRun },
      {
        correlationId,
        parentRunId: job.parentRunId,
        signal: activity.cancellationSignal,
        log: {
          log: (message) => activity.log.info(String(message)),
          warn: (message) => activity.log.warn(String(message)),
          error: (message) => activity.log.error(String(message)),
        },
        hooks: {
          onStepProgress(event) {
            progress = {
              stepId: event.step.id,
              completed: event.progress.completed,
              total: event.progress.total,
            };
            activity.heartbeat(progress);
          },
        },
        tracing: {
          exporter: { export: (event) => activity.log.info("Tubeless event", { event }) },
        },
      }
    );
  } catch (error) {
    // Tubeless wraps failures, including aborts. Restore Temporal's cancellation
    // failure so the Worker reports cancellation instead of a retryable failure.
    if (activity.cancellationSignal.aborted) return await activity.cancelled;
    throw error; // Temporal's Activity retry policy owns all other execution failures.
  } finally {
    clearInterval(timer);
  }
}
