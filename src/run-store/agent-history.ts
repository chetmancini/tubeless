import type { PipelineTraceError } from "../tracing/tracing-contracts.js";
import {
  AGENT_MODEL_COUNTERS,
  addModelCounter,
  type StoredAgentCallMetadata,
  type StoredAgentDefinition,
  type StoredAgentModelUsage,
  type StoredAgentTurnMetadata,
} from "./agent-projection.js";
import type { StoredPipelineRun, StoredPipelineRunStatus } from "./run-store.js";

export interface AgentCallHistory {
  callId: string;
  tool?: string;
  parentAttemptId?: string;
  runId?: string;
  pipelineId?: string;
  status: StoredPipelineRunStatus | "unknown";
  durationMs?: number;
  error?: PipelineTraceError;
  childAgentRunIds: string[];
}

export interface AgentTurnHistory {
  runId: string;
  index: number;
  attemptId: string;
  status: StoredPipelineRunStatus;
  decision?: StoredAgentTurnMetadata["decision"];
  stateVersion?: number;
  nextStateVersion?: number;
  callCount?: number;
  callsAdmitted?: number;
  error?: PipelineTraceError;
  calls: AgentCallHistory[];
  usage?: StoredAgentModelUsage[];
}

export interface AgentRunHistory {
  runId: string;
  pipelineId: string;
  status: StoredPipelineRunStatus;
  termination: "running" | "finish" | "completed" | "limit" | "cancelled" | "failed" | "skipped";
  definition?: StoredAgentDefinition;
  error?: PipelineTraceError;
  parentCall?: { agentRunId: string; turnRunId: string; callId: string; runId: string };
  /** This agent's own turns only; never its child agents. */
  usage?: StoredAgentModelUsage[];
  /** Own turns plus every descendant agent, summed per provider and model. */
  subtreeUsage?: StoredAgentModelUsage[];
  turns: AgentTurnHistory[];
}

/** Flat agent nodes with explicit call links avoid duplicating nested execution trees. */
export interface AgentHistory {
  agents: AgentRunHistory[];
  /** Every agent's own usage, merged once; subtree sums would double count here. */
  usage?: StoredAgentModelUsage[];
}

function limited(error: PipelineTraceError | undefined): boolean {
  let cause: PipelineTraceError | PipelineTraceError["cause"] = error;
  for (let depth = 0; cause && depth <= 16; depth++) {
    if (cause.sourceCode === "TUBELESS_AGENT_LIMIT_REACHED") return true;
    cause = cause.cause;
  }
  return false;
}

/**
 * Sum counters per provider and model in first-seen order. Absent counters were never
 * reported, so they stay absent, and sums never cross models.
 */
function mergeUsage(
  lists: readonly (readonly StoredAgentModelUsage[] | undefined)[]
): StoredAgentModelUsage[] | undefined {
  const merged = new Map<string, StoredAgentModelUsage>();
  for (const list of lists) {
    for (const entry of list ?? []) {
      const key = JSON.stringify([entry.provider, entry.model]);
      let target = merged.get(key);
      if (!target) {
        target = {
          provider: entry.provider,
          model: entry.model,
          requests: 0,
          requestsWithoutUsage: 0,
          durationMs: 0,
        };
        merged.set(key, target);
      }
      target.requests += entry.requests;
      target.requestsWithoutUsage += entry.requestsWithoutUsage;
      target.durationMs += entry.durationMs;
      for (const name of AGENT_MODEL_COUNTERS) addModelCounter(target, name, entry[name]);
    }
  }
  return merged.size ? [...merged.values()] : undefined;
}

