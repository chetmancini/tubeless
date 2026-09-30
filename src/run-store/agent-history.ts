import type { PipelineTraceError } from "../tracing/tracing-contracts.js";
import type { StoredAgentDefinition, StoredAgentTurnMetadata } from "./agent-projection.js";
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
}

export interface AgentRunHistory {
  runId: string;
  pipelineId: string;
  status: StoredPipelineRunStatus;
  termination: "running" | "finish" | "completed" | "limit" | "cancelled" | "failed" | "skipped";
  definition?: StoredAgentDefinition;
  error?: PipelineTraceError;
  parentCall?: { agentRunId: string; turnRunId: string; callId: string; runId: string };
  turns: AgentTurnHistory[];
}

/** Flat agent nodes with explicit call links avoid duplicating nested execution trees. */
export interface AgentHistory {
  agents: AgentRunHistory[];
}

function limited(error: PipelineTraceError | undefined): boolean {
  let cause: PipelineTraceError | PipelineTraceError["cause"] = error;
  for (let depth = 0; cause && depth <= 16; depth++) {
    if (cause.sourceCode === "TUBELESS_AGENT_LIMIT_REACHED") return true;
    cause = cause.cause;
  }
  return false;
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
        const recorded = metadata?.calls ?? [];
        const callRuns = (children.get(turn.runId) ?? []).filter(
          (child) => child.itemKey !== undefined
        );
        const calls = callRuns.map((child): AgentCallHistory => {
          const attribution =
            recorded.find((call) => call.callId === child.itemKey) ?? child.agentCall;
          const matches =
            attribution?.agentRunId === id &&
            attribution.turn === turn.iteration!.index &&
            attribution.callId === child.itemKey;
          const call: AgentCallHistory = {
            callId: child.itemKey!,
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
          return call;
        });
        for (const call of recorded) {
          if (!callRuns.some((child) => child.itemKey === call.callId))
            calls.push({
              callId: call.callId,
              tool: call.tool,
              parentAttemptId: call.parentAttemptId,
              status: "unknown",
              childAgentRunIds: [],
            });
        }
        if (recorded.length)
          calls.sort(
            (a, b) =>
              recorded.findIndex((call) => call.callId === a.callId) -
              recorded.findIndex((call) => call.callId === b.callId)
          );
        return {
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
    return {
      runId: id,
      pipelineId: run.pipelineId,
      status: run.status,
      termination,
      definition: run.agent,
      error: run.error,
      turns,
    };
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
  return { agents };
}
