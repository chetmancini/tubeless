import type { Context } from "aws-lambda";
import { StepFunctionsPipeline } from "./pipeline.js";

interface PipelineEvent {
  job: { lines: string[]; dryRun?: boolean; parentRunId?: string };
  host: { executionArn: string; stateName: string; retryCount: number };
}

class InvalidPipelineInput extends Error {
  override name = "InvalidPipelineInput";
}

class PipelineDeadlineExceeded extends Error {
  override name = "PipelineDeadlineExceeded";
}

function validateEvent(value: unknown): asserts value is PipelineEvent {
  if (typeof value !== "object" || value === null || !("job" in value) || !("host" in value)) {
    throw new InvalidPipelineInput("Expected a job and Step Functions host context");
  }
  const { job, host } = value;
  if (
    typeof job !== "object" ||
    job === null ||
    !("lines" in job) ||
    !Array.isArray(job.lines) ||
    !job.lines.every((line: unknown) => typeof line === "string") ||
    ("dryRun" in job && job.dryRun !== undefined && typeof job.dryRun !== "boolean") ||
    ("parentRunId" in job &&
      job.parentRunId !== undefined &&
      (typeof job.parentRunId !== "string" || job.parentRunId.length === 0))
  )
    throw new InvalidPipelineInput("Expected string rows and optional dryRun/parentRunId");
  if (
    typeof host !== "object" ||
    host === null ||
    !("executionArn" in host) ||
    typeof host.executionArn !== "string" ||
    !host.executionArn ||
    !("stateName" in host) ||
    typeof host.stateName !== "string" ||
    !host.stateName ||
    !("retryCount" in host) ||
    typeof host.retryCount !== "number" ||
    !Number.isSafeInteger(host.retryCount) ||
    host.retryCount < 0
  )
    throw new InvalidPipelineInput(
      "Expected an execution ARN, state name, and nonnegative retry count"
    );
}

// The event is unknown because neither Step Functions nor TypeScript validates its job shape.
export async function handler(
  event: unknown,
  context: Pick<Context, "awsRequestId" | "getRemainingTimeInMillis">
) {
  validateEvent(event);
  const { job, host } = event;
  const correlationId = JSON.stringify(["step-functions", host.executionArn, host.stateName]);
  const metadata = { ...host, correlationId, awsRequestId: context.awsRequestId };
  const deadline = new PipelineDeadlineExceeded("Pipeline reached its cooperative Lambda deadline");
  const budgetMs = context.getRemainingTimeInMillis() - 1000;
  if (budgetMs <= 0) throw deadline;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(deadline), budgetMs);
  timer.unref();
  try {
    console.info({ kind: "tubeless-start", ...metadata });
    const result = await StepFunctionsPipeline.runOrThrow(
      { lines: job.lines },
      { dryRun: job.dryRun },
      {
        correlationId,
        parentRunId: job.parentRunId,
        signal: controller.signal,
        log: {
          log: (message) =>
            console.info({ kind: "tubeless-log", ...metadata, message: String(message) }),
          warn: (message) =>
            console.warn({ kind: "tubeless-log", ...metadata, message: String(message) }),
          error: (message) =>
            console.error({ kind: "tubeless-log", ...metadata, message: String(message) }),
        },
        hooks: {
          onStepProgress: ({ step, progress }) =>
            console.info({
              kind: "tubeless-progress",
              ...metadata,
              stepId: step.id,
              ...progress,
            }),
        },
        tracing: {
          exporter: {
            export: (trace) => console.info({ kind: "tubeless-trace", ...metadata, event: trace }),
          },
        },
      }
    );
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    // Preserve a stable Lambda error name when Tubeless wraps an aborted run.
    if (controller.signal.aborted) throw deadline;
    throw error; // A rejected handler fails the Task; never return {error} as success.
  } finally {
    clearTimeout(timer); // Warm Lambda environments must not inherit this invocation's timer.
  }
}