/** Join recorded run identities; missing observations stay unknown, never inferred as success. */
export function projectAgentHistory(runs: readonly StoredPipelineRun[]): AgentHistory {
  const byId = new Map(runs.map((run) => [run.runId, run]));
  const children = new Map<string, StoredPipelineRun[]>();
  const agentIds = new Set(runs.filter((run) => run.agent).map((run) => run.runId));
  for (const run of runs) {
    if (run.parentRunId) {
      const siblings = children.get(run.parentRunId) ?? [];
      siblings.push(run);
      children.set(run.parentRunId, siblings);
    }
    if (run.agentTurn && byId.has(run.agentTurn.agentRunId)) agentIds.add(run.agentTurn.agentRunId);
  }
  const callsByRun = new Map<
    string,
    { call: AgentCallHistory; parent: NonNullable<AgentRunHistory["parentCall"]> }
  >();
  const agents = [...agentIds].map((id): AgentRunHistory => {
    const run = byId.get(id)!;
    const turns = (children.get(id) ?? [])
      .filter(
        (turn) =>
          turn.iteration?.runId === id &&
          (run.agent
            ? turn.iteration.stepId === run.agent.stepId
            : turn.agentTurn?.agentRunId === id)
      )
      .sort((a, b) => a.iteration!.index - b.iteration!.index || a.startedAtMs - b.startedAtMs)
      .map((turn): AgentTurnHistory => {
        const metadata = turn.agentTurn;
        const recorded = new Map<
          string,
          { attribution: StoredAgentCallMetadata; calls: AgentCallHistory[] }
        >();
        for (const attribution of metadata?.calls ?? []) {
          if (!recorded.has(attribution.callId))
            recorded.set(attribution.callId, { attribution, calls: [] });
        }
        // Keep unattributed children first, then calls in recorded dispatch order.
        const calls: AgentCallHistory[] = [];
        for (const child of children.get(turn.runId) ?? []) {
          if (child.itemKey === undefined) continue;
          const entry = recorded.get(child.itemKey);
          const attribution = entry?.attribution ?? child.agentCall;
          const matches =
            attribution?.agentRunId === id &&
            attribution.turn === turn.iteration!.index &&
            attribution.callId === child.itemKey;
          const call: AgentCallHistory = {
            callId: child.itemKey,
            tool: matches ? attribution.tool : undefined,
            parentAttemptId: matches ? attribution.parentAttemptId : undefined,
            runId: child.runId,
            pipelineId: child.pipelineId,
            status: child.status,
            durationMs: child.durationMs,
            error: child.error,
            childAgentRunIds: [],
          };
          callsByRun.set(child.runId, {
            call,
            parent: {
              agentRunId: id,
              turnRunId: turn.runId,
              callId: call.callId,
              runId: child.runId,
            },
          });
          (entry?.calls ?? calls).push(call);
        }
        for (const { attribution: call, calls: observed } of recorded.values()) {
          if (observed.length) {
            for (const entry of observed) calls.push(entry);
          } else {
            calls.push({
              callId: call.callId,
              tool: call.tool,
              parentAttemptId: call.parentAttemptId,
              status: "unknown",
              childAgentRunIds: [],
            });
          }
        }
        const historyTurn: AgentTurnHistory = {
          runId: turn.runId,
          index: turn.iteration!.index,
          attemptId: turn.iteration!.attemptId,
          status: turn.status,
          decision: metadata?.decision,
          stateVersion: metadata?.stateVersion,
          nextStateVersion: metadata?.nextStateVersion,
          callCount: metadata?.callCount,
          callsAdmitted: metadata?.callsAdmitted,
          error: turn.error,
          calls,
        };
        if (metadata?.usage) historyTurn.usage = metadata.usage;
        return historyTurn;
      });
    let termination: AgentRunHistory["termination"] = run.status;
    if (
      run.status === "completed" &&
      turns.some((turn) => turn.decision === "finish" && turn.status === "completed")
    )
      termination = "finish";
    if (run.status === "failed") {
      if (limited(run.error) || turns.some((turn) => limited(turn.error))) termination = "limit";
      else if (
        run.agent &&
        run.steps.find((step) => step.id === run.agent!.stepId)?.status === "skipped"
      )
        termination = "skipped";
    }
    const history: AgentRunHistory = {
      runId: id,
      pipelineId: run.pipelineId,
      status: run.status,
      termination,
      definition: run.agent,
      error: run.error,
      turns,
    };
    const ownUsage = mergeUsage(turns.map((turn) => turn.usage));
    if (ownUsage) history.usage = ownUsage;
    return history;
  });
  for (const agent of agents) {
    let ancestor = byId.get(agent.runId);
    const visited = new Set<string>();
    while (ancestor && !visited.has(ancestor.runId)) {
      visited.add(ancestor.runId);
      const call = callsByRun.get(ancestor.runId);
      if (call && call.parent.agentRunId !== agent.runId) {
        agent.parentCall = call.parent;
        call.call.childAgentRunIds.push(agent.runId);
        break;
      }
      ancestor = ancestor.parentRunId ? byId.get(ancestor.parentRunId) : undefined;
    }
  }
  // Links from damaged recordings can be cyclic, so walk each subtree once per agent.
  const byAgentRunId = new Map(agents.map((agent) => [agent.runId, agent]));
  for (const agent of agents) {
    const lists: (readonly StoredAgentModelUsage[] | undefined)[] = [];
    const walked = new Set<string>();
    const pending = [agent];
    while (pending.length) {
      const node = pending.pop()!;
      if (walked.has(node.runId)) continue;
      walked.add(node.runId);
      lists.push(node.usage);
      for (const turn of node.turns)
        for (const call of turn.calls)
          for (const childId of call.childAgentRunIds) {
            const child = byAgentRunId.get(childId);
            if (child) pending.push(child);
          }
    }
    const subtree = mergeUsage(lists);
    if (subtree) agent.subtreeUsage = subtree;
  }
  const totalUsage = mergeUsage(agents.map((agent) => agent.usage));
  return totalUsage ? { agents, usage: totalUsage } : { agents };
}
