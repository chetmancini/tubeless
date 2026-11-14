import type { PipelineStepContext } from "../core/pipeline-types.js";
import type { Awaitable } from "./agent-types.js";
import { agentScope } from "./execution-scope.js";

/** Provider-neutral observations; decisions are proposals, not evidence of acceptance. */
export type AgentTranscriptEvent =
  | { readonly kind: "prompt"; readonly task: string; readonly instructions: string }
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "decision"; readonly decision: unknown }
  | { readonly kind: "call"; readonly id: string; readonly tool: string; readonly input: unknown }
  | {
      readonly kind: "outcome";
      readonly outcome:
        | { readonly id: string; readonly tool: string; readonly ok: true; readonly value: unknown }
        | {
            readonly id: string;
            readonly tool: string;
            readonly ok: false;
            readonly error: { readonly code: string; readonly message: string };
          };
      readonly replayed?: boolean;
    }
  | { readonly kind: "compaction"; readonly provider: string }
  | {
      readonly kind: "end";
      readonly status: "completed" | "failed" | "cancelled";
      readonly replayed?: boolean;
    };

/** One bounded inspection record. Omission and limit markers contain no original content. */
export type AgentTranscriptRecord = {
  readonly version: 1;
  readonly agentId: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly sequence: number;
  readonly timestamp: number;
  readonly turn: number;
  readonly dryRun: boolean;
} & (
  | { readonly event: AgentTranscriptEvent }
  | {
      readonly omitted: AgentTranscriptEvent["kind"];
      readonly reason: "record-limit" | "unsupported-content";
    }
  | { readonly limit: "maxBytes" }
);

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

type Settings = Required<Pick<AgentTranscriptOptions, "maxRecordBytes" | "maxBytes">> &
  AgentTranscriptOptions;

/** Snapshot services and bounds when compiling, including the definition reused by sessions. */
export function transcriptSettings(options?: AgentTranscriptOptions): Settings | undefined {
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

class Omitted extends Error {
  constructor(readonly reason: "record-limit" | "unsupported-content") {
    super(reason);
  }
}

type Payload =
  | { event: AgentTranscriptEvent }
  | { omitted: AgentTranscriptEvent["kind"]; reason: Omitted["reason"] };

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** Bound copying work before invoking application code; never invoke getters or toJSON. */
function snapshot<T>(input: T, budget: number): T {
  const ancestors = new Set<object>();
  const charge = (size: number) => {
    budget -= size;
    if (budget < 0) throw new Omitted("record-limit");
  };
  const string = (value: string) => {
    if (value.length > budget) throw new Omitted("record-limit");
    charge(bytes(JSON.stringify(value)));
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (depth > 64) throw new Omitted("unsupported-content");
    if (typeof value === "string") {
      string(value);
      return value;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      if (typeof value === "number" && !Number.isFinite(value))
        throw new Omitted("unsupported-content");
      charge(JSON.stringify(value).length);
      return value;
    }
    if (
      typeof value !== "object" ||
      ancestors.has(value) ||
      (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    )
      throw new Omitted("unsupported-content");
    ancestors.add(value);
    charge(2);
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    if (Array.isArray(value) && value.length > budget) throw new Omitted("record-limit");
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value) && keys.length !== value.length + 1)
      throw new Omitted("unsupported-content");
    let index = 0;
    for (const key of keys) {
      if (Array.isArray(value) && key === "length") continue;
      if (Array.isArray(value) && key !== String(index++)) throw new Omitted("unsupported-content");
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== "string" || !("value" in property) || !property.enumerable)
        throw new Omitted("unsupported-content");
      if (!Array.isArray(value)) string(key);
      charge(2);
      Object.defineProperty(result, key, {
        value: copy(property.value, depth + 1),
        enumerable: true,
      });
    }
    ancestors.delete(value);
    return Object.freeze(result);
  };
  // SAFETY: the bounded plain-data copy preserves JSON-compatible input and freezes it.
  return copy(input, 0) as T;
}

export function agentTranscript(context: object): AgentTranscriptCapture | undefined {
  return agentScope(context)?.transcript;
}

/** Invocation-owned queue and budget; no dependency on traces, storage or provider state. */
export class AgentTranscriptCapture {
  private pending = Promise.resolve();
  private sequence = 0;
  private used = 0;
  private stopped = false;
  turn = 0;

  constructor(
    private readonly settings: Settings,
    private readonly agentId: string,
    private readonly context: PipelineStepContext<object>
  ) {}

  record(turn: number, event: AgentTranscriptEvent): Promise<void> {
    this.turn = turn;
    if (this.stopped) return this.pending;
    let payload: Payload | undefined;
    try {
      // Take ownership at observation time, before another concurrent result can mutate it.
      payload = { event: snapshot(event, this.settings.maxRecordBytes) };
    } catch (error) {
      if (error instanceof Omitted) payload = { omitted: event.kind, reason: error.reason };
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
    if ("event" in payload && redact)
      try {
        const redacted = await redact(payload.event);
        if (redacted === null) return;
        const replacement = snapshot(redacted, maxRecordBytes);
        if (replacement.kind !== kind) throw new Error("Redaction changed event kind");
        payload = { event: replacement };
      } catch (error) {
        if (!(error instanceof Omitted)) throw error;
        payload = { omitted: kind, reason: error.reason };
      }
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
    let record: AgentTranscriptRecord = { ...envelope, ...payload };
    const size = (value: AgentTranscriptRecord) => bytes(JSON.stringify(value)) + 1;
    if (size(record) > maxRecordBytes)
      record = { ...envelope, omitted: kind, reason: "record-limit" };
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
