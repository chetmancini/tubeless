import { formatExporterError, PartialPipelineTraceExporterError } from "./trace-exporter-error.js";
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
    // Independent destinations can overlap, but repeated references to one
    // exporter must still wait for its preceding invocation and retirement.
    const pending = new Map<PipelineTraceExporter, Promise<unknown>>();
    const results = await Promise.allSettled(
      exporters.map((exporter) => {
        const previous = pending.get(exporter);
        const task = (async () => {
          if (previous) await previous.catch(() => undefined);
          if (failed.has(exporter)) return false;
          try {
            await invoke(exporter);
            return true;
          } catch (error) {
            failed.add(exporter);
            throw error;
          }
        })();
        pending.set(exporter, task);
        return task;
      })
    );
    let succeeded = 0;
    let roundError: unknown;
    let hadRoundError = false;
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value) succeeded += 1;
      } else {
        lastError = result.reason;
        hasLastError = true;
        if (!hadRoundError) roundError = result.reason;
        hadRoundError = true;
      }
    }
    if (hadRoundError) {
      if (succeeded > 0) {
        throw new PartialPipelineTraceExporterError({
          error: roundError,
          message: formatExporterError(roundError),
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
