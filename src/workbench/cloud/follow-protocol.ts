import { awaitWithAbort, throwIfAborted } from "../../utilities/abort.js";
import { isJsonObject } from "../../utilities/canonical-json.js";
import { CloudClientError, isCloudRunStatus, type CliLogLine, type CliRun } from "./protocol.js";

export const FOLLOW_MEDIA_TYPE = "application/x-ndjson";
const MAX_EVENT_BYTES = 32 * 1024;
const MAX_STREAM_BYTES = 256 * 1024;
const MAX_STREAM_EVENTS = 128;

export function isFollowCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2400;
}

export function assertRunFollowingCapability(capability: unknown): void {
  if (capability === undefined)
    throw new CloudClientError(
      "This Cloud service does not advertise run following. Attach with --poll to use retained status and logs.",
      "unsupported_capability"
    );
  if (
    !isJsonObject(capability) ||
    !Number.isSafeInteger(capability.version) ||
    typeof capability.transport !== "string"
  )
    throw new CloudClientError(
      "Cloud returned invalid run-following discovery.",
      "invalid_response"
    );
  if (capability.version !== 1 || capability.transport !== "ndjson")
    throw new CloudClientError(
      "This CLI does not support the Cloud service's run-following version or transport. Use --poll for retained status and logs.",
      "unsupported_capability"
    );
}

type FollowOutcome = "completed" | "failed" | "cancelled" | "interrupted";
type FollowProjection = Pick<CliRun, "pipelineId" | "status">;
export type FollowLog = Omit<CliLogLine, "time"> & {
  position: number;
  time?: number;
  command?: string;
  channel?: "stdout" | "stderr";
  truncated?: boolean;
};
export type FollowGap =
  | { reason: "retention"; from: number; through: number }
  | {
      reason: "retention" | "source_truncated" | "output_unavailable";
      from?: never;
      through?: never;
    };
type ResumableEnd = "deadline" | "backpressure" | "unavailable";
type FollowEnd =
  | { reason: ResumableEnd; resumable: true }
  | { reason: "authorization_lost" | "run_unavailable"; resumable: false };

export type FollowEvent = { cursor: string } & (
  | { type: "snapshot" | "progress"; payload: { run: FollowProjection } }
  | { type: "terminal"; payload: { run: FollowProjection; outcome: FollowOutcome } }
  | { type: "log"; payload: FollowLog }
  | { type: "gap"; payload: FollowGap }
  | { type: "heartbeat"; payload: Record<string, never> }
  | { type: "end"; payload: FollowEnd }
);
export type FollowBoundary = Extract<FollowEvent, { type: "end" | "terminal" }>;

function invalidStream(): never {
  throw new CloudClientError("Cloud returned an invalid run-following stream.", "invalid_response");
}

