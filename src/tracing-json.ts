import type { PipelineLogger } from "./pipeline.js";
import type { PipelineTraceEvent, PipelineTraceExporter } from "./tracing.js";

/** Configuration for the dependency-free JSON trace exporter. */
export interface JsonTraceExporterOptions {
  /** Pipeline-compatible logger. Mutually exclusive with `write`. */
  log?: Pick<PipelineLogger, "log">;
  /** Receives one JSON object per line. Defaults to `console.log`. */
  write?: (line: string) => void;
}

/** Create a newline-delimited JSON trace exporter for logs and local tooling. */
export function createJsonTraceExporter(
  options: JsonTraceExporterOptions = {}
): PipelineTraceExporter {
  const write =
    options.write ?? (options.log ? (line: string) => options.log?.log(line) : console.log);
  return {
    export: (event: PipelineTraceEvent) => write(JSON.stringify(event)),
  };
}
