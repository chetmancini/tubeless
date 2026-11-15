import {
  decodeAgentTranscriptRecord,
  type AgentTranscriptRecord,
} from "../tracing/agent-transcript.js";

/** A bounded in-memory transcript sink for one evaluation or a small group of runs. */
export interface AgentTranscriptCollector {
  /** An immutable snapshot in delivery order, including all run identities. */
  readonly records: readonly AgentTranscriptRecord[];
  /** Supply the collector as an agent's transcript option. */
  write(record: AgentTranscriptRecord): void;
  /** Reject missing, omitted, limited, conflicting or unfinished evidence. Failed runs may still have complete recordings. */
  assertComplete(runId?: string): void;
}

/** Bounds on retained evaluation evidence. */
export interface AgentTranscriptCollectorOptions {
  /** UTF-8 JSON bytes including newlines across all runs. Defaults to 16 MiB; allowed range 1..16777216. */
  readonly maxBytes?: number;
}

/** Collect owned records without loading agent execution or a model provider. */
export function createAgentTranscriptCollector({
  maxBytes = 16_777_216,
}: AgentTranscriptCollectorOptions = {}): AgentTranscriptCollector {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_777_216)
    throw new RangeError("Transcript collector maxBytes must be an integer in 1..16777216");
  const records: AgentTranscriptRecord[] = [];
  const encoder = new TextEncoder();
  let used = 0;
  let failed = false;
  return {
    get records() {
      return Object.freeze([...records]);
    },
    write(record) {
      try {
        if (failed) throw new Error("Transcript collector is incomplete");
        const owned = decodeAgentTranscriptRecord(record);
        const size = encoder.encode(JSON.stringify(owned)).length + 1;
        if (used + size > maxBytes) throw new Error("Transcript collector byte limit exceeded");
        records.push(owned);
        used += size;
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    assertComplete(runId) {
      if (failed) throw new Error("Transcript collector is incomplete after a capture error");
      const selected =
        runId === undefined ? records : records.filter((record) => record.runId === runId);
      if (selected.length === 0) throw new Error("No transcript evidence is available");
      const runs = new Map<string, { last: AgentTranscriptRecord; ended: boolean }>();
      for (const record of selected) {
        const previous = runs.get(record.runId);
        if (
          !("event" in record) ||
          previous?.ended ||
          record.sequence !== (previous?.last.sequence ?? 0) + 1 ||
          (previous &&
            (previous.last.agentId !== record.agentId ||
              previous.last.parentRunId !== record.parentRunId ||
              previous.last.dryRun !== record.dryRun))
        )
          throw new Error("Transcript evidence is incomplete or conflicting");
        runs.set(record.runId, { last: record, ended: record.event.kind === "end" });
      }
      if ([...runs.values()].some((run) => !run.ended))
        throw new Error("Transcript evidence has no terminal marker");
    },
  };
}
