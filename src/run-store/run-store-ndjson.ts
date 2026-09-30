import { open } from "node:fs/promises";
import * as path from "node:path";
import type {
  PipelineRunEventQuery,
  PipelineRunEventReader,
  StoredPipelineEvent,
} from "./run-store.js";
import { decodeStoredTraceEvent } from "./run-store-event-decoder.js";

const DEFAULT_MAX_BYTES = 64 * 1_024 * 1_024;
const DEFAULT_MAX_EVENT_BYTES = 1 * 1_024 * 1_024;
const DEFAULT_MAX_EVENTS = 100_000;

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
      const event = decodeStoredTraceEvent(parsed);
      events.push({ ...event, id: events.length });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "event is invalid";
      throw new Error(`${resolvedFilename} line ${lineNumber} is invalid: ${detail}.`);
    }
  }

  // Descendant traversal queries each parent separately. Keep those queries
  // local to its children instead of rescanning the full trace for every run.
  const eventsByRun = new Map<string, StoredPipelineEvent[]>();
  const eventsByParent = new Map<string, StoredPipelineEvent[]>();
  for (const event of events) {
    const runEvents = eventsByRun.get(event.runId) ?? [];
    runEvents.push(event);
    eventsByRun.set(event.runId, runEvents);
    if (event.parentRunId !== undefined) {
      const childEvents = eventsByParent.get(event.parentRunId) ?? [];
      childEvents.push(event);
      eventsByParent.set(event.parentRunId, childEvents);
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
      const selected =
        query.runId !== undefined
          ? (eventsByRun.get(query.runId) ?? [])
          : query.parentRunId !== undefined
            ? (eventsByParent.get(query.parentRunId) ?? [])
            : events;
      // Buckets retain file order. Seek past the cursor without revisiting
      // preceding pages, including when the reader requests very small pages.
      let start = 0;
      let end = selected.length;
      if (query.afterId !== undefined) {
        while (start < end) {
          const middle = Math.floor((start + end) / 2);
          if (selected[middle]!.id > query.afterId) end = middle;
          else start = middle + 1;
        }
      }
      const page: StoredPipelineEvent[] = [];
      for (let index = start; index < selected.length && page.length < limit; index++) {
        const event = selected[index]!;
        if (query.pipelineId !== undefined && event.pipelineId !== query.pipelineId) continue;
        if (query.parentRunId !== undefined && event.parentRunId !== query.parentRunId) continue;
        page.push(structuredClone(event));
      }
      return page;
    },
  };
}
