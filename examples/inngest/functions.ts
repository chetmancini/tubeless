import { NonRetriableError } from "inngest";
import { inngest } from "./client.js";
import { InngestPipeline } from "./pipeline.js";

export interface InngestJob {
  lines: readonly string[];
  dryRun?: boolean;
  parentRunId?: string;
}

// Event payloads need runtime validation even when their sender uses TypeScript.
function validateJob(value: unknown): asserts value is InngestJob {
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
    throw new NonRetriableError("Expected string rows and optional dryRun/parentRunId");
  }
}

export const normalizeFunction = inngest.createFunction(
  {
    id: "normalize-rows",
    triggers: { event: "tubeless/normalize.requested" },
    retries: 2, // Two retries after the initial attempt, per durable step.
  },
  async ({ event, step, runId, logger, attempt }) =>
    step.run("run-pipeline", async () => {
      const job: unknown = event.data;
      // Validate before entering Tubeless so it cannot wrap NonRetriableError.
      validateJob(job);
      const correlationId = JSON.stringify(["inngest", runId, "run-pipeline"]);
      logger.info("Starting Tubeless pipeline", { correlationId, attempt });
      // The entire pipeline is one durable step. Never call Inngest step tools
      // from inside its handlers; split durable phases at the function level.
      return InngestPipeline.runOrThrow(
        { lines: job.lines },
        { dryRun: job.dryRun },
        {
          correlationId,
          parentRunId: job.parentRunId,
          log: {
            log: (message) => logger.info(String(message)),
            warn: (message) => logger.warn(String(message)),
            error: (message) => logger.error(String(message)),
          },
          hooks: {
            onStepProgress({ step, progress }) {
              logger.info("Tubeless progress", { correlationId, stepId: step.id, ...progress });
            },
          },
          tracing: {
            exporter: { export: (event) => logger.info("Tubeless event", { event }) },
          },
        }
      );
    })
);
