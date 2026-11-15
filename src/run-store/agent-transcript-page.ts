import {
  MAX_TRANSCRIPT_PAGE_SIZE,
  TRANSCRIPT_PAGE_SIZE,
  type AgentTranscriptReader,
  type AgentTranscriptRecord,
  type AgentTranscriptPage,
} from "../tracing/agent-transcript.js";

export function transcriptPageQuery({
  runId,
  afterSequence = 0,
  limit = TRANSCRIPT_PAGE_SIZE,
}: Parameters<AgentTranscriptReader["list"]>[0]) {
  if (
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_TRANSCRIPT_PAGE_SIZE
  )
    throw new Error("Invalid transcript cursor or page size");
  return { runId, afterSequence, limit };
}

/** Readers deduplicate positive sequences, so count === last sequence establishes contiguity. */
export function transcriptRecordingStatus(
  recordCount: number,
  last: AgentTranscriptRecord
): AgentTranscriptPage["status"] {
  if (recordCount !== last.sequence) return "partial";
  if ("limit" in last) return "limited";
  return "event" in last && last.event.kind === "end" ? "complete" : "partial";
}
