import { PartialPipelineTraceExporterError } from "./trace-exporter-error.js";
import type { PipelineTraceExporter } from "./tracing-contracts.js";

export type { PipelineTraceEvent, PipelineTraceExporter } from "./tracing-contracts.js";

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
