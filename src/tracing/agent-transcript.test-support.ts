import type { AgentTranscriptEvent, AgentTranscriptRecord } from "./agent-transcript.js";

export function transcriptRecord(
  sequence = 1,
  event: AgentTranscriptEvent = { kind: "assistant", text: "Visible text" },
  runId = "agent:one"
): AgentTranscriptRecord & { readonly event: AgentTranscriptEvent } {
  return {
    version: 1,
    agentId: "agent",
    runId,
    sequence,
    timestamp: sequence,
    turn: event.kind === "end" ? 0 : 1,
    dryRun: false,
    event,
  };
}
