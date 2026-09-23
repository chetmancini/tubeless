import type { openDagsterPipes } from "@dagster-io/dagster-pipes";
import { isAbsolute } from "node:path";
import { DagsterPipeline } from "./pipeline.js";

interface DagsterJob {
  lines: string[];
  outputPath: string;
  tracePath: string;
  parentRunId?: string;
}

function validateJob(value: unknown): asserts value is DagsterJob {
  if (
    typeof value !== "object" ||
    value === null ||
    !("lines" in value) ||
    !Array.isArray(value.lines) ||
    !value.lines.every((line: unknown) => typeof line === "string") ||
    !("outputPath" in value) ||
    typeof value.outputPath !== "string" ||
    !isAbsolute(value.outputPath) ||
    !("tracePath" in value) ||
    typeof value.tracePath !== "string" ||
    !isAbsolute(value.tracePath) ||
    ("dryRun" in value && value.dryRun !== false) ||
    ("parentRunId" in value &&
      value.parentRunId !== undefined &&
      (typeof value.parentRunId !== "string" || value.parentRunId.length === 0))
  )
    throw new Error("Expected rows and absolute artifact/trace paths; preview with the local CLI");
}

export async function runDagsterJob(
  pipes: ReturnType<typeof openDagsterPipes>,
  signal?: AbortSignal
) {
  const job: unknown = pipes.getExtra("job");
  validateJob(job);
  const assetKey = pipes.assetKey; // This recipe requires exactly one selected asset.
  const correlationId = JSON.stringify(["dagster", pipes.runID, assetKey]);
  pipes.logger.info(`Starting Tubeless for ${assetKey}, Dagster attempt ${pipes.retryNumber}`);
  const result = await DagsterPipeline.runOrThrow(
    { lines: job.lines, outputPath: job.outputPath },
    undefined,
    {
      signal,
      correlationId,
      parentRunId: job.parentRunId,
      log: {
        log: (message) => pipes.logger.info(String(message)),
        warn: (message) => pipes.logger.warning(String(message)),
        error: (message) => pipes.logger.error(String(message)),
      },
      hooks: {
        onStepProgress: ({ step, progress }) =>
          pipes.logger.info(`${step.id}: ${progress.completed}/${progress.total ?? "?"}`),
      },
      tracing: {
        exporter: {
          export: (event) => pipes.reportCustomMessage({ kind: "tubeless-trace", event }),
        },
      },
    }
  );
  signal?.throwIfAborted();
  // Report success only after validation, publication, and finalization succeed.
  pipes.reportAssetMaterialization(
    {
      row_count: { raw_value: result.rowCount, type: "int" },
      artifact: { raw_value: result.path, type: "path" },
      tubeless_run_id: result.runId,
      tubeless_trace: { raw_value: job.tracePath, type: "path" },
    },
    result.dataVersion,
    assetKey
  );
  return result;
}
