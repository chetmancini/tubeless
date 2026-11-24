import { decodeStoredTraceEvent } from "../run-store/run-store-event-decoder.js";
import { PIPELINE_TRACE_VERSION } from "../tracing/tracing-constants.js";
import { sha256Hex } from "../utilities/sha256.js";
import {
  wireArray,
  wireCustom,
  wireNumber,
  wireObject,
  wireOptional,
  type WireSchema,
} from "../tracing/wire-schema.js";
import {
  COLLECTOR_BATCH_BYTES,
  COLLECTOR_BATCH_EVENTS,
  CollectorInputError,
  decodeCollectorJson,
  collectorId,
} from "./collector-protocol.js";
import { assertAttemptId } from "./attempt-store.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

const envelope = {
  attemptId: collectorId,
  sequence: wireNumber({ integer: true, minimum: 0 }),
};
const collectorEnvelope = wireObject(
  {
    ...envelope,
    events: wireArray(wireCustom({}, decodeAttemptEvent), { maxItems: COLLECTOR_BATCH_EVENTS }),
  },
  { strict: true }
);
const runnerEnvelope = wireObject(
  {
    ...envelope,
    events: wireArray(wireCustom({}, decodeCurrentTraceEvent), {
      maxItems: COLLECTOR_BATCH_EVENTS,
    }),
    report: wireOptional(wireCustom<unknown>({}, (value) => value)),
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

/** A runner child sends its root completion and validated report under one sequence. */
export function encodeRunnerCompletion(
  attemptId: string,
  sequence: number,
  event: PipelineTraceEvent,
  report: unknown
): Uint8Array {
  const body = new TextEncoder().encode(
    JSON.stringify({ attemptId, sequence, events: [event], report })
  );
  if (body.byteLength > COLLECTOR_BATCH_BYTES) throw new CollectorInputError(413);
  return body;
}

interface DecodedAttemptBatch {
  readonly attemptId: string;
  readonly sequence: number;
  readonly events: readonly PipelineTraceEvent[];
  readonly digest: string;
}

export function decodeAttemptBatch(body: Uint8Array): Promise<DecodedAttemptBatch> {
  return decodeBatch(body, collectorEnvelope);
}

export function decodeRunnerBatch(
  body: Uint8Array
): Promise<DecodedAttemptBatch & { readonly report?: unknown }> {
  return decodeBatch(body, runnerEnvelope);
}

/** Hash the exact decoded bytes so retransmissions can be checked across transports. */
async function decodeBatch<T extends { events: PipelineTraceEvent[] }>(
  body: Uint8Array,
  schema: WireSchema<T>
): Promise<T & { digest: string }> {
  if (body.byteLength > COLLECTOR_BATCH_BYTES) throw new CollectorInputError(413);
  const bytes = new Uint8Array(body);
  const envelope = decodeCollectorJson(bytes, schema);
  if (envelope.events.length === 0) throw new CollectorInputError();
  return { ...envelope, digest: await sha256Hex(bytes) };
}

/** A fresh, validated current-version event for either transport direction. */
export function decodeAttemptEvent(value: unknown): PipelineTraceEvent {
  const event = decodeCurrentTraceEvent(value);
  assertAttemptId(event.runId);
  assertAttemptId(event.pipelineId);
  if (event.parentRunId !== undefined) assertAttemptId(event.parentRunId);
  return event;
}

function decodeCurrentTraceEvent(value: unknown): PipelineTraceEvent {
  const event = decodeStoredTraceEvent(value);
  if (event.version !== PIPELINE_TRACE_VERSION) throw new CollectorInputError();
  return event;
}
