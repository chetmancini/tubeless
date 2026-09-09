import { open } from "node:fs/promises";
import * as path from "node:path";
import type {
  PipelineErrorCause,
  PipelineErrorCode,
  PipelineErrorKind,
  PipelineErrorPhase,
  PipelineValidationIssue,
} from "./pipeline.js";
import type {
  PipelineRunEventQuery,
  PipelineRunEventReader,
  StoredPipelineEvent,
} from "./run-store.js";
import type {
  PipelineTraceAttributes,
  PipelineTraceError,
  PipelineTraceEvent,
  PipelineTraceEventName,
} from "./tracing.js";

const DEFAULT_MAX_BYTES = 64 * 1_024 * 1_024;
const DEFAULT_MAX_EVENT_BYTES = 1 * 1_024 * 1_024;
const DEFAULT_MAX_EVENTS = 100_000;

const eventNames: ReadonlySet<string> = new Set([
  "pipeline.completed",
  "pipeline.log",
  "pipeline.started",
  "pipeline.finalize.completed",
  "pipeline.finalize.failed",
  "pipeline.finalize.started",
  "step.attempted",
  "step.cancelled",
  "step.failed",
  "step.planned",
  "step.running",
  "step.skipped",
  "step.complete",
]);
const errorKinds: ReadonlySet<string> = new Set([
  "cancellation",
  "child",
  "definition",
  "finalization",
  "selection",
  "step",
  "validation",
]);
const errorPhases: ReadonlySet<string> = new Set([
  "definition",
  "execution",
  "finalization",
  "planning",
]);
const errorCodes: ReadonlySet<string> = new Set([
  "TUBELESS_CHILD_FAILED",
  "TUBELESS_DEFINITION_DEPENDENCY_CONTRADICTORY",
  "TUBELESS_DEFINITION_DEPENDENCY_CYCLE",
  "TUBELESS_DEFINITION_DEPENDENCY_DUPLICATE",
  "TUBELESS_DEFINITION_DEPENDENCY_NOT_IN_STEPS",
  "TUBELESS_DEFINITION_DEPENDENCY_SELF_REFERENCE",
  "TUBELESS_DEFINITION_FINALIZER_STEP_NOT_IN_STEPS",
  "TUBELESS_DEFINITION_PIPELINE_ID_BLANK",
  "TUBELESS_DEFINITION_OPTIONS_SCHEMA_CONFLICT",
  "TUBELESS_DEFINITION_STEP_ID_BLANK",
  "TUBELESS_DEFINITION_STEP_ID_RESERVED",
  "TUBELESS_DEFINITION_STEP_IDS_DUPLICATE",
  "TUBELESS_DEFINITION_STEP_NAME_BLANK",
  "TUBELESS_DEFINITION_TARGET_FINALIZER_MISMATCH",
  "TUBELESS_DEFINITION_TARGET_NOT_IN_STEPS",
  "TUBELESS_DEFINITION_TARGETS_DUPLICATE",
  "TUBELESS_FINALIZATION_CANCELLED",
  "TUBELESS_FINALIZATION_FAILED",
  "TUBELESS_FINAL_RESULT_VALIDATION_FAILED",
  "TUBELESS_OPTIONS_VALIDATION_FAILED",
  "TUBELESS_PLANNING_SELECTION_CONFLICT",
  "TUBELESS_PLANNING_STEP_SELECTION_DUPLICATE",
  "TUBELESS_PLANNING_STEP_SELECTION_EMPTY",
  "TUBELESS_PLANNING_STEP_UNKNOWN",
  "TUBELESS_PLANNING_TARGET_SELECTION_DUPLICATE",
  "TUBELESS_PLANNING_TARGET_SELECTION_EMPTY",
  "TUBELESS_PLANNING_TARGET_UNDECLARED",
  "TUBELESS_PLANNING_TARGET_UNKNOWN",
  "TUBELESS_RUN_CANCELLED",
  "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED",
  "TUBELESS_STEP_FAILED",
]);

/** Bounds applied while opening an untrusted NDJSON trace artifact. */
export interface OpenNdjsonPipelineRunStoreOptions {
  /** Maximum artifact size. Defaults to 64 MiB. */
  readonly maxBytes?: number;
  /** Maximum size of one event line. Defaults to 1 MiB. */
  readonly maxEventBytes?: number;
  /** Maximum non-blank event lines. Defaults to 100,000. */
  readonly maxEvents?: number;
}

