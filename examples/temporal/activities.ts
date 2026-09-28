import { ApplicationFailure, Context } from "@temporalio/activity";
import { TemporalPipeline } from "./pipeline.js";
import { assertTubelessJob, type TubelessJob } from "../shared/tubeless-job.js";

export type TemporalJob = TubelessJob;

function validateJob(value: unknown): asserts value is TemporalJob {
  try {
    assertTubelessJob(value);
  } catch (error) {
    throw ApplicationFailure.nonRetryable(
      error instanceof Error ? error.message : String(error),
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
