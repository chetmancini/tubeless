import { createSteps, definePipeline, requireOutputs } from "tubeless";
import type { PipelineTraceExporter } from "tubeless/tracing";
import { isRecord, isRows } from "./contract.js";

const { step } = createSteps<{ lines: readonly string[] }>();
const normalize = step("normalize", {
  run: (_inputs, context) => {
    const rows = context.options.lines.map((row) => row.trim().toLowerCase()).filter(Boolean);
    context.reportProgress({
      completed: rows.length,
      total: rows.length,
      message: "Rows normalized",
    });
    return rows;
  },
});

export const AirflowHostedPipeline = definePipeline({
  id: "airflow-hosted",
  implementationVersion: "airflow-example-v1",
  steps: [normalize],
  finalize: requireOutputs([normalize], (outputs, context) => {
    return {
      rows: outputs.normalize,
      count: outputs.normalize.length,
      runId: context.runId,
      preview: context.dryRun,
    };
  }),
});

// The Python task provides this envelope through stdin. Validate before using
// external identities; an Airflow run ID is never a Tubeless parentRunId.
export async function runAirflowJob(
  value: unknown,
  signal?: AbortSignal,
  exporter?: PipelineTraceExporter
) {
  if (
    !isRecord(value) ||
    !isRecord(value.conf) ||
    !isRows(value.conf.lines) ||
    typeof value.dagId !== "string" ||
    typeof value.dagRunId !== "string" ||
    typeof value.taskId !== "string" ||
    !Number.isInteger(value.mapIndex) ||
    !Number.isInteger(value.tryNumber) ||
    (value.conf.dry_run !== undefined && typeof value.conf.dry_run !== "boolean") ||
    (value.conf.tubeless_parent_run_id !== undefined &&
      typeof value.conf.tubeless_parent_run_id !== "string")
  ) {
    throw new Error("Invalid Airflow task envelope");
  }
  return AirflowHostedPipeline.runOrThrow(
    { lines: value.conf.lines },
    { dryRun: value.conf.dry_run === true },
    {
      signal,
      correlationId: JSON.stringify([
        "airflow",
        value.dagId,
        value.dagRunId,
        value.taskId,
        value.mapIndex,
      ]),
      parentRunId: value.conf.tubeless_parent_run_id,
      tracing: exporter ? { exporter } : undefined,
    }
  );
}
