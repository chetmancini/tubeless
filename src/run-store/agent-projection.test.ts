import { expect, it } from "vitest";
import type { PipelineTraceEvent } from "../tracing/tracing-contracts.js";
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

type ModelAttributes = Record<string, string | number | boolean>;
type TurnOverrides = Partial<Pick<PipelineTraceEvent, "stepId" | "parentRunId" | "iteration">>;

function turnEvent(
  id: number,
  attributes: ModelAttributes,
  overrides: TurnOverrides = {}
): StoredPipelineEvent {
  return {
    id,
    version: 3,
    name: "step.attempted",
    runId: "turn",
    pipelineId: "agent/turn",
    timestampMs: id,
    parentRunId: "agent",
    stepId: "decide",
    attemptId: "decide-attempt",
    iteration: { runId: "agent", stepId: "agent", attemptId: "agent-attempt", index: 1 },
    payload: { attempt: 1, attributes: { "agent.turn": 1, ...attributes } },
    ...overrides,
  };
}

function modelRequest(
  id: number,
  attributes: ModelAttributes = {},
  overrides: Partial<StoredPipelineEvent> = {}
): StoredPipelineEvent {
  return turnEvent(
    id,
    {
      "agent.model.provider": "openai",
      "agent.model.name": "fixture-model",
      "agent.model.operation": "decision",
      "agent.model.request": 1,
      "agent.model.responseReceived": true,
      ...attributes,
    },
    overrides
  );
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

it("sums model usage per provider and model in first-seen order", () => {
  const projection = new AgentProjection();
  projection.append(
    modelRequest(0, {
      "agent.model.request": 1,
      "agent.model.inputTokens": 1000,
      "agent.model.cacheReadTokens": 400,
      "agent.model.cacheWriteTokens": 900,
      "agent.model.outputTokens": 100,
      "agent.model.reasoningTokens": 40,
      "agent.model.durationMs": 120.5,
    })
  );
  projection.append(
    modelRequest(1, {
      "agent.model.request": 2,
      "agent.model.inputTokens": 2000,
      "agent.model.outputTokens": 200,
      "agent.model.reasoningTokens": 60,
      "agent.model.durationMs": 80,
    })
  );
  projection.append(
    modelRequest(2, {
      "agent.model.provider": "anthropic",
      "agent.model.name": "claude-fixture",
      "agent.model.inputTokens": 3000,
      "agent.model.uncachedInputTokens": 500,
      "agent.model.cacheReadTokens": 2500,
      "agent.model.cacheWrite5mTokens": 700,
      "agent.model.outputTokens": 300,
      "agent.model.durationMs": 200,
    })
  );
  const usage = projection.snapshot().agentTurn!.usage!;
  expect(usage).toEqual([
    {
      provider: "openai",
      model: "fixture-model",
      requests: 2,
      requestsWithoutUsage: 0,
      durationMs: 200.5,
      inputTokens: 3000,
      cacheReadTokens: 400,
      cacheWriteTokens: 900,
      outputTokens: 300,
      reasoningTokens: 100,
    },
    {
      provider: "anthropic",
      model: "claude-fixture",
      requests: 1,
      requestsWithoutUsage: 0,
      durationMs: 200,
      inputTokens: 3000,
      uncachedInputTokens: 500,
      cacheReadTokens: 2500,
      cacheWrite5mTokens: 700,
      outputTokens: 300,
    },
  ]);
  expect(usage[1]).not.toHaveProperty("reasoningTokens");
});

it("counts a request that reported no usable usage without inventing counters", () => {
  const projection = new AgentProjection();
  projection.append(
    modelRequest(0, {
      "agent.model.inputTokens": 100,
      "agent.model.outputTokens": 10,
      "agent.model.durationMs": 50,
    })
  );
  projection.append(
    modelRequest(1, {
      "agent.model.responseReceived": false,
      "agent.model.durationMs": 30,
    })
  );
  expect(projection.snapshot().agentTurn!.usage).toEqual([
    {
      provider: "openai",
      model: "fixture-model",
      requests: 2,
      requestsWithoutUsage: 1,
      durationMs: 80,
      inputTokens: 100,
      outputTokens: 10,
    },
  ]);
});

it("retains a turn whose only recorded request failed before any decision", () => {
  const projection = new AgentProjection();
  projection.append(
    modelRequest(
      0,
      { "agent.turn": 3, "agent.model.responseReceived": false },
      { iteration: { runId: "agent", stepId: "agent", attemptId: "agent-attempt", index: 3 } }
    )
  );
  const modelOnly = projection.snapshot().agentTurn!;
  expect(modelOnly).toMatchObject({ agentRunId: "agent", index: 3 });
  expect(modelOnly.decision).toBeUndefined();
  expect(modelOnly.usage).toHaveLength(1);
  projection.append(
    turnEvent(
      1,
      {
        "agent.runId": "agent",
        "agent.turn": 3,
        "agent.decision": "continue",
        "agent.callCount": 2,
      },
      { iteration: { runId: "agent", stepId: "agent", attemptId: "agent-attempt", index: 3 } }
    )
  );
  const complete = projection.snapshot().agentTurn!;
  expect(complete).toMatchObject({ agentRunId: "agent", index: 3, decision: "continue" });
  expect(complete.usage).toHaveLength(1);
});

it("ignores model telemetry that is not attributable to a turn", () => {
  const cases: Array<[string, Partial<StoredPipelineEvent>, ModelAttributes]> = [
    ["another step", { stepId: "calls" }, {}],
    ["a different parent run", { parentRunId: "elsewhere" }, {}],
    ["a turn that disagrees with the iteration", {}, { "agent.turn": 2 }],
    ["a blank provider", {}, { "agent.model.provider": "   " }],
    ["a zero request index", {}, { "agent.model.request": 0 }],
    ["no iteration", { iteration: undefined }, {}],
  ];
  for (const [label, overrides, attributes] of cases) {
    const projection = new AgentProjection();
    projection.append(modelRequest(0, attributes, overrides));
    expect(projection.snapshot().agentTurn, label).toBeUndefined();
  }
});

it("bounds distinct models per turn and rejects invalid counters", () => {
  const bounded = new AgentProjection();
  for (let index = 0; index < 9; index++)
    bounded.append(
      modelRequest(index, {
        "agent.model.name": `model-${index}`,
        "agent.model.inputTokens": 1,
        "agent.model.outputTokens": 1,
      })
    );
  const usage = bounded.snapshot().agentTurn!.usage!;
  expect(usage.map((entry) => entry.model)).toEqual(
    Array.from({ length: 8 }, (_, index) => `model-${index}`)
  );

  const invalid = new AgentProjection();
  invalid.append(
    modelRequest(0, {
      "agent.model.inputTokens": -5,
      "agent.model.outputTokens": 10,
      "agent.model.reasoningTokens": 1.5,
      "agent.model.cacheReadTokens": "400",
      "agent.model.durationMs": "12",
    })
  );
  expect(invalid.snapshot().agentTurn!.usage).toEqual([
    {
      provider: "openai",
      model: "fixture-model",
      requests: 1,
      requestsWithoutUsage: 1,
      durationMs: 0,
      outputTokens: 10,
    },
  ]);

  const overflow = new AgentProjection();
  overflow.append(
    modelRequest(0, {
      "agent.model.inputTokens": Number.MAX_SAFE_INTEGER,
      "agent.model.outputTokens": 5,
    })
  );
  overflow.append(modelRequest(1, { "agent.model.inputTokens": 1, "agent.model.outputTokens": 5 }));
  expect(overflow.snapshot().agentTurn!.usage![0]).toMatchObject({
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 10,
  });
});

it("isolates usage snapshots from caller mutation", () => {
  const projection = new AgentProjection();
  projection.append(
    modelRequest(0, { "agent.model.inputTokens": 10, "agent.model.outputTokens": 5 })
  );
  const early = projection.snapshot();
  early.agentTurn!.usage![0]!.inputTokens = 999;
  early.agentTurn!.usage!.push({
    provider: "openai",
    model: "injected",
    requests: 1,
    requestsWithoutUsage: 0,
    durationMs: 0,
  });
  projection.append(
    modelRequest(1, { "agent.model.inputTokens": 10, "agent.model.outputTokens": 5 })
  );
  const current = projection.snapshot();
  expect(current.agentTurn!.usage).toHaveLength(1);
  expect(current.agentTurn!.usage![0]!.inputTokens).toBe(20);
});
