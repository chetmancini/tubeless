import { runEventPageLimit } from "./run-store-query.js";
import { readNdjsonArtifact } from "./ndjson-artifact.js";
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
  const events = await readNdjsonArtifact(
    resolvedFilename,
    {
      maxBytes,
      maxLineBytes: maxEventBytes,
      maxRecords: maxEvents,
      kind: "trace",
    },
    (value, id) => ({ ...decodeStoredTraceEvent(value), id })
  );

  // Resolve subtrees through recorded parent links without scanning unrelated runs.
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
      const limit = runEventPageLimit(query.limit);
      let selected = query.runId !== undefined ? (eventsByRun.get(query.runId) ?? []) : events;
      if (query.rootRunId !== undefined) {
        const tree = new Set([query.rootRunId]);
        for (const runId of tree) {
          for (const event of eventsByParent.get(runId) ?? []) tree.add(event.runId);
        }
        selected =
          query.runId !== undefined
            ? tree.has(query.runId)
              ? selected
              : []
            : [...tree]
                .flatMap((runId) => eventsByRun.get(runId) ?? [])
                .sort((a, b) => a.id - b.id);
      }
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
        page.push(structuredClone(event));
      }
      return page;
    },
  };
}
