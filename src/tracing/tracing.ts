import { PartialPipelineTraceExporterError } from "./trace-exporter-error.js";
import type {
  PipelineTraceErrorContract,
  PipelineTraceEventContract,
  PipelineTraceEventNameContract,
} from "./tracing-schema.js";

/** Values that can be safely carried in a structured trace attribute. */
export type PipelineTraceAttributeValue = Extract<
  PipelineTraceEventContract,
  { name: "step.attempted" }
>["payload"]["attributes"][string];

/** Additional scalar telemetry supplied by a step attempt. */
export type PipelineTraceAttributes = Extract<
  PipelineTraceEventContract,
  { name: "step.attempted" }
>["payload"]["attributes"];

/** Stable identities propagated through a traced parent/child pipeline tree. */
export type PipelineTraceContext = Pick<
  PipelineTraceEventContract,
  "correlationId" | "itemKey" | "parentRunId" | "runId"
>;

/** Structured error attributes emitted without retaining the original error object. */
export type PipelineTraceError = PipelineTraceErrorContract;

/** Static child-pipeline metadata retained in a planned-step trace. */
export type PipelineTraceNestedPipeline = NonNullable<
  Extract<PipelineTraceEventContract, { name: "step.planned" }>["payload"]["nestedPipeline"]
>;

/** Static remote-adapter metadata retained in a planned-step trace. */
export type PipelineTraceRemote = NonNullable<
  Extract<PipelineTraceEventContract, { name: "step.planned" }>["payload"]["remote"]
>;

/** Bounded progress snapshot retained in a running-step trace. */
export type PipelineTraceProgress = NonNullable<
  Extract<PipelineTraceEventContract, { name: "step.running" }>["payload"]["progress"]
>;

export type PipelineStartedTraceEvent = Extract<
  PipelineTraceEventContract,
  { name: "pipeline.started" }
>;
export type PipelineLogTraceEvent = Extract<PipelineTraceEventContract, { name: "pipeline.log" }>;
export type PipelineCompletedTraceEvent = Extract<
  PipelineTraceEventContract,
  { name: "pipeline.completed" }
>;
export type PipelineFinalizeStartedTraceEvent = Extract<
  PipelineTraceEventContract,
  { name: "pipeline.finalize.started" }
>;
export type PipelineFinalizeCompletedTraceEvent = Extract<
  PipelineTraceEventContract,
  { name: "pipeline.finalize.completed" }
>;
export type PipelineFinalizeFailedTraceEvent = Extract<
  PipelineTraceEventContract,
  { name: "pipeline.finalize.failed" }
>;
export type StepPlannedTraceEvent = Extract<PipelineTraceEventContract, { name: "step.planned" }>;
export type StepRunningTraceEvent = Extract<PipelineTraceEventContract, { name: "step.running" }>;
export type StepAttemptedTraceEvent = Extract<
  PipelineTraceEventContract,
  { name: "step.attempted" }
>;
export type StepCompletedTraceEvent = Extract<
  PipelineTraceEventContract,
  { name: "step.complete" }
>;
export type StepSkippedTraceEvent = Extract<PipelineTraceEventContract, { name: "step.skipped" }>;
export type StepCancelledTraceEvent = Extract<
  PipelineTraceEventContract,
  { name: "step.cancelled" }
>;
export type StepFailedTraceEvent = Extract<PipelineTraceEventContract, { name: "step.failed" }>;

/** A versioned lifecycle record with an event-specific, structured payload. */
export type PipelineTraceEvent = PipelineTraceEventContract;

/** Stable lifecycle names emitted by the pipeline executor. */
export type PipelineTraceEventName = PipelineTraceEventNameContract;

/** Asynchronous boundary for trace destinations. */
export interface PipelineTraceExporter {
  export(event: PipelineTraceEvent): void | Promise<void>;
  flush?(): void | Promise<void>;
}

/**
 * Fan one trace stream out to multiple exporters. An exporter is retired after
 * its first failure so healthy destinations continue receiving later events. A
 * partial failure rejects that operation after every healthy exporter receives
 * it, allowing tracing error handlers to report the dropped destination.
 */
export function composeTraceExporters(
  exporters: readonly PipelineTraceExporter[]
): PipelineTraceExporter {
  if (exporters.length === 1) return exporters[0]!;
  const failed = new WeakSet<PipelineTraceExporter>();
  let lastError: unknown;
  let hasLastError = false;
  const invokeHealthy = async (
    invoke: (exporter: PipelineTraceExporter) => void | Promise<void>
  ): Promise<void> => {
    let succeeded = 0;
    let roundError: unknown;
    let hadRoundError = false;
    for (const exporter of exporters) {
      if (failed.has(exporter)) continue;
      try {
        await invoke(exporter);
        succeeded += 1;
      } catch (error) {
        failed.add(exporter);
        lastError = error;
        hasLastError = true;
        if (!hadRoundError) roundError = error;
        hadRoundError = true;
      }
    }
    if (hadRoundError) {
      if (succeeded > 0) {
        throw new PartialPipelineTraceExporterError({
          error: roundError,
          message: roundError instanceof Error ? roundError.message : String(roundError),
        });
      }
      throw roundError;
    }
    if (succeeded === 0 && hasLastError) throw lastError;
  };
  return {
    export(event) {
      return invokeHealthy((exporter) => exporter.export(event));
    },
    flush() {
      return invokeHealthy((exporter) => exporter.flush?.());
    },
  };
}

/** Configuration supplied through `PipelineContext.tracing`. */
export interface PipelineTracingOptions {
  exporter: PipelineTraceExporter;
  itemKey?: string;
  /**
   * Called once, on the first exporter failure of the run. The run itself is
   * not failed. A single failed exporter drops later events; a composed exporter
   * retires only the failed destination while healthy destinations continue.
   */
  readonly onExporterError?: (error: unknown) => void;
}
