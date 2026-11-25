import { setExecutionScope } from "../../core/execution-scope.js";
import { awaitWithAbort, throwIfAborted } from "../../utilities/abort.js";
import type { PipelineRun } from "../../core/pipeline-types.js";
import type { AnyProjectPipeline } from "../../project/pipeline-project.js";
import type { PipelineTraceEvent, PipelineTraceExporterOptions } from "../../tracing/tracing.js";
import { createLaunchTracing } from "../launch-tracing.js";
import type { HostedRunTraceContext } from "../run-contract.js";
import { boundedRunnerJson, runnerValue, type RunnerStageJob } from "../runner-protocol.js";
import type { BatchingTraceExporter } from "../trace-batching.js";

/** Leave the child completion out of progress batches so it can commit with the result. */
export async function executeHostedStage(options: {
  readonly job: RunnerStageJob;
  readonly pipeline: AnyProjectPipeline;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly exporter: BatchingTraceExporter;
  readonly confirmStart?: boolean;
  readonly configurations: readonly (
    | PipelineTraceExporterOptions<HostedRunTraceContext>
    | undefined
  )[];
  readonly wrapExporter?: Parameters<typeof createLaunchTracing>[0]["wrapExporter"];
}): Promise<{ completion: PipelineTraceEvent; report: PipelineRun<unknown> }> {
  const { job, pipeline, cwd, signal, exporter, configurations, wrapExporter } = options;
  const { parentRunId, correlationId, itemKey, stepId, input, controls } = job.stage;
  let completion: PipelineTraceEvent | undefined;
  let confirmStart: ((accepted: boolean) => void) | undefined;
  const started = options.confirmStart
    ? new Promise<boolean>((resolve) => {
        confirmStart = resolve;
      })
    : undefined;
  const stageExporter = {
    export(event: PipelineTraceEvent) {
      if (event.name === "pipeline.completed" && event.parentRunId === parentRunId)
        completion = event;
      else {
        const exported = exporter.export(event);
        if (!started || event.name !== "pipeline.started" || event.parentRunId !== parentRunId)
          return exported;
        return (exported ?? exporter.flush()).then(
          () => confirmStart?.(true),
          (error: unknown) => {
            confirmStart?.(false);
            throw error;
          }
        );
      }
    },
    flush: () => exporter.flush(),
  };
  const tracing = createLaunchTracing({
    context: { pipelineId: pipeline.id, cwd, signal, launchId: job.launchId },
    configurations,
    exporters: [stageExporter],
    wrapExporter,
  });
  let report;
  try {
    const context = {
      cwd,
      log: console,
      signal,
      parentRunId,
      correlationId,
      tracing: {
        ...(tracing.prepare() ?? { exporter: stageExporter }),
        itemKey,
        parentStep: { runId: parentRunId, stepId },
      },
    };
    if (started)
      setExecutionScope(context, {
        async run(work) {
          const accepted = await awaitWithAbort(started, signal, "Confirm Worker stage history");
          if (!accepted) throw new Error("Studio could not confirm the Worker stage start.");
          throwIfAborted(signal, "Start Worker stage handler");
          return work();
        },
      });
    report = await pipeline.run(input, controls, context);
  } finally {
    await tracing.close();
  }
  await exporter.flush();
  if (completion?.runId !== report.runId)
    throw new Error("The remote stage did not record a terminal event.");
  const transferable =
    report.finalized && report.value !== undefined
      ? { ...report, value: runnerValue(report.value, "Remote stage result") }
      : report;
  boundedRunnerJson({ report: transferable }, "Remote stage result");
  return { completion, report: transferable };
}
