import { decodeStoredTraceEvent } from "../run-store/run-store-event-decoder.js";
import { PIPELINE_TRACE_VERSION } from "../tracing/tracing-constants.js";
import {
  wireArray,
  wireCustom,
  wireNumber,
  wireObject,
  wireString,
} from "../tracing/wire-schema.js";
import {
  COLLECTOR_BATCH_BYTES,
  COLLECTOR_BATCH_EVENTS,
  CollectorInputError,
  decodeCollectorJson,
  digestCollectorBody,
} from "./collector-protocol.js";
import { assertAttemptId } from "./attempt-store.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

const envelopeSchema = wireObject({
  attemptId: wireString({ maxLength: 256 }),
  sequence: wireNumber({ integer: true, minimum: 0 }),
  events: wireArray(wireCustom({}, decodeAttemptEvent), { maxItems: COLLECTOR_BATCH_EVENTS }),
});

/** Decode from the same owned bytes that are hashed; never accept a caller-supplied digest. */
export async function decodeAttemptBatch(body: Uint8Array): Promise<{
  readonly attemptId: string;
  readonly sequence: number;
  readonly events: readonly PipelineTraceEvent[];
  readonly digest: string;
}> {
  if (body.byteLength > COLLECTOR_BATCH_BYTES) throw new CollectorInputError(413);
  const bytes = new Uint8Array(body);
  const envelope = decodeCollectorJson(bytes, envelopeSchema);
  if (envelope.events.length === 0) throw new CollectorInputError();
  return { ...envelope, digest: await digestCollectorBody(bytes) };
}

/** A fresh, validated current-version event for either transport direction. */
export function decodeAttemptEvent(value: unknown): PipelineTraceEvent {
  try {
    const event = decodeStoredTraceEvent(value);
    if (event.version !== PIPELINE_TRACE_VERSION) throw new CollectorInputError();
    assertAttemptId(event.runId);
    assertAttemptId(event.pipelineId);
    if (event.parentRunId !== undefined) assertAttemptId(event.parentRunId);
    return event;
  } catch {
    throw new CollectorInputError();
  }
}
