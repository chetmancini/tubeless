export interface PipelineTraceExporterFailure {
  readonly error: unknown;
  readonly message: string;
}

export const PARTIAL_PIPELINE_TRACE_EXPORTER_ERROR = Symbol.for(
  "tubeless/partial-pipeline-trace-exporter-error/v1"
);

/** Internal signal that one composed exporter failed while another succeeded. */
export class PartialPipelineTraceExporterError extends Error {
  readonly exporterError: unknown;

  constructor(failure: PipelineTraceExporterFailure) {
    super(failure.message, { cause: failure.error });
    this.name = "PartialPipelineTraceExporterError";
    this.exporterError = failure.error;
    Object.defineProperty(this, PARTIAL_PIPELINE_TRACE_EXPORTER_ERROR, { value: true });
  }
}

/** Format unknown exporter failures without allowing diagnostics to become failures. */
export function formatExporterError(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : error;
    return String(message);
  } catch {
    return "[unprintable error]";
  }
}
