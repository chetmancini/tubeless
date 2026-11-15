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

const envelopeSchema = wireObject(
  {
    attemptId: wireString({ maxLength: 256 }),
    sequence: wireNumber({ integer: true, minimum: 0 }),
    events: wireArray(wireCustom({}, decodeAttemptEvent), { maxItems: COLLECTOR_BATCH_EVENTS }),
  },
  { strict: true }
);

/** Prepare every bounded envelope before delivery so an oversized event cannot cause partial writes. */
export function encodeAttemptBatches(
  attemptId: string,
  sequence: number,
  events: readonly PipelineTraceEvent[]
): Uint8Array[] {
  if (events.length === 0) throw new CollectorInputError();
  const batches: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let group: PipelineTraceEvent[] = [];
  const encode = (items: PipelineTraceEvent[]) =>
    encoder.encode(
      JSON.stringify({
        attemptId,
        sequence: sequence + batches.length,
        events: items,
      })
    );
  for (const event of events) {
    const candidate = [...group, event];
    if (
      candidate.length > COLLECTOR_BATCH_EVENTS ||
      encode(candidate).byteLength > COLLECTOR_BATCH_BYTES
    ) {
      if (group.length === 0) throw new CollectorInputError(413);
      batches.push(encode(group));
      group = [];
    }
    group.push(event);
    if (encode(group).byteLength > COLLECTOR_BATCH_BYTES) throw new CollectorInputError(413);
  }
  if (group.length) batches.push(encode(group));
  return batches;
}

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
  const event = decodeStoredTraceEvent(value);
  if (event.version !== PIPELINE_TRACE_VERSION) throw new CollectorInputError();
  assertAttemptId(event.runId);
  assertAttemptId(event.pipelineId);
  if (event.parentRunId !== undefined) assertAttemptId(event.parentRunId);
  return event;
}
