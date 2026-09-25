import type { PipelineTraceErrorContract, PipelineTraceEventContract } from "./tracing-schema.js";

/** A versioned lifecycle record with an event-specific, structured payload. */
export type PipelineTraceEvent = PipelineTraceEventContract;

/** Asynchronous boundary for trace destinations. */
export interface PipelineTraceExporter {
  export(event: PipelineTraceEvent): void | Promise<void>;
  flush?(): void | Promise<void>;
}

export type PipelineTraceAttributeValue = Exclude<
  Extract<PipelineTraceEvent, { name: "step.attempted" }>["payload"]["attributes"][string],
  undefined
>;

export type PipelineTraceAttributes = Extract<
  PipelineTraceEvent,
  { name: "step.attempted" }
>["payload"]["attributes"];

export type PipelineTraceContext = Pick<
  PipelineTraceEvent,
  "correlationId" | "itemKey" | "parentRunId" | "runId" | "iteration"
>;

export type PipelineTraceError = PipelineTraceErrorContract;

export type PipelineTraceNestedPipeline = NonNullable<
  Extract<PipelineTraceEvent, { name: "step.planned" }>["payload"]["nestedPipeline"]
>;

export type PipelineTraceRemote = NonNullable<
  Extract<PipelineTraceEvent, { name: "step.planned" }>["payload"]["remote"]
>;

export type PipelineTraceProgress = NonNullable<
  Extract<PipelineTraceEvent, { name: "step.running" }>["payload"]["progress"]
>;

export interface PipelineTracingOptions {
  exporter: PipelineTraceExporter;
  itemKey?: string;
  /** Origin of a repeated child invocation; inherited by its descendants. */
  iteration?: PipelineTraceContext["iteration"];
  /** Called once on the first exporter failure without failing the run. */
  readonly onExporterError?: (error: unknown) => void;
}
