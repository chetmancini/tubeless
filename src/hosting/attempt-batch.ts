import { decodeStoredTraceEvent } from "../run-store/run-store-event-decoder.js";
import { PIPELINE_TRACE_VERSION } from "../tracing/tracing-constants.js";
import {
  wireArray,
  wireCustom,
  wireNumber,
  wireObject,
  wireString,
} from "../tracing/wire-schema.js";
import { assertAttemptId } from "./attempt-store.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

// Internal envelope limits; the HTTP adapter must also enforce these while reading.
const MAX_BATCH_BYTES = 1_048_576;
const MAX_BATCH_EVENTS = 50;

const envelopeSchema = wireObject({
  attemptId: wireString({ maxLength: 256 }),
  sequence: wireNumber({ integer: true, minimum: 0 }),
  events: wireArray(wireCustom({}, decodeStoredTraceEvent), { maxItems: MAX_BATCH_EVENTS }),
});

/** Decode from the same owned bytes that are hashed; never accept a caller-supplied digest. */
export async function decodeAttemptBatch(body: Uint8Array): Promise<{
  readonly attemptId: string;
  readonly sequence: number;
  readonly events: readonly PipelineTraceEvent[];
  readonly digest: string;
}> {
  if (body.byteLength > MAX_BATCH_BYTES) throw new Error("Hosted attempt batch is too large.");
  const bytes = new Uint8Array(body);
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a hosted attempt batch object.");
  if (Object.keys(value).some((key) => !["attemptId", "sequence", "events"].includes(key)))
    throw new Error("Unsupported hosted attempt batch field.");
  const envelope = envelopeSchema.decode(value, "batch");
  if (envelope.events.length === 0) throw new Error("Hosted attempt batches must contain events.");
  for (const event of envelope.events) {
    if (event.version !== PIPELINE_TRACE_VERSION)
      throw new Error("Hosted attempt writes require the current trace version.");
    assertAttemptId(event.runId);
    assertAttemptId(event.pipelineId);
    if (event.parentRunId !== undefined) assertAttemptId(event.parentRunId);
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    ...envelope,
    digest: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      ""
    ),
  };
}
