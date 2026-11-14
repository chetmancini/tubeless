import {
  wireBoolean,
  wireCustom,
  wireEnum,
  wireLiteral,
  wireObject,
  wireNumber,
  wireArray,
  wireRefine,
  wireOptional,
  wireString,
  wireUnion,
  type WireSchema,
} from "./wire-schema.js";

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

export class TranscriptContentOmission extends Error {
  constructor(readonly reason: "record-limit" | "unsupported-content") {
    super(reason);
  }
}

const text = wireString({ allowEmpty: true });
const present = wireCustom({}, (value, path) => {
  if (value === undefined) throw new Error(`${path} is required`);
  return value;
});
const callFields = { id: text, tool: text };
const eventSchemas = {
  prompt: wireObject({ task: text, instructions: text }),
  assistant: wireObject({ text }),
  decision: wireObject({ decision: present }),
  call: wireObject({ ...callFields, input: present }),
  outcome: wireObject({
    outcome: wireUnion([
      wireObject({ ...callFields, ok: wireLiteral(true), value: present }),
      wireObject({
        ...callFields,
        ok: wireLiteral(false),
        error: wireObject({ code: text, message: text }),
      }),
    ]),
    replayed: wireOptional(wireBoolean()),
  }),
  compaction: wireObject({ provider: text }),
  end: wireObject({
    status: wireEnum(["completed", "failed", "cancelled"]),
    replayed: wireOptional(wireBoolean()),
  }),
} satisfies {
  [Kind in AgentTranscriptEvent["kind"]]: WireSchema<
    Omit<Extract<AgentTranscriptEvent, { kind: Kind }>, "kind">
  >;
};

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** Bound copying work before invoking application code; never invoke getters or toJSON. */
export function snapshotTranscriptContent<T>(input: T, budget: number): T {
  const ancestors = new Set<object>();
  const charge = (size: number) => {
    budget -= size;
    if (budget < 0) throw new TranscriptContentOmission("record-limit");
  };
  const string = (value: string) => {
    if (value.length > budget) throw new TranscriptContentOmission("record-limit");
    charge(bytes(JSON.stringify(value)));
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (depth > 64) throw new TranscriptContentOmission("unsupported-content");
    if (typeof value === "string") {
      string(value);
      return value;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      if (typeof value === "number" && !Number.isFinite(value))
        throw new TranscriptContentOmission("unsupported-content");
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
      throw new TranscriptContentOmission("unsupported-content");
    ancestors.add(value);
    charge(2);
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    if (Array.isArray(value) && value.length > budget)
      throw new TranscriptContentOmission("record-limit");
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value) && keys.length !== value.length + 1)
      throw new TranscriptContentOmission("unsupported-content");
    let index = 0;
    for (const key of keys) {
      if (Array.isArray(value) && key === "length") continue;
      if (Array.isArray(value) && key !== String(index++))
        throw new TranscriptContentOmission("unsupported-content");
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== "string" || !("value" in property) || !property.enumerable)
        throw new TranscriptContentOmission("unsupported-content");
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

export function validateTranscriptEvent(event: AgentTranscriptEvent): void {
  if (!Object.hasOwn(eventSchemas, event.kind))
    throw new Error("Unsupported transcript event kind");
  eventSchemas[event.kind].decode(event, "Transcript event");
}

export const MAX_TRANSCRIPT_RECORD_BYTES = 65_536;
export const TRANSCRIPT_PAGE_SIZE = 20;
export const MAX_TRANSCRIPT_PAGE_SIZE = 50;

/** One run's bounded page from a saved transcript; status describes the whole recording. */
export interface AgentTranscriptPage {
  readonly runId: string;
  readonly records: readonly AgentTranscriptRecord[];
  readonly nextSequence?: number;
  readonly status: "unavailable" | "partial" | "complete" | "limited";
}

export interface AgentTranscriptReader {
  list(query: {
    readonly runId: string;
    readonly afterSequence?: number;
    readonly limit?: number;
  }): Promise<AgentTranscriptPage>;
  close(): void | Promise<void>;
}

const envelopeSchema = wireObject({
  version: wireLiteral(1),
  agentId: wireString({ maxLength: 4096 }),
  runId: wireString({ maxLength: 4096 }),
  parentRunId: wireOptional(wireString({ maxLength: 4096 })),
  sequence: wireNumber({ integer: true, minimum: 1 }),
  timestamp: wireNumber(),
  turn: wireNumber({ integer: true, minimum: 0 }),
  dryRun: wireBoolean(),
});

/** Decode at file, writer and transport boundaries without invoking getters or toJSON. */
export function decodeAgentTranscriptRecord(value: unknown): AgentTranscriptRecord {
  const owned = snapshotTranscriptContent(value, MAX_TRANSCRIPT_RECORD_BYTES * 2);
  if (!owned || typeof owned !== "object" || Array.isArray(owned))
    throw new Error("Expected transcript record");
  const envelope = envelopeSchema.decode(owned, "Transcript");
  const fields = owned as Record<string, unknown>;
  if (["event", "omitted", "limit"].filter((key) => Object.hasOwn(fields, key)).length !== 1)
    throw new Error("Transcript requires one event, omission or limit marker");
  let record: AgentTranscriptRecord;
  if (Object.hasOwn(fields, "event")) {
    const event = fields.event;
    if (
      !event ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      !("kind" in event) ||
      typeof event.kind !== "string" ||
      !Object.hasOwn(eventSchemas, event.kind)
    )
      throw new Error("Unsupported transcript event kind");
    // SAFETY: the kind selects a known schema; its required fields are checked before returning.
    const typed = event as AgentTranscriptEvent;
    validateTranscriptEvent(typed);
    if ((typed.kind === "end") !== (envelope.turn === 0))
      throw new Error("Only transcript end events use turn zero");
    record = { ...envelope, event: typed };
  } else if (Object.hasOwn(fields, "omitted")) {
    const omitted = wireEnum([
      "prompt",
      "assistant",
      "decision",
      "call",
      "outcome",
      "compaction",
      "end",
    ]).decode(fields.omitted, "Transcript omission");
    const reason = wireEnum(["record-limit", "unsupported-content"]).decode(
      fields.reason,
      "Transcript omission reason"
    );
    record = { ...envelope, omitted, reason };
  } else {
    wireLiteral("maxBytes").decode(fields.limit, "Transcript limit");
    record = { ...envelope, limit: "maxBytes" };
  }
  if (bytes(JSON.stringify(record)) + 1 > MAX_TRANSCRIPT_RECORD_BYTES)
    throw new Error("Transcript record exceeds 64 KiB");
  return Object.freeze(record);
}

export const agentTranscriptPageSchema: WireSchema<AgentTranscriptPage> = wireRefine(
  wireObject({
    runId: wireString(),
    records: wireArray(wireCustom<AgentTranscriptRecord>({}, decodeAgentTranscriptRecord), {
      maxItems: MAX_TRANSCRIPT_PAGE_SIZE,
    }),
    nextSequence: wireOptional(wireNumber({ integer: true, minimum: 1 })),
    status: wireEnum(["unavailable", "partial", "complete", "limited"]),
  }),
  (page) => {
    let previous = 0;
    for (const record of page.records) {
      if (record.runId !== page.runId || record.sequence <= previous)
        throw new Error("Transcript page contains mismatched or unordered records");
      previous = record.sequence;
    }
    if (
      page.nextSequence !== undefined &&
      (page.records.length === 0 || page.nextSequence !== previous)
    )
      throw new Error("Invalid transcript page cursor");
  }
);
