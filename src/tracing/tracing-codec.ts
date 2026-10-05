import type { PipelineTraceEvent } from "./tracing-contracts.js";
import { pipelineTraceEventSchema } from "./tracing-schema.js";

/** Decode and validate a version 2 or 3 trace record. */
export function decodePipelineTraceEvent(value: unknown): PipelineTraceEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("event must be an object");
  }
  return pipelineTraceEventSchema.decode(value, "");
}