/** A read-only, in-memory view of one validated NDJSON trace artifact. */
export interface NdjsonPipelineRunStore extends PipelineRunEventReader {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEventName(value: string): value is PipelineTraceEventName {
  return eventNames.has(value);
}

function isErrorCode(value: string): value is PipelineErrorCode {
  return errorCodes.has(value);
}

function isErrorKind(value: string): value is PipelineErrorKind {
  return errorKinds.has(value);
}

function isErrorPhase(value: string): value is PipelineErrorPhase {
  return errorPhases.has(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function finiteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function parseAttributes(value: unknown): PipelineTraceAttributes {
  if (!isRecord(value)) throw new Error("attributes must be an object");
  const attributes: Record<string, boolean | number | string> = {};
  for (const [key, attribute] of Object.entries(value)) {
    if (
      typeof attribute !== "boolean" &&
      typeof attribute !== "string" &&
      (typeof attribute !== "number" || !Number.isFinite(attribute))
    ) {
      throw new Error("attribute values must be booleans, finite numbers, or strings");
    }
    attributes[key] = attribute;
  }
  return attributes;
}

function parseCause(value: unknown, depth = 0): PipelineErrorCause {
  if (!isRecord(value)) throw new Error("error.cause must be an object");
  if (depth >= 16) throw new Error("error.cause exceeds 16 levels");
  const cause: PipelineErrorCause = { message: requiredString(value, "message") };
  const name = optionalString(value, "name");
  if (name !== undefined) cause.name = name;
  const sourceCode = optionalString(value, "sourceCode");
  if (sourceCode !== undefined) cause.sourceCode = sourceCode;
  if (value.cause !== undefined) cause.cause = parseCause(value.cause, depth + 1);
  return cause;
}

function parseIssues(value: unknown): readonly PipelineValidationIssue[] {
  if (!Array.isArray(value)) throw new Error("error.issues must be an array");
  return value.map((issue, issueIndex) => {
    if (!isRecord(issue)) throw new Error(`error.issues[${issueIndex}] must be an object`);
    const parsed: PipelineValidationIssue = { message: requiredString(issue, "message") };
    if (issue.path !== undefined) {
      if (
        !Array.isArray(issue.path) ||
        !issue.path.every(
          (part) => typeof part === "string" || (typeof part === "number" && Number.isFinite(part))
        )
      ) {
        throw new Error(`error.issues[${issueIndex}].path must contain strings or finite numbers`);
      }
      parsed.path = issue.path;
    }
    return parsed;
  });
}

function parseError(value: unknown): PipelineTraceError {
  if (!isRecord(value)) throw new Error("error must be an object");
  const code = requiredString(value, "code");
  const kind = requiredString(value, "kind");
  const phase = requiredString(value, "phase");
  if (!isErrorCode(code)) throw new Error("error.code is unsupported");
  if (!isErrorKind(kind)) throw new Error("error.kind is unsupported");
  if (!isErrorPhase(phase)) throw new Error("error.phase is unsupported");
  const error: PipelineTraceError = {
    code,
    kind,
    message: requiredString(value, "message"),
    phase,
  };
  if (value.cause !== undefined) error.cause = parseCause(value.cause);
  if (value.issues !== undefined) error.issues = parseIssues(value.issues);
  const sourceCode = optionalString(value, "sourceCode");
  if (sourceCode !== undefined) error.sourceCode = sourceCode;
  const stack = optionalString(value, "stack");
  if (stack !== undefined) error.stack = stack;
  return error;
}

function parseEvent(value: unknown): PipelineTraceEvent {
  if (!isRecord(value)) throw new Error("event must be an object");
  if (value.version !== 1) throw new Error("version must be 1");
  const name = requiredString(value, "name");
  if (!isEventName(name)) throw new Error("name is unsupported");
  const event: PipelineTraceEvent = {
    attributes: parseAttributes(value.attributes),
    name,
    pipelineId: requiredString(value, "pipelineId"),
    runId: requiredString(value, "runId"),
    timestampMs: finiteNumber(value, "timestampMs"),
    version: 1,
  };
  const attemptId = optionalString(value, "attemptId");
  if (attemptId !== undefined) event.attemptId = attemptId;
  if (value.durationMs !== undefined) event.durationMs = finiteNumber(value, "durationMs");
  if (value.error !== undefined) event.error = parseError(value.error);
  const itemKey = optionalString(value, "itemKey");
  if (itemKey !== undefined) event.itemKey = itemKey;
  const parentRunId = optionalString(value, "parentRunId");
  if (parentRunId !== undefined) event.parentRunId = parentRunId;
  const stepId = optionalString(value, "stepId");
  if (stepId !== undefined) event.stepId = stepId;
  return event;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

/**
 * Open and validate an NDJSON trace without modifying it. Events receive
 * zero-based, store-local ids in file order. The file is fully read and closed
 * during this call, so later filesystem changes cannot alter the returned view.
 */
export async function openNdjsonPipelineRunStore(
  filename: string,
  options: OpenNdjsonPipelineRunStoreOptions = {}
): Promise<NdjsonPipelineRunStore> {
  const resolvedFilename = path.resolve(filename);
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const maxEventBytes = positiveInteger(
    options.maxEventBytes,
    DEFAULT_MAX_EVENT_BYTES,
    "maxEventBytes"
  );
  const maxEvents = positiveInteger(options.maxEvents, DEFAULT_MAX_EVENTS, "maxEvents");
  const handle = await open(resolvedFilename, "r");
  let contents: Buffer;
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error(`${resolvedFilename} is not a regular file.`);
    if (fileStat.size > maxBytes) {
      throw new Error(`${resolvedFilename} exceeds the ${maxBytes}-byte NDJSON trace limit.`);
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > maxBytes) {
        throw new Error(`${resolvedFilename} exceeds the ${maxBytes}-byte NDJSON trace limit.`);
      }
      chunks.push(buffer);
    }
    contents = Buffer.concat(chunks, byteLength);
  } finally {
    await handle.close();
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const events: StoredPipelineEvent[] = [];
  let lineNumber = 0;
  let lineStart = 0;
  for (let cursor = 0; cursor <= contents.length; cursor += 1) {
    if (cursor < contents.length && contents[cursor] !== 0x0a) continue;
    lineNumber += 1;
    let lineEnd = cursor;
    if (lineEnd > lineStart && contents[lineEnd - 1] === 0x0d) lineEnd -= 1;
    const byteLength = lineEnd - lineStart;
    if (byteLength > maxEventBytes) {
      throw new Error(
        `${resolvedFilename} line ${lineNumber} exceeds the ${maxEventBytes}-byte event limit.`
      );
    }
    const line = contents.subarray(lineStart, lineEnd);
    lineStart = cursor + 1;
    if (line.every((byte) => byte === 0x20 || byte === 0x09)) continue;
    if (events.length >= maxEvents) {
      throw new Error(`${resolvedFilename} exceeds the ${maxEvents}-event NDJSON trace limit.`);
    }
    let decoded: string;
    try {
      decoded = decoder.decode(line);
    } catch {
      throw new Error(`${resolvedFilename} line ${lineNumber} is not valid UTF-8.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new Error(`${resolvedFilename} line ${lineNumber} is not valid JSON.`);
    }
    try {
      const event = parseEvent(parsed);
      events.push({ ...event, id: events.length });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "event is invalid";
      throw new Error(`${resolvedFilename} line ${lineNumber} is invalid: ${detail}.`);
    }
  }

  let closed = false;
  return {
    close() {
      closed = true;
    },
    async listEvents(query: PipelineRunEventQuery = {}) {
      if (closed) throw new Error("Cannot query a closed NDJSON pipeline run store.");
      const limit = Math.max(1, Math.min(100_000, Math.floor(query.limit ?? 20_000)));
      return events
        .filter(
          (event) =>
            (query.afterId === undefined || event.id > query.afterId) &&
            (query.pipelineId === undefined || event.pipelineId === query.pipelineId) &&
            (query.runId === undefined || event.runId === query.runId)
        )
        .slice(0, limit)
        .map((event) => structuredClone(event));
    },
  };
}
