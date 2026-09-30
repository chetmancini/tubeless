import { expect, it } from "vitest";
import { AgentProjection } from "./agent-projection.js";
import type { StoredPipelineEvent } from "./run-store.js";

function dispatch(id: number, callId: string, tool: string): StoredPipelineEvent {
  return {
    id,
    version: 3,
    name: "step.attempted",
    runId: "turn",
    pipelineId: "agent/turn",
    timestampMs: id,
    parentRunId: "agent",
    stepId: "calls",
    attemptId: "calls-attempt",
    iteration: { runId: "agent", stepId: "agent", attemptId: "agent-attempt", index: 1 },
    payload: {
      attempt: 1,
      attributes: {
        "agent.runId": "agent",
        "agent.turn": 1,
        "agent.callId": callId,
        "agent.tool": tool,
        "agent.parentAttemptId": "calls-attempt",
      },
    },
  };
}

it("materializes isolated snapshots while repeated reports retain dispatch order", () => {
  const projection = new AgentProjection();
  projection.append(dispatch(0, "a", "first"));
  const early = projection.snapshot();
  projection.append(dispatch(1, "b", "second"));
  projection.append(dispatch(2, "a", "updated"));
  const current = projection.snapshot();
  expect(current.agentTurn!.calls.map(({ callId, tool }) => [callId, tool])).toEqual([
    ["a", "updated"],
    ["b", "second"],
  ]);
  expect(early.agentTurn!.calls).toHaveLength(1);
  expect(early.agentTurn!.calls[0]!.tool).toBe("first");
  current.agentTurn!.calls[0]!.tool = "mutated";
  current.agentTurn!.calls.pop();
  expect(projection.snapshot().agentTurn!.calls.map(({ tool }) => tool)).toEqual([
    "updated",
    "second",
  ]);
});
