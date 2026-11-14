import type {
  AgentTranscriptPage,
  AgentTranscriptReader,
  AgentTranscriptRecord,
} from "../../tracing/agent-transcript.js";
import { terminalSafeText } from "../workbench-shared.js";

export async function readAgentTranscript(
  reader: AgentTranscriptReader,
  runId: string
): Promise<AgentTranscriptPage> {
  const records: AgentTranscriptRecord[] = [];
  let afterSequence = 0;
  for (;;) {
    const page = await reader.list({ runId, afterSequence, limit: 50 });
    records.push(...page.records);
    if (page.nextSequence === undefined) return { runId, records, status: page.status };
    if (page.nextSequence <= afterSequence) throw new Error("Transcript cursor did not advance");
    afterSequence = page.nextSequence;
  }
}

export function formatAgentTranscript(page: AgentTranscriptPage): string {
  const lines = ["Transcript", `Recording: ${page.status}`];
  if (page.status === "unavailable")
    lines.push(
      "No records are available. Capture may be disabled or all events may have been suppressed."
    );
  if (page.status === "partial")
    lines.push(
      "This recording has gaps or no terminal marker; agent status comes from run history."
    );
  for (const record of page.records) {
    const prefix = record.turn ? `Turn ${record.turn}` : "Invocation";
    if ("omitted" in record) lines.push(`${prefix} · ${record.omitted} omitted (${record.reason})`);
    else if ("limit" in record) lines.push(`${prefix} · Capture stopped at its byte limit`);
    else {
      const { kind, ...content } = record.event;
      lines.push(
        `${prefix} · ${kind}${record.dryRun ? " (preview)" : ""}`,
        JSON.stringify(content, null, 2)
      );
    }
  }
  return lines.map((line) => terminalSafeText(line)).join("\n") + "\n";
}