function positivePosition(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseEvent(value: unknown, workspace: string, runId: string): FollowEvent {
  if (
    !isJsonObject(value) ||
    value.version !== 1 ||
    value.workspaceId !== workspace ||
    value.runId !== runId ||
    !isFollowCursor(value.cursor) ||
    !isJsonObject(value.payload)
  )
    return invalidStream();
  const { cursor, type, payload } = value;
  switch (type) {
    case "snapshot":
    case "progress":
    case "terminal": {
      const { run, outcome, truncatedFields } = payload;
      // Follow projections omit input and logs and can truncate other fields.
      // The terminal status read decodes the full projection with parseCliRun.
      if (
        !isJsonObject(run) ||
        run.id !== runId ||
        typeof run.pipelineId !== "string" ||
        !run.pipelineId ||
        typeof run.pipelineName !== "string" ||
        !isCloudRunStatus(run.status) ||
        !nonnegativeNumber(run.createdAt) ||
        run.createdAt > 8.64e15 ||
        !nonnegativeNumber(run.durationMs) ||
        (truncatedFields !== undefined &&
          (!Array.isArray(truncatedFields) ||
            !truncatedFields.every((field: unknown) => typeof field === "string")))
      )
        return invalidStream();
      const projection = { pipelineId: run.pipelineId, status: run.status };
      if (type !== "terminal") return { cursor, type, payload: { run: projection } };
      if (
        (outcome === "completed" ||
          outcome === "failed" ||
          outcome === "cancelled" ||
          outcome === "interrupted") &&
        (outcome === "interrupted" ? "failed" : outcome) === run.status
      )
        return { cursor, type, payload: { run: projection, outcome } };
      break;
    }
    case "log": {
      const { position, level, message, time, command, channel, truncated } = payload;
      if (
        positivePosition(position) &&
        (level === "info" || level === "warn" || level === "error") &&
        typeof message === "string" &&
        message.length <= 4000 &&
        (time === undefined || (nonnegativeNumber(time) && time <= 8.64e15)) &&
        (command === undefined || typeof command === "string") &&
        (channel === undefined || channel === "stdout" || channel === "stderr") &&
        (truncated === undefined || typeof truncated === "boolean")
      )
        return {
          cursor,
          type,
          payload: { position, level, message, time, command, channel, truncated },
        };
      break;
    }
    case "gap": {
      const { reason, from, through } = payload;
      if (
        reason === "retention" &&
        positivePosition(from) &&
        positivePosition(through) &&
        through >= from
      )
        return { cursor, type, payload: { reason, from, through } };
      if (
        (reason === "retention" ||
          reason === "source_truncated" ||
          reason === "output_unavailable") &&
        from === undefined &&
        through === undefined
      )
        return { cursor, type, payload: { reason } };
      break;
    }
    case "heartbeat":
      if (Object.keys(payload).length === 0) return { cursor, type, payload: {} };
      break;
    case "end": {
      const { reason, resumable } = payload;
      if (
        resumable === true &&
        (reason === "deadline" || reason === "backpressure" || reason === "unavailable")
      )
        return { cursor, type, payload: { reason, resumable } };
      if (resumable === false && (reason === "authorization_lost" || reason === "run_unavailable"))
        return { cursor, type, payload: { reason, resumable } };
      break;
    }
  }
  return invalidStream();
}

export async function readFollowStream(
  body: ReadableStream<Uint8Array>,
  workspace: string,
  runId: string,
  signal: AbortSignal,
  consume: (event: FollowEvent) => Promise<void>
): Promise<FollowBoundary> {
  const line = new Uint8Array(MAX_EVENT_BYTES);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = body.getReader();
  let size = 0;
  let total = 0;
  let count = 0;
  try {
    for (;;) {
      throwIfAborted(signal, "Cloud observation");
      const chunk = await awaitWithAbort(reader.read(), signal, "Cloud observation");
      if (chunk.done)
        throw new CloudClientError(
          "Cloud connection ended before a terminal event or observation boundary.",
          "transport_error"
        );
      total += chunk.value.byteLength;
      if (total > MAX_STREAM_BYTES) return invalidStream();
      for (let start = 0; start < chunk.value.length;) {
        const newline = chunk.value.indexOf(10, start);
        const end = newline === -1 ? chunk.value.length : newline;
        if (size + end - start >= line.length) return invalidStream();
        line.set(chunk.value.subarray(start, end), size);
        size += end - start;
        if (newline === -1) break;
        let value: unknown;
        try {
          value = JSON.parse(decoder.decode(line.subarray(0, size)));
        } catch {
          return invalidStream();
        }
        const event = parseEvent(value, workspace, runId);
        // Cloud can close observation during the first disclosure check.
        if (
          ++count > MAX_STREAM_EVENTS ||
          (count === 1
            ? event.type !== "snapshot" && event.type !== "end"
            : event.type === "snapshot")
        )
          return invalidStream();
        await consume(event);
        if (event.type === "terminal" || event.type === "end") return event;
        size = 0;
        start = newline + 1;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
