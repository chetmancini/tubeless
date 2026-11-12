import type { StoredAgentModelUsage } from "../../run-store/agent-projection.js";
import type { AgentHistory } from "../../run-store/agent-history.js";
import { terminalSafeText } from "../workbench-shared.js";

/**
 * `<label> <model> (<provider>)  requests 1  input 10 …`. Absent counters were never
 * reported, so they are never printed as zero; the cache share is reads over input.
 */
function usageLine(label: string, entry: StoredAgentModelUsage): string {
  const parts = [
    `${label} ${terminalSafeText(entry.model)} (${terminalSafeText(entry.provider)})`,
    `requests ${entry.requests}`,
  ];
  const input = entry.inputTokens;
  if (input !== undefined) parts.push(`input ${input}`);
  const cacheRead = entry.cacheReadTokens;
  if (cacheRead !== undefined) {
    const share =
      input !== undefined && input > 0 ? ` (${Math.round((cacheRead / input) * 100)}%)` : "";
    parts.push(`cache read ${cacheRead}${share}`);
  }
  if (entry.cacheWriteTokens !== undefined) parts.push(`cache write ${entry.cacheWriteTokens}`);
  if (entry.outputTokens !== undefined) parts.push(`output ${entry.outputTokens}`);
  if (entry.reasoningTokens !== undefined) parts.push(`reasoning ${entry.reasoningTokens}`);
  parts.push(`model time ${Math.round(entry.durationMs)}ms`);
  if (entry.requestsWithoutUsage > 0) parts.push(`${entry.requestsWithoutUsage} without usage`);
  return parts.join("  ");
}

export function formatAgentHistory(history: AgentHistory): string {
  if (!history.agents.length) return "";
  const lines = ["Agent history:"];
  const byId = new Map(history.agents.map((agent) => [agent.runId, agent]));
  type Row = string | { agent: AgentHistory["agents"][number]; depth: number };
  // Include disconnected/cyclic records too; identity guards prevent duplicate expansion.
  const pending: Row[] = [
    ...history.agents.filter((agent) => !agent.parentCall),
    ...history.agents.filter((agent) => agent.parentCall),
  ]
    .reverse()
    .map((agent) => ({ agent, depth: 1 }));
  const seen = new Set<string>();
  while (pending.length) {
    const row = pending.pop()!;
    if (typeof row === "string") {
      lines.push(row);
      continue;
    }
    const { agent, depth } = row;
    if (seen.has(agent.runId)) continue;
    seen.add(agent.runId);
    const indent = "  ".repeat(Math.min(depth, 16));
    lines.push(
      `${indent}Agent ${terminalSafeText(agent.pipelineId)}  ${agent.status}  termination ${agent.termination}  run ${terminalSafeText(agent.runId)}`
    );
    const rows: Row[] = [];
    for (const entry of agent.usage ?? []) rows.push(`${indent}  ${usageLine("Usage", entry)}`);
    for (const turn of agent.turns) {
      const state = turn.stateVersion === undefined ? "unknown" : String(turn.stateVersion);
      const next = turn.nextStateVersion === undefined ? "" : ` -> ${turn.nextStateVersion}`;
      const count = turn.callCount === undefined ? "unknown" : String(turn.callCount);
      const admitted = turn.callsAdmitted === undefined ? "" : `  admitted ${turn.callsAdmitted}`;
      rows.push(
        `${indent}  Turn ${turn.index}  ${turn.status}  decision ${turn.decision ?? "unknown"}  state ${state}${next}  calls ${turn.calls.length}/${count}${admitted}  run ${terminalSafeText(turn.runId)}`
      );
      for (const call of turn.calls) {
        rows.push(
          `${indent}    Call ${terminalSafeText(call.callId)}  tool ${terminalSafeText(call.tool ?? "unknown")}  ${call.status}  run ${terminalSafeText(call.runId ?? "not recorded")}`
        );
        if (call.error)
          rows.push(
            `${indent}      ${terminalSafeText(call.error.sourceCode ?? call.error.code)}: ${terminalSafeText(call.error.message)}`
          );
        for (const id of call.childAgentRunIds) {
          const child = byId.get(id);
          if (child) rows.push({ agent: child, depth: depth + 3 });
        }
      }
      if (turn.error)
        rows.push(
          `${indent}    Error ${terminalSafeText(turn.error.sourceCode ?? turn.error.code)}: ${terminalSafeText(turn.error.message)}`
        );
    }
    pending.push(...rows.reverse());
  }
  for (const entry of history.usage ?? []) lines.push(usageLine("Usage total", entry));
  return `${lines.join("\n")}\n`;
}
