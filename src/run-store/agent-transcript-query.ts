import {
  MAX_TRANSCRIPT_PAGE_SIZE,
  TRANSCRIPT_PAGE_SIZE,
  type AgentTranscriptReader,
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
