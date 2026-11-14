import type { PipelineStepContext } from "../core/pipeline-types.js";
import type { Awaitable } from "./agent-types.js";
import { agentScope } from "./execution-scope.js";
import {
  snapshotTranscriptContent,
  TranscriptContentOmission,
  validateTranscriptEvent,
  type AgentTranscriptEvent,
  type AgentTranscriptRecord,
} from "../tracing/agent-transcript.js";
export type { AgentTranscriptEvent, AgentTranscriptRecord } from "../tracing/agent-transcript.js";

/** Explicit content capture; applications own storage, retention and I/O deadlines. */
export interface AgentTranscriptOptions {
  /** Awaited in sequence order per invocation. Failure disables capture, not the agent. */
  readonly write: (record: AgentTranscriptRecord) => Awaitable<void>;
  /** Receives an owned frozen event. Return the same kind with redactions, or null to drop it. */
  readonly redact?: (event: AgentTranscriptEvent) => Awaitable<AgentTranscriptEvent | null>;
  /** Full JSON record plus newline. Defaults to 65536; allowed range 1024..65536 bytes. */
  readonly maxRecordBytes?: number;
  /** Per invocation, including a reserved limit marker. Defaults to 1048576; at least twice maxRecordBytes, at most 16777216. */
  readonly maxBytes?: number;
}

export type AgentTranscriptSettings = Required<
  Pick<AgentTranscriptOptions, "maxRecordBytes" | "maxBytes">
> &
  AgentTranscriptOptions;

/** Snapshot services and bounds when compiling, including the definition reused by sessions. */
export function transcriptSettings(
  options?: AgentTranscriptOptions
): AgentTranscriptSettings | undefined {
  if (options === undefined) return undefined;
  const { write, redact, maxRecordBytes = 65_536, maxBytes = 1_048_576 } = options ?? {};
  if (
    typeof write !== "function" ||
    (redact !== undefined && typeof redact !== "function") ||
    !Number.isSafeInteger(maxRecordBytes) ||
    maxRecordBytes < 1024 ||
    maxRecordBytes > 65_536 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 2 * maxRecordBytes ||
    maxBytes > 16_777_216
  )
    throw Object.assign(new Error("Invalid agent transcript configuration"), {
      code: "TUBELESS_AGENT_INVALID_DEFINITION",
    });
  return Object.freeze({ write, redact, maxRecordBytes, maxBytes });
}

type Payload =
  | { event: AgentTranscriptEvent }
  | { omitted: AgentTranscriptEvent["kind"]; reason: TranscriptContentOmission["reason"] };

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

export function agentTranscript(context: object): AgentTranscriptCapture | undefined {
  return agentScope(context)?.transcript;
}

/** Invocation-owned queue and budget; no dependency on traces, storage or provider state. */
export class AgentTranscriptCapture {
  private pending = Promise.resolve();
  private sequence = 0;
  private used = 0;
  private stopped = false;
  constructor(
    private readonly settings: AgentTranscriptSettings,
    private readonly agentId: string,
    private readonly context: PipelineStepContext<object>
  ) {}

  record(turn: number, event: AgentTranscriptEvent): Promise<void> {
    if (this.stopped) return this.pending;
    let payload: Payload | undefined;
    try {
      // Take ownership at observation time, before another concurrent result can mutate it.
      payload = { event: snapshotTranscriptContent(event, this.settings.maxRecordBytes) };
    } catch (error) {
      if (error instanceof TranscriptContentOmission)
        payload = { omitted: event.kind, reason: error.reason };
    }
    this.pending = this.pending.then(async () => {
      if (this.stopped) return;
      try {
        if (!payload) throw new Error("Transcript content could not be copied");
        await this.deliver(turn, payload);
      } catch {
        this.stopped = true;
        // Never include redactor/sink errors: they can contain the original private data.
        try {
          this.context.log.warn("Agent transcript capture disabled after a capture error");
        } catch {
          // Observability must not change the agent result, even with a failing logger.
        }
      }
    });
    return this.pending;
  }

  private async deliver(turn: number, payload: Payload): Promise<void> {
    const { maxRecordBytes, maxBytes, redact, write } = this.settings;
    const kind = "event" in payload ? payload.event.kind : payload.omitted;
    const envelope = {
      version: 1 as const,
      agentId: this.agentId,
      runId: this.context.runId,
      ...(this.context.parentRunId === undefined ? {} : { parentRunId: this.context.parentRunId }),
      sequence: this.sequence + 1,
      timestamp: this.context.now(),
      turn,
      dryRun: this.context.dryRun,
    };
    const size = (value: AgentTranscriptRecord) => bytes(JSON.stringify(value)) + 1;
    const bound = (content: Payload): AgentTranscriptRecord => {
      const record = { ...envelope, ...content };
      return size(record) <= maxRecordBytes
        ? record
        : { ...envelope, omitted: kind, reason: "record-limit" };
    };
    let record = bound(payload);
    if ("event" in record && redact)
      try {
        const redacted = await redact(record.event);
        if (redacted === null) return;
        const replacement = snapshotTranscriptContent(redacted, maxRecordBytes);
        if (replacement.kind !== kind) throw new Error("Redaction changed event kind");
        validateTranscriptEvent(replacement);
        record = bound({ event: replacement });
      } catch (error) {
        if (!(error instanceof TranscriptContentOmission)) throw error;
        record = bound({ omitted: kind, reason: error.reason });
      }
    if (this.used + size(record) > maxBytes - maxRecordBytes) {
      record = { ...envelope, limit: "maxBytes" };
      this.stopped = true;
    }
    if (size(record) > maxRecordBytes || this.used + size(record) > maxBytes)
      throw new Error("Transcript envelope exceeds byte limit");
    this.sequence++;
    this.used += size(record);
    await write(Object.freeze(record));
  }
}
