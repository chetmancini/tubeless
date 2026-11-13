import type { PipelineTraceExporter } from "../tracing/tracing.js";
import { awaitWithAbort } from "../utilities/abort.js";

const APP_TRACE_OPERATION_TIMEOUT_MS = 5_000;

/** Bound one optional destination; the launch scope retains exporter identity. */
export function boundCloudflareTraceExporter(
  exporter: PipelineTraceExporter,
  deadlineAtMs: number
): PipelineTraceExporter {
  const invoke = async (operation: "export" | "flush", perform: () => void | Promise<void>) => {
    const timeoutError = () =>
      new DOMException(
        `Application trace exporter ${operation} exceeded its delivery deadline.`,
        "TimeoutError"
      );
    const timeoutMs = Math.min(APP_TRACE_OPERATION_TIMEOUT_MS, deadlineAtMs - Date.now());
    if (timeoutMs <= 0) throw timeoutError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
    try {
      await awaitWithAbort(Promise.resolve().then(perform), controller.signal, "Trace delivery");
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    export: (event) => invoke("export", () => exporter.export(event)),
    flush: () => (exporter.flush ? invoke("flush", () => exporter.flush?.()) : undefined),
  };
}
