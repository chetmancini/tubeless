import { resolve } from "node:path";
import {
  decodeAgentTranscriptRecord,
  MAX_TRANSCRIPT_RECORD_BYTES,
  MAX_TRANSCRIPT_PAGE_SIZE,
  TRANSCRIPT_PAGE_SIZE,
  type AgentTranscriptRecord,
  type AgentTranscriptReader,
  type AgentTranscriptPage,
} from "../tracing/agent-transcript.js";
import { readNdjsonArtifact } from "./ndjson-artifact.js";

/** Open a validated, read-only snapshot. Later appends require reopening the artifact. */
export async function openNdjsonAgentTranscriptReader(
  filename: string
): Promise<AgentTranscriptReader> {
  const records = await readNdjsonArtifact(
    resolve(filename),
    {
      maxBytes: 64 * 1024 * 1024,
      maxLineBytes: MAX_TRANSCRIPT_RECORD_BYTES - 1,
      maxRecords: 100_000,
      kind: "transcript",
    },
    decodeAgentTranscriptRecord
  );
  const runs = new Map<string, Map<number, AgentTranscriptRecord>>();
  for (const record of records) {
    const run = runs.get(record.runId) ?? new Map();
    const first = run.values().next().value;
    if (
      first &&
      (first.agentId !== record.agentId ||
        first.parentRunId !== record.parentRunId ||
        first.dryRun !== record.dryRun)
    )
      throw new Error("Transcript run identity changes within the artifact");
    const previous = run.get(record.sequence);
    if (previous && JSON.stringify(previous) !== JSON.stringify(record))
      throw new Error("Conflicting transcript records share a run ID and sequence");
    run.set(record.sequence, record);
    runs.set(record.runId, run);
  }
  const indexed = new Map(
    [...runs].map(([id, entries]) => {
      const records = [...entries.values()].sort((a, b) => a.sequence - b.sequence);
      const last = records.at(-1)!;
      const hasGaps = records.some((record, index) => record.sequence !== index + 1);
      const status: AgentTranscriptPage["status"] = hasGaps
        ? "partial"
        : "limit" in last
          ? "limited"
          : "event" in last && last.event.kind === "end"
            ? "complete"
            : "partial";
      return [id, { records, status }] as const;
    })
  );
  let closed = false;
  return {
    close() {
      closed = true;
    },
    async list({ runId, afterSequence = 0, limit = TRANSCRIPT_PAGE_SIZE }) {
      if (closed) throw new Error("Cannot read a closed transcript artifact");
      if (
        !Number.isSafeInteger(afterSequence) ||
        afterSequence < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > MAX_TRANSCRIPT_PAGE_SIZE
      )
        throw new Error("Invalid transcript cursor or page size");
      const run = indexed.get(runId);
      const all = run?.records ?? [];
      let start = 0;
      let end = all.length;
      while (start < end) {
        const middle = Math.floor((start + end) / 2);
        if (all[middle]!.sequence <= afterSequence) start = middle + 1;
        else end = middle;
      }
      const page = all.slice(start, start + limit);
      return {
        runId,
        records: structuredClone(page),
        status: run?.status ?? "unavailable",
        ...(start + page.length < all.length ? { nextSequence: page.at(-1)!.sequence } : {}),
      };
    },
  };
}
