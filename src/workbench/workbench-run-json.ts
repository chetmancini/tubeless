import { isDeepStrictEqual } from "node:util";
import type { PipelineRun } from "../core/pipeline.js";

/** Keep the public report and its already JSON-safe diagnostics; reject lossy domain values. */
export function serializeRunJson(run: PipelineRun): string {
  if (!run.finalized) return `${JSON.stringify(run)}\n`;
  try {
    const encoded = JSON.stringify(run.value);
    if (encoded === undefined) throw new Error("The finalized value has no JSON representation.");
    const value: unknown = JSON.parse(encoded);
    if (!isDeepStrictEqual(run.value, value)) {
      throw new Error("The finalized value does not round-trip through JSON.");
    }
    return `${JSON.stringify({ ...run, value })}\n`;
  } catch (cause) {
    throw new Error(
      "--json cannot represent the finalized value without data loss. Return JSON data (null, booleans, finite numbers, strings, arrays, or plain objects).",
      { cause }
    );
  }
}
